/*
 * Tujuan: Rekap promo akhir bulan dari FAKTUR NYATA Accurate (hasil webhook), disandingkan
 *         dengan aturan promo terbit.
 * Caller: halaman Rekap Promo (/rekap-promo).
 * Dependensi: db (sales_invoice.raw_data, promo_rule), lib/promo-recap, rbac.
 * Main Functions: GET (rekap satu periode), POST (impor aturan dari sheet Detail).
 * Side Effects: POST menulis `promo_rule`. GET read-only, tidak menyentuh Accurate.
 *
 * Sumber angka = `sales_invoice.raw_data`, yaitu jawaban `detail.do` Accurate sendiri yang
 * disimpan utuh oleh webhook. Aturan promo TIDAK PERNAH mengubah angka itu; aturan hanya
 * dipakai untuk menjelaskan siapa menanggung apa. Selisihnya justru temuan yang dicari.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db } from "@/lib/db";
import { discountNormalization, invoiceOutbox, promoOutlet, promoRule, salesInvoiceCache } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { invoiceLines, parseTariff, pemberianPertama, recap, TARIFF_SHEET, type PromoRule, type Putusan } from "@/lib/promo-recap";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BYTES = 20 * 1024 * 1024;
const text = (value: unknown) => String(value ?? "").trim();

/** Bulan berjalan bila pemanggil tidak menyebut periode. */
function defaultRange() {
    // Tanggal SETEMPAT; toISOString() memakai UTC dan menggeser tanggal 1 jadi tanggal 31
    // bulan sebelumnya untuk zona waktu Indonesia.
    const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const now = new Date();
    return {
        from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)),
        to: ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
    };
}

/**
 * Kolom yang BENAR-BENAR dibaca importir, ditulis sekali di sini lalu dipakai dua kali:
 * jadi berkas contoh, dan jadi rujukan saat membaca berkas sungguhan. Menyimpannya sebagai
 * berkas statis berarti suatu saat contohnya akan menjanjikan kolom yang tidak lagi dibaca.
 */
const DETAIL_HEADER = ["SURAT_PROGRAM", "PROMO_LABEL", "PROMO_GROUP_ID", "PROMO_GROUP", "KODE_BARANG",
    "NAMA_BARANG", "PERIODE", "PERIOD_START", "PERIOD_END", "PROMO_ACTIVE", "TIER_NO",
    "TRIGGER_QTY", "TRIGGER_UNIT", "BENEFIT_TYPE", "BENEFIT_VALUE", "BENEFIT_UNIT", "BENEFIT_BEBAN",
    "CATATAN"];

const TARIFF_HEADER = ["KODE_OUTLET", "PELANGGAN", "POSISI 1", "POSISI 2", "POSISI 3", "POSISI 4",
    "POSISI 5", "PAKAI", "PERIODE MULAI", "PERIODE SAMPAI", "CATATAN"];

export async function GET(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("summary.view") && !gate.perms?.has("order.view")) {
        return NextResponse.json({ ok: false, error: "Akses rekap promo tidak diizinkan" }, { status: 403 });
    }

    // Berkas contoh untuk kedua sheet yang dibaca importir. Sheet `Discount Reguler` itulah
    // tempat diskon MT/tarif reguler dimuat, dan kolom `PAKAI` di sana bukan basa-basi: tabel
    // tarif aslinya diekstrak dari FOTO, jadi baris yang posisinya belum dipastikan TIDAK dimuat.
    if (request.nextUrl.searchParams.get("template") === "1") {
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
            DETAIL_HEADER,
            ["BP2609007909", "MTI - HPC CONSUMER PROMO ON PO", "", "B&B ALL VARIANT", "K1041001025010",
                "KNF B&B HAIR BODY WASH RIKO 250ML X 24", "September 2026", "2026-09-01", "2026-09-30",
                "TRUE", 1, 1, "PCS", "DISC_PCT", "3", "%", "PRINCIPAL", "contoh"],
            ["BP2609007713", "PROMO BRAND RESIK V", "", "RESIK V KHASIAT MANJAKANI", "K1370000005010",
                "KNF RESIK V MANJAKANI 50ML X 72 BTL", "September 2026", "2026-09-01", "2026-09-30",
                "TRUE", 1, 30, "PCS", "BONUS_QTY", "1", "PCS", "PRINCIPAL", "beli 30 gratis 1"],
        ]), "Detail");
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
            TARIFF_HEADER,
            ["C-AL0063", "ALFAMART", 4, 2.25, "", "", "", "YA", "2026-08-15", "2026-12-31", "posisi terbukti dari ORDER_DETAIL"],
            ["C-IN0050", "INDOMARET", 3.96, 3, "", "", "", "", "", "", "PAKAI dikosongkan = belum dipastikan, tidak dimuat"],
        ]), TARIFF_SHEET);
        const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
        return new NextResponse(new Uint8Array(buffer), {
            headers: {
                "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "content-disposition": 'attachment; filename="template-aturan-promo.xlsx"',
            },
        });
    }
    const fallback = defaultRange();
    const from = (request.nextUrl.searchParams.get("from") || fallback.from).slice(0, 10);
    const to = (request.nextUrl.searchParams.get("to") || fallback.to).slice(0, 10);

    // `trans_date` disimpan apa adanya dari Accurate (dd/MM/yyyy), jadi penyaringan tanggal
    // dilakukan atas bentuk ISO-nya. Bukan pekerjaan berat: satu bulan faktur, bukan semua.
    const rows = await db.select({ id: salesInvoiceCache.id, raw: salesInvoiceCache.rawData })
        .from(salesInvoiceCache)
        .where(and(
            gte(sql`to_date(${salesInvoiceCache.transDate}, 'DD/MM/YYYY')`, sql`${from}::date`),
            lte(sql`to_date(${salesInvoiceCache.transDate}, 'DD/MM/YYYY')`, sql`${to}::date`),
        ));

    const ruleRows = await db.select().from(promoRule).where(eq(promoRule.active, true));
    const rules: PromoRule[] = ruleRows.map((row) => ({
        principal: row.principal, suratProgram: row.suratProgram, promoLabel: row.promoLabel,
        promoGroup: row.promoGroup, itemCode: row.itemCode, customerCode: row.customerCode,
        periodStart: row.periodStart, periodEnd: row.periodEnd,
        benefitType: row.benefitType, benefitValue: row.benefitValue, benefitUnit: row.benefitUnit,
        benefitBeban: row.benefitBeban,
        tierNo: row.tierNo, triggerQty: Number(row.triggerQty), triggerUnit: row.triggerUnit,
        outletList: row.outletList, outletListMode: row.outletListMode, firstPo: row.firstPo,
    }));

    // Daftar outlet peserta (mis. LOYALTY). Dibaca UTUH lalu disaring per tanggal baris di
    // dalam `recap` — keanggotaannya berganti tiap kuartal, jadi menyaringnya sekali dengan
    // tanggal akhir periode akan menilai awal bulan dengan keanggotaan yang salah.
    const members = await db.select({
        listName: promoOutlet.listName, customerCode: promoOutlet.customerCode,
        periodStart: promoOutlet.periodStart, periodEnd: promoOutlet.periodEnd, active: promoOutlet.active,
    }).from(promoOutlet);

    // Principal yang BISA disaring = yang punya aturan terbit. Menyaring ke principal tanpa
    // aturan hanya menghasilkan halaman yang seluruhnya tak bertuan, dan itu bukan temuan —
    // itu cuma tandanya aturannya belum dimuat.
    const principals = [...new Set(rules.map((rule) => rule.principal.trim()).filter(Boolean))].sort();
    const principal = (request.nextUrl.searchParams.get("principal") || "").trim();

    // Cabang faktur = principal pemiliknya, ruang nama yang sama dengan `promo_rule.principal`.
    // Tanpa saringan ini rekap mencampur SEMUA principal sementara aturan hanya ada untuk
    // sebagian — dan klaim principal lain pasti tampak "tanpa aturan terbit" selamanya.
    const semua = rows.flatMap((row) => invoiceLines(row.raw));
    const lines = principal
        ? semua.filter((line) => line.branchName.trim().toUpperCase() === principal.toUpperCase())
        : semua;
    const scopedRules = principal
        ? rules.filter((rule) => rule.principal.trim().toUpperCase() === principal.toUpperCase())
        : rules;
    // Keputusan menu Normalisasi Diskon atas potongan tak bertuan di faktur luar web. Dibaca di
    // sini juga, bukan hanya di menunya: kartu "Tak bertuan" harus berkurang begitu diputuskan.
    const putusan = await db.select().from(discountNormalization)
        .where(and(gte(discountNormalization.transDate, from), lte(discountNormalization.transDate, to)));
    const normalisasi = new Map<string, Putusan>(putusan.map((row) => [`${row.lineKey}|${row.positions}`,
        { bucket: row.bucket === "principal" ? "principal" : "distributor", amount: Number(row.amount), by: row.decidedBy }]));
    // PO PERTAMA dinilai atas RIWAYAT sejak awal periode aturan first-PO, bukan hanya rentang ini:
    // PO kedua bulan Oktober tidak boleh tampak "pertama" hanya karena rekapnya dibuka per Oktober.
    // Dibaca hanya faktur yang memuat kode barangnya — belasan faktur, bukan seluruh kuartal.
    const aturanPertama = scopedRules.filter((rule) => rule.firstPo && rule.itemCode);
    let pertama;
    if (aturanPertama.length) {
        const sejak = aturanPertama.map((rule) => rule.periodStart || from).sort()[0];
        const kode = [...new Set(aturanPertama.map((rule) => rule.itemCode))];
        const riwayat = await db.select({ raw: salesInvoiceCache.rawData }).from(salesInvoiceCache).where(and(
            gte(sql`to_date(${salesInvoiceCache.transDate}, 'DD/MM/YYYY')`, sql`${sejak}::date`),
            lte(sql`to_date(${salesInvoiceCache.transDate}, 'DD/MM/YYYY')`, sql`${to}::date`),
            or(...kode.map((code) => sql`${salesInvoiceCache.rawData}::text like ${`%${code}%`}`)),
        ));
        pertama = pemberianPertama(riwayat.flatMap((row) => invoiceLines(row.raw)), aturanPertama);
    }
    const result = recap(lines, scopedRules, members, normalisasi, pertama);
    // Faktur yang terbit LEWAT web sudah dinilai gerbang; menu normalisasi hanya untuk yang tidak.
    const webInvoiceIds = (await db.select({ id: invoiceOutbox.accurateId }).from(invoiceOutbox)
        .where(and(eq(invoiceOutbox.state, "posted"), ne(invoiceOutbox.accurateId, "")))).map((row) => row.id);

    // Faktur yang `raw_data`-nya belum memuat rincian baris: hanya jalur webhook (detail.do)
    // yang membawanya, faktur hasil sync daftar tidak. Wajib terlihat, bukan hilang diam-diam.
    // Dihitung dari hasil bongkar, bukan dari bentuk mentahnya: `raw_data` tersimpan sebagai
    // TEKS JSON (lihat catatan di lib/promo-recap), jadi memeriksa `raw.detailItem` langsung
    // selalu menjawab "tidak ada rincian" untuk semua faktur.
    const withDetail = new Set(semua.map((line) => line.invoiceId || line.invoiceNo));
    const withoutDetail = rows.length - withDetail.size;

    return NextResponse.json({
        ok: true, from, to, principal, principals,
        invoicesInRange: rows.length,
        invoicesWithoutDetail: withoutDetail,
        rules: rules.length,
        recap: result,
        webInvoiceIds,
    });
}

/** Impor aturan dari sheet `Detail` (skema kolom Validator Diskon). */
export async function POST(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("summary.edit")) {
        return NextResponse.json({ ok: false, error: "Hanya pengelola Summary yang boleh memuat aturan promo" }, { status: 403 });
    }
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "Pilih berkas Summary (xlsx) dulu" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ ok: false, error: "Berkas maksimal 20 MB" }, { status: 413 });
    const principal = text(form?.get("principal")) || "KINO NON FOOD";
    const apply = text(form?.get("apply")) === "true";

    const book = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array" });
    const sheet = book.Sheets["Detail"];
    const tariffSheet = book.Sheets[TARIFF_SHEET];
    if (!sheet && !tariffSheet) {
        return NextResponse.json({ ok: false, error: `Berkas ini tidak punya sheet \`Detail\` maupun \`${TARIFF_SHEET}\`` }, { status: 422 });
    }
    const raw = sheet ? XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" }) : [];

    const issues: string[] = [];
    // BARIS TANPA PERIODE LENGKAP TIDAK DIMUAT, bukan sekadar dilaporkan.
    //
    // Sampai 20 September 2026 baris seperti ini hanya menambah satu kalimat di `issues`
    // lalu tetap ikut transaksi, tersimpan dengan `period_start`/`period_end` NULL. Aturan
    // tanpa tanggal akhir membenarkan potongan SELAMANYA — satu salah ketik `PERIODE` di
    // Excel cukup untuk membuatnya, dan satu-satunya tandanya adalah catatan yang bisa saja
    // tidak dibaca siapa pun. Sekarang barisnya DITAHAN, sejalan dengan seluruh jalur lain:
    // yang tidak terbaca tidak ditebak dan tidak dimuat.
    const values = raw.flatMap((row, index) => {
        const periode = text(row.PERIODE);
        const start = text(row.PERIOD_START) || monthStart(periode);
        const end = text(row.PERIOD_END) || monthEnd(periode);
        if (!start || !end) {
            issues.push(`Baris ${index + 2}: periode "${periode}" tidak terbaca — baris TIDAK DIMUAT. `
                + "Isi PERIODE (mis. \"September 2026\") atau PERIOD_START dan PERIOD_END.");
            return [];
        }
        return [{
            principal,
            suratProgram: text(row.SURAT_PROGRAM), promoLabel: text(row.PROMO_LABEL),
            promoGroupId: text(row.PROMO_GROUP_ID), promoGroup: text(row.PROMO_GROUP),
            itemCode: text(row.KODE_BARANG), itemName: text(row.NAMA_BARANG),
            customerCode: "",
            periodStart: start, periodEnd: end,
            active: text(row.PROMO_ACTIVE).toLowerCase() !== "false",
            tierNo: Number(row.TIER_NO) || 1,
            triggerQty: String(Number(row.TRIGGER_QTY) || 0),
            triggerUnit: text(row.TRIGGER_UNIT) || "PCS",
            benefitType: text(row.BENEFIT_TYPE), benefitValue: text(row.BENEFIT_VALUE),
            benefitUnit: text(row.BENEFIT_UNIT), benefitBeban: text(row.BENEFIT_BEBAN) || "PRINCIPAL",
            note: text(row.CATATAN), importedBy: String(gate.session?.user?.email ?? ""),
            source: "excel", sourceRef: file.name.slice(0, 200),
        }];
    });
    const tariff = tariffSheet
        ? parseTariff(XLSX.utils.sheet_to_json<Record<string, unknown>>(tariffSheet, { defval: "" }),
            { principal, importedBy: String(gate.session?.user?.email ?? ""), issues })
        : [];
    if (values.length === 0 && tariff.length === 0) {
        return NextResponse.json({ ok: false, error: `Sheet \`Detail\` dan \`${TARIFF_SHEET}\` sama-sama tidak memberi satu aturan pun`, issues: issues.slice(0, 50) }, { status: 422 });
    }

    // Satu barang internal bisa punya DUA kode principal (pecahan berbeda di sistem Kino),
    // sehingga barisnya kembar. Aturan promo melekat pada barang internal, jadi yang kembar
    // digabung — dan jumlahnya DILAPORKAN lewat `merged`, bukan dibuang diam-diam.
    // Pemetaan kode principal -> kode internal tinggal di `principal_mapping`, bukan di sini.
    const unik = new Map<string, (typeof values)[number]>();
    let digabung = 0;
    for (const row of values) {
        const key = `${row.suratProgram}|${row.promoGroup}|${row.itemCode}|${row.customerCode}|${row.tierNo}`;
        if (!unik.has(key)) { unik.set(key, row); continue; }
        digabung += 1;
    }
    const baris = [...unik.values()];

    const summary = {
        rows: baris.length,
        merged: digabung,
        programs: new Set(baris.map((v) => `${v.suratProgram}|${v.promoGroup}`)).size,
        tingkatFaktur: baris.filter((v) => !v.itemCode).length,
        tarifOutlet: tariff.length,
        outlet: new Set(tariff.map((v) => v.customerCode)).size,
        issues: issues.slice(0, 50),
    };
    if (!apply) return NextResponse.json({ ok: true, applied: false, ...summary });

    try {
    await db.transaction(async (tx) => {
        // Muat ulang MENGGANTI aturan principal ini: program yang dicabut harus benar-benar
        // hilang, bukan menumpuk dari muatan sebelumnya lalu ikut menjelaskan diskon.
        //
        // Yang diganti hanya SLICE yang dibawa berkas ini. Aturan surat (`customer_code` kosong)
        // dan tarif outlet (`customer_code` terisi) datang dari dua sumber yang berbeda —
        // workbook Summary dan tabel Discount Reguler — dan tidak selalu dikirim bersamaan.
        // Menghapus keduanya tiap unggahan berarti memuat yang satu diam-diam mencabut yang
        // lain, lalu gerbang menahan faktur yang sebenarnya sah.
        if (baris.length > 0) {
            // Daftar outlet peserta yang sudah ditunjuk aturan lama DISELAMATKAN lebih dulu.
            // Berkas Summary tidak membawa kolom itu (daftarnya datang dari lampiran surat atau
            // dari berkas terpisah), jadi tanpa ini muat ulang akan melepas ikatannya diam-diam:
            // daftarnya tetap ada dan terlihat benar di layar, tetapi tidak lagi menahan apa pun.
            // Gerbang yang melonggar tanpa ada yang menyadarinya adalah cara kehilangan uang
            // yang paling sulit ditemukan.
            const ikatan = await tx.selectDistinct({
                suratProgram: promoRule.suratProgram,
                outletList: promoRule.outletList,
                outletListMode: promoRule.outletListMode,
            }).from(promoRule).where(and(
                eq(promoRule.principal, principal), eq(promoRule.customerCode, ""), ne(promoRule.outletList, ""),
            ));

            // HANYA irisan milik jalur Excel (dan baris lama yang belum bertanda). Aturan yang
            // datang dari publikasi Summary punya penulisnya sendiri dan tidak boleh ikut
            // terhapus di sini — yang hilang tidak akan terlihat sebagai galat, gerbang cuma
            // berhenti menahan.
            await tx.delete(promoRule).where(and(
                eq(promoRule.principal, principal), eq(promoRule.customerCode, ""),
                inArray(promoRule.source, ["", "excel"]),
            ));
            for (let start = 0; start < baris.length; start += 500) {
                await tx.insert(promoRule).values(baris.slice(start, start + 500));
            }

            for (const ikat of ikatan) {
                await tx.update(promoRule)
                    .set({ outletList: ikat.outletList, outletListMode: ikat.outletListMode })
                    .where(and(eq(promoRule.principal, principal), eq(promoRule.customerCode, ""),
                        eq(promoRule.suratProgram, ikat.suratProgram)));
            }
            if (ikatan.length) {
                issues.push(`Ikatan daftar outlet dipasang kembali untuk ${ikatan.length} surat: `
                    + ikatan.map((ikat) => `${ikat.suratProgram} -> ${ikat.outletListMode} ${ikat.outletList}`).join(", "));
            }
        }
        if (tariff.length > 0) {
            await tx.delete(promoRule).where(and(
                eq(promoRule.principal, principal), ne(promoRule.customerCode, ""),
                inArray(promoRule.source, ["", "tarif"]),
            ));
            for (let start = 0; start < tariff.length; start += 500) {
                await tx.insert(promoRule).values(tariff.slice(start, start + 500));
            }
        }
    });
    } catch (error) {
        // Satu baris bentrok menggagalkan SELURUH muatan — itu memang benar (semua atau tidak
        // sama sekali), tetapi penyebabnya harus terbaca, bukan jadi 500 tanpa keterangan.
        const pesan = error instanceof Error ? error.message : "gagal menulis aturan";
        return NextResponse.json({ ok: false, applied: false, ...summary, error: /duplicate|unique/i.test(pesan)
            ? `Ada baris kembar yang menabrak kunci unik, jadi tidak ada satu pun yang dimuat: ${pesan}`
            : pesan }, { status: 409 });
    }
    return NextResponse.json({ ok: true, applied: true, ...summary });
}

/** "SEPTEMBER 2026" -> 2026-09-01. Format lain dikembalikan kosong, bukan ditebak. */
function monthStart(periode: string): string {
    const parsed = parseMonth(periode);
    return parsed ? `${parsed.year}-${String(parsed.month).padStart(2, "0")}-01` : "";
}

function monthEnd(periode: string): string {
    const parsed = parseMonth(periode);
    if (!parsed) return "";
    const last = new Date(parsed.year, parsed.month, 0).getDate();
    return `${parsed.year}-${String(parsed.month).padStart(2, "0")}-${last}`;
}

const MONTHS = ["JANUARI", "FEBRUARI", "MARET", "APRIL", "MEI", "JUNI", "JULI", "AGUSTUS",
    "SEPTEMBER", "OKTOBER", "NOVEMBER", "DESEMBER"];

function parseMonth(periode: string): { year: number; month: number } | null {
    const match = /([A-Z]+)\s+(\d{4})/i.exec(String(periode ?? "").toUpperCase());
    if (!match) return null;
    const month = MONTHS.indexOf(match[1]) + 1;
    return month > 0 ? { year: Number(match[2]), month } : null;
}
