/*
 * Tujuan: Menyusun DAFTAR OUTLET peserta program — lihat isinya, tambah, ubah, hapus.
 * Caller: halaman Aturan Promo (/aturan-promo), panel "Daftar outlet peserta".
 * Dependensi: db (promo_outlet, principal_mapping, customer), rbac.
 * Main Functions: GET, POST, PATCH, DELETE.
 * Side Effects: menulis `promo_outlet` — tabel yang dibaca gerbang validasi dan Rekap Promo.
 *
 * Kenapa daftar ini ada: surat program menyebut PESERTA, bukan hanya barang. BP2609007713 dan
 * BP2609007664 berlaku "KHUSUS CHANNEL GT PESERTA LOYALTY"; BP2609006016 justru "EXCLUDE
 * LOYALTY". Selama daftarnya cuma hidup di Excel seorang admin, bonus Resik V sama sahnya di
 * outlet mana pun — dan tidak ada yang bisa menjawab "toko mana saja yang ikut?" tanpa
 * meminta berkasnya.
 *
 * Kenapa menerima DUA bentuk kode: yang memegang daftar loyalty adalah tim sales, dan yang
 * mereka punya adalah CUST_ID2 milik Kino (`2191200123589`) atau nama tokonya — bukan kode
 * internal Accurate. Kode principal diterjemahkan lewat `principal_mapping`, tabel yang sama
 * dengan yang dipakai jalur order; menebaknya dari nama tidak pernah dilakukan di sini.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db } from "@/lib/db";
import { customer, principalMapping, principalOrderBatch, promoLetterOcr, promoOutlet, promoRule } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { fromOcrRows, letterHead, readLetterOutlets, type LetterAttachment } from "@/lib/promo-letter";
import { ocrLetterOutlets, ocrStatus, OCR_MODEL, OCR_VERSION, type OcrLetterResult } from "@/lib/promo-letter-ocr";
import { createHash } from "node:crypto";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 20 * 1024 * 1024;

/** Kolom berkas manual. Sengaja sedikit: yang wajib hanya kodenya. */
const TEMPLATE_HEADER = ["KODE_OUTLET", "NAMA (diabaikan)", "TINGKAT", "MULAI", "SAMPAI", "CATATAN"];

const text = (value: unknown) => String(value ?? "").trim();

async function gateOf(perlu: "summary.view" | "summary.edit") {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return { response: gate.response };
    if (!gate.perms?.has(perlu)) {
        return { response: NextResponse.json({ ok: false, error: "Akses daftar outlet tidak diizinkan" }, { status: 403 }) };
    }
    return { email: String(gate.session?.user?.email ?? "") };
}

/** Akhiran cabang Accurate milik principal ini; satu outlet punya satu customerNo per cabang. */
const BRANCH_SUFFIX: Record<string, string> = { "KINO NON FOOD": "-KN" };

/**
 * Satu kode yang diketik orang -> kode internal Accurate, atau alasan kenapa tidak bisa.
 *
 * Tiga bentuk yang diterima, dan ketiganya DIBUKTIKAN ke master, bukan diterima apa adanya:
 *   `C-WIN013`     kode internal — dicek ada di master pelanggan
 *   `C-WIN013-KN`  kode bercabang — akhirannya dibuang lalu dicek
 *   `22160031402`  CUST_ID2 principal — diterjemahkan lewat `principal_mapping`
 *
 * Kode yang tidak terbukti DITOLAK dengan sebabnya, tidak dimuat dengan harapan. Daftar
 * peserta yang memuat kode hantu lebih berbahaya daripada daftar yang kurang satu baris:
 * yang kurang akan terlihat sebagai baris tertahan, yang hantu tidak terlihat sama sekali.
 */
function resolverOf(
    mapping: Map<string, string>,
    internal: Map<string, string>,
): (raw: string) => { code: string; name: string; source: string } | { error: string } {
    return (raw: string) => {
        const kode = raw.trim().toUpperCase();
        if (!kode) return { error: "kosong" };
        // Kode principal (angka semua) -> kode internal lewat mapping.
        const lewatMapping = mapping.get(kode);
        if (lewatMapping) {
            const nama = internal.get(lewatMapping);
            return nama === undefined
                ? { error: `${kode} dipetakan ke ${lewatMapping}, tetapi ${lewatMapping} tidak ada di master pelanggan` }
                : { code: lewatMapping, name: nama, source: kode };
        }
        // Kode internal, dengan atau tanpa akhiran cabang.
        for (const calon of [kode, kode.replace(/-[A-Z0-9]+$/, "")]) {
            const nama = internal.get(calon);
            if (nama !== undefined) return { code: calon, name: nama, source: "" };
        }
        return { error: `${kode} bukan kode internal yang ada di master pelanggan, dan bukan kode principal yang sudah dipetakan` };
    };
}

async function lookups(principal: string) {
    const suffix = BRANCH_SUFFIX[principal] ?? "";
    const [maps, pelanggan] = await Promise.all([
        db.select({ source: principalMapping.sourceCode, target: principalMapping.targetCode })
            .from(principalMapping).where(eq(principalMapping.kind, "customer")),
        db.select({ no: customer.customerNo, name: customer.name }).from(customer),
    ]);
    const mapping = new Map(maps.map((row) => [row.source.trim().toUpperCase(), row.target.trim().toUpperCase()]));
    // Master pelanggan berisi kode BERCABANG (`C-WIN013-KN`); daftar peserta menyimpan kode
    // internalnya (`C-WIN013`). Akhiran cabangnya dibuang supaya keduanya bicara dalam kode
    // yang sama.
    //
    // Akhirannya TIDAK selalu milik principal yang sedang dimuat. Outlet yang sama bisa hanya
    // punya cabang lain — `C-BRI002` di produksi cuma ada sebagai `C-BRI002-M2`, dan surat URC
    // yang menyebutnya akan tertolak kalau kita hanya mengenali `-KN`. Karena itu segmen
    // terakhir dibuang kapan pun kodenya berbentuk `C-XXXnnn-CABANG` (tiga bagian), sementara
    // akhiran principal tetap didahulukan supaya cabangnya sendiri yang jadi nama.
    const internal = new Map<string, string>();
    const potong = (no: string) => {
        if (suffix && no.endsWith(suffix)) return no.slice(0, -suffix.length);
        return no.split("-").length >= 3 ? no.slice(0, no.lastIndexOf("-")) : no;
    };
    for (const row of pelanggan) {
        const no = row.no.trim().toUpperCase();
        const base = potong(no);
        // Kode dengan akhiran principal menang: ia yang dipakai jalur order, jadi namanya juga
        // yang paling sering dilihat manusia.
        if (!internal.has(base) || (suffix && no.endsWith(suffix))) internal.set(base, row.name);
    }
    return { mapping, internal };
}

export async function GET(request: NextRequest) {
    const gate = await gateOf("summary.view");
    if (gate.response) return gate.response;

    // Berkas contoh untuk daftar yang datang TERPISAH dari suratnya (mis. loyalty kuartalan).
    // Dibuat di sini, bukan disimpan sebagai berkas statis, supaya kolomnya tidak bisa
    // berbeda dari yang benar-benar dibaca importirnya.
    if (request.nextUrl.searchParams.get("template") === "1") {
        const sheet = XLSX.utils.aoa_to_sheet([
            TEMPLATE_HEADER,
            ["C-WIN013", "CV WINAR'S", "PLATINUM", "2026-10-01", "2026-12-31", "kuartal 4"],
            ["22160031402", "boleh kode Kino juga", "GOLD", "2026-10-01", "2026-12-31", ""],
        ]);
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, sheet, "Daftar Outlet");
        const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
        return new NextResponse(new Uint8Array(buffer), {
            headers: {
                "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "content-disposition": 'attachment; filename="template-daftar-outlet.xlsx"',
            },
        });
    }

    const list = text(request.nextUrl.searchParams.get("list")).toUpperCase();
    const cari = text(request.nextUrl.searchParams.get("q")).toUpperCase();

    const rows = await db.select().from(promoOutlet)
        .orderBy(asc(promoOutlet.listName), asc(promoOutlet.customerCode));

    const disaring = rows.filter((row) => {
        if (list && row.listName.toUpperCase() !== list) return false;
        if (!cari) return true;
        return [row.customerCode, row.customerName, row.tier, row.sourceCode, row.note]
            .some((field) => String(field).toUpperCase().includes(cari));
    });

    // Ringkasan per daftar supaya "berapa toko yang ikut" terjawab tanpa menghitung sendiri.
    const lists = new Map<string, { name: string; members: number; tiers: Record<string, number> }>();
    for (const row of rows) {
        const entry = lists.get(row.listName) ?? { name: row.listName, members: 0, tiers: {} };
        entry.members += 1;
        const tier = row.tier || "(tanpa tingkat)";
        entry.tiers[tier] = (entry.tiers[tier] ?? 0) + 1;
        lists.set(row.listName, entry);
    }

    // Kode distributor kita, DITURUNKAN dari batch laporan principal terakhir ("1201671 -
    // SURYA PERKASA, CV - MAKASSAR") dan bukan ditulis mati di layar. Lampiran surat memuat
    // outlet seluruh distributor nasional, jadi kode inilah yang menentukan mana milik kita.
    const [batch] = await db.select({ branch: principalOrderBatch.branch })
        .from(principalOrderBatch).orderBy(desc(principalOrderBatch.uploadedAt)).limit(1);
    const distCode = /^\s*(\d{7})/.exec(String(batch?.branch ?? ""))?.[1] ?? "";

    return NextResponse.json({
        ok: true,
        lists: [...lists.values()].sort((a, b) => a.name.localeCompare(b.name)),
        total: rows.length,
        distCode,
        members: disaring.slice(0, 1000),
        truncated: Math.max(disaring.length - 1000, 0),
    });
}

/**
 * Menyimpan anggota hasil penerjemahan kode. Satu pintu untuk ketiga jalurnya — ketik, berkas,
 * dan surat — supaya tidak ada jalur yang diam-diam memuat kode yang tidak terbukti.
 */
async function simpanAnggota(rows: (typeof promoOutlet.$inferInsert)[], email: string): Promise<number> {
    if (!rows.length) return 0;
    // `excluded.*` supaya TIAP baris memperbarui dirinya sendiri: menulis nilai satu baris ke
    // seluruh kembar akan menyeragamkan nama dan kode principal yang justru berbeda per outlet.
    const ditulis = await db.insert(promoOutlet).values(rows)
        .onConflictDoUpdate({
            target: [promoOutlet.listName, promoOutlet.customerCode],
            set: {
                customerName: sql`excluded.customer_name`, tier: sql`excluded.tier`,
                sourceCode: sql`excluded.source_code`,
                periodStart: sql`excluded.period_start`, periodEnd: sql`excluded.period_end`,
                active: sql`excluded.active`, note: sql`excluded.note`,
                importedBy: email, importedAt: new Date(),
            },
        })
        .returning({ id: promoOutlet.id });
    return ditulis.length;
}

/**
 * Unggah daftar peserta: SURAT PDF, atau berkas terpisah (xlsx/csv).
 *
 * Yang dari SURAT lebih dipercaya dan karena itu lebih disukai: daftarnya memang bagian dari
 * surat itu, jadi tidak ada langkah menyalin yang bisa meleset, dan nama daftarnya adalah nomor
 * suratnya sendiri. Berkas terpisah tetap ada karena sebagian daftar memang datang terpisah —
 * peserta loyalty kuartalan tidak tercetak di surat mana pun.
 */
async function unggah(request: NextRequest, email: string) {
    let form: FormData;
    try {
        form = await request.formData();
    } catch {
        return NextResponse.json({ ok: false, error: "Berkas tidak terbaca" }, { status: 400 });
    }
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "Pilih berkasnya dulu" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ ok: false, error: "Berkas lebih dari 20 MB" }, { status: 413 });

    const principal = principalOf(form);
    const { mapping, internal } = await lookups(principal);
    const resolve = resolverOf(mapping, internal);
    const raw = new Uint8Array(await file.arrayBuffer());
    const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";

    return isPdf ? dariSurat(raw, form, resolve, email) : dariBerkas(raw, form, resolve, email);
}

const principalOf = (form: FormData) => text(form.get("principal")) || "KINO NON FOOD";

/**
 * OCR sekali saja untuk satu isi berkas. Hasilnya disimpan berkunci HASH ISI — bukan nama
 * berkas — karena surat yang sama sering dikirim ulang dengan nama berbeda, dan karena pesan
 * galat kita sendiri menyuruh orang mencoba lagi dengan kode distributor yang dibetulkan.
 * Tanpa simpanan ini, percobaan kedua ditagih ulang untuk dokumen yang isinya persis sama.
 */
async function bacaDenganOcr(
    raw: Uint8Array, sourceHash: string, principal: string, email: string,
): Promise<OcrLetterResult> {
    const [tersimpan] = await db.select({ result: promoLetterOcr.result })
        .from(promoLetterOcr)
        .where(and(eq(promoLetterOcr.sourceHash, sourceHash), eq(promoLetterOcr.model, OCR_MODEL),
            eq(promoLetterOcr.pipelineVersion, OCR_VERSION)));
    if (tersimpan) return tersimpan.result as OcrLetterResult;

    // Katalog kode pelanggan principal ini: dipakai model untuk MENJANGKARKAN kode yang
    // terbaca, bukan untuk menebaknya. Sama alasannya dengan katalog barang pada jalur Summary.
    const katalog = await db.select({ code: principalMapping.sourceCode, target: principalMapping.targetCode })
        .from(principalMapping)
        .where(and(eq(principalMapping.principal, principal), eq(principalMapping.kind, "customer")));
    const hasil = await ocrLetterOutlets(raw, katalog.map((row) => ({ code: row.code, name: row.target })), principal);

    // Disimpan HANYA kalau utuh: hasil parsial sudah ditolak lebih dulu di dalam pembacanya.
    await db.insert(promoLetterOcr).values({
        sourceHash, model: hasil.model, pipelineVersion: hasil.pipelineVersion,
        result: hasil, pageCount: hasil.pageCount, createdBy: email,
    }).onConflictDoNothing();
    return hasil;
}

/** Surat PDF -> daftar peserta bernama nomor suratnya, lalu aturan surat itu ditunjuk ke sana. */
async function dariSurat(
    raw: Uint8Array, form: FormData, resolve: ReturnType<typeof resolverOf>, email: string,
) {
    const distCode = text(form.get("distCode"));
    const sourceHash = createHash("sha256").update(raw).digest("hex");

    // JALUR SATU — lapisan teks. Gratis, dan untuk surat yang dicetak dari sistem principal
    // (Kino) justru paling tepat: tidak ada yang perlu ditafsirkan. Membacanya dengan OCR
    // hanya menambah biaya dan risiko salah baca.
    let pages: string[] = [];
    try {
        const { extractText, getDocumentProxy } = await import("unpdf");
        // SALINAN, bukan `raw` itu sendiri: pdf.js MENGAMBIL ALIH buffer yang diberikan
        // kepadanya, dan sesudahnya `raw` menjadi kosong. Tanpa salinan ini jalur OCR di
        // bawah menerima berkas nol byte lalu melaporkan "PDF rusak" untuk surat yang
        // sebenarnya baik-baik saja — dan itu terjadi HANYA pada surat hasil scan, yaitu
        // satu-satunya jalur yang memang butuh OCR.
        const pdf = await getDocumentProxy(new Uint8Array(raw));
        const hasil = await extractText(pdf, { mergePages: false });
        pages = hasil.text as unknown as string[];
    } catch {
        // PDF tanpa lapisan teks yang bisa dibuka bukan alasan berhenti — justru itu kandidat
        // OCR. Yang benar-benar rusak akan gagal lagi di bawah, dengan sebabnya sendiri.
        pages = [];
    }

    let surat: LetterAttachment = readLetterOutlets(pages, distCode);
    let sumberTeks = "lapisan teks";
    let ocrPages = 0;
    const catatan: string[] = [];

    // JALUR DUA — Mistral OCR 4.1, sama dengan yang dipakai Summary Promo di produksi.
    // Dipakai hanya kalau jalur teks tidak menghasilkan apa-apa: surat hasil scan (delapan dari
    // tiga puluh surat September memang scan murni), atau surat principal lain yang tabelnya
    // tidak berbentuk seperti punya Kino. Biayanya per halaman, jadi ia TIDAK PERNAH dipanggil
    // ketika lapisan teksnya sudah menjawab.
    const perluOcr = surat.outlets.length === 0 && surat.distributors.length === 0;
    if (perluOcr) {
        const config = ocrStatus();
        if (!config.configured) {
            return NextResponse.json({
                ok: false,
                error: "Surat ini tidak punya lapisan teks (hasil scan) dan MISTRAL_API_KEY belum dikonfigurasi di server, jadi tidak ada yang bisa membacanya. Set kuncinya, atau unggah daftarnya sebagai berkas terpisah.",
            }, { status: 422 });
        }
        let hasil: OcrLetterResult;
        try {
            hasil = await bacaDenganOcr(raw, sourceHash, principalOf(form), email);
        } catch (error) {
            return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "OCR gagal" }, { status: 422 });
        }
        sumberTeks = `Mistral ${hasil.model}`;
        ocrPages = hasil.pageCount;
        surat = fromOcrRows(hasil.rows, letterHead(hasil.pages[0] ?? ""), distCode);
        catatan.push(...hasil.warnings.slice(0, 20));
    }

    // Nomor surat jadi nama daftarnya. Kalau kopnya tidak memuat nomor yang bisa dikenali —
    // dan itu wajar, tiap principal menulis kopnya sendiri — nama yang DIKETIK pengguna dipakai.
    // Menolak surat hanya karena kopnya tidak sesuai kebiasaan satu principal berarti menutup
    // pintu untuk dua belas principal lainnya.
    const listName = (surat.kodeAju || text(form.get("listName"))).toUpperCase();
    if (!listName) {
        return NextResponse.json({
            ok: false,
            error: `Nomor surat tidak terbaca pada halaman pertama${perluOcr ? " meski sudah lewat OCR" : ""}, dan nama daftar belum diisi. Isi "Nama daftar" lalu unggah lagi — berkasnya tidak akan dibaca ulang, hasil bacanya sudah disimpan.`,
        }, { status: 422 });
    }
    if (!surat.outlets.length) {
        const ada = surat.distributors.slice(0, 12).map((d) => `${d.code} ${d.name} (${d.outlets})`).join("; ");
        return NextResponse.json({
            ok: false,
            error: surat.distributors.length
                ? `Tidak ada outlet berkode distributor "${distCode}" pada lampiran ${surat.kodeAju}. Yang ada: ${ada}`
                : `Surat ${surat.kodeAju} tidak punya halaman lampiran outlet yang terbaca (dibaca lewat ${sumberTeks})`,
        }, { status: 422 });
    }
    // Lampiran tanpa kolom distributor = seluruh daftarnya milik kita. Itu memang bentuk surat
    // yang dikirim per distributor, tetapi WAJIB disebut: kalau ternyata ada kolomnya dan model
    // melewatkannya, kita baru saja memuat outlet milik distributor lain.
    if (surat.tanpaKodeDist) {
        catatan.push("Lampiran ini tidak punya kolom distributor, jadi SELURUH barisnya dimuat sebagai peserta. Periksa sekali bahwa daftarnya memang khusus untuk kita.");
    }

    const rows: (typeof promoOutlet.$inferInsert)[] = [];
    const ditolak: string[] = [];
    const sudah = new Set<string>();
    for (const outlet of surat.outlets) {
        const hasil = resolve(outlet.outletCode);
        if ("error" in hasil) { ditolak.push(`${outlet.outletCode} (${outlet.label}): ${hasil.error}`); continue; }
        if (sudah.has(hasil.code)) continue;
        sudah.add(hasil.code);
        rows.push({
            listName, customerCode: hasil.code, customerName: hasil.name,
            tier: "", sourceCode: outlet.outletCode,
            periodStart: text(form.get("periodStart")).slice(0, 10) || null,
            periodEnd: text(form.get("periodEnd")).slice(0, 10) || null,
            active: true, note: `dari lampiran surat ${surat.kodeAju || listName}`, importedBy: email,
        });
    }
    const ditambah = await simpanAnggota(rows, email);

    // Aturan surat ini LANGSUNG ditunjuk ke daftarnya. Itu memang maksud lampirannya: surat yang
    // membawa daftar outlet berlaku HANYA untuk outlet itu. Membiarkan langkah ini manual berarti
    // daftarnya ada, terlihat benar di layar, dan tidak menahan apa pun.
    // Aturan hanya bisa ditunjuk kalau kita tahu surat MANA ini. Nama daftar yang diketik
    // manusia tidak boleh dipakai mencari aturan: salah ketik satu huruf akan menunjuk aturan
    // surat lain, dan itu memindahkan hak promo tanpa ada yang tahu.
    const ditunjuk = surat.kodeAju
        ? await db.update(promoRule)
            .set({ outletList: listName, outletListMode: "INCLUDE" })
            .where(eq(promoRule.suratProgram, surat.kodeAju))
            .returning({ id: promoRule.id })
        : [];

    return NextResponse.json({
        ok: true, sumber: "surat", listName, program: surat.program, sumberTeks, ocrPages,
        // Angkanya wajib menjumlah: diminta = ditambah + ditolak + kembar. Selisih yang tidak
        // dijelaskan membuat orang mengira ada baris yang hilang diam-diam.
        ditambah, diminta: surat.outlets.length, kembar: surat.outlets.length - ditolak.length - rows.length,
        ditolak: ditolak.slice(0, 50),
        aturanDitunjuk: ditunjuk.length,
        catatan: [
            ...catatan,
            ...(!surat.kodeAju
                ? [`Nomor surat tidak terbaca, jadi daftarnya dinamai "${listName}" dan TIDAK ada aturan yang ditunjuk otomatis. Tunjuk sendiri lewat kolom "Hanya untuk peserta daftar" pada aturannya.`]
                : ditunjuk.length === 0
                    ? [`Aturan surat ${surat.kodeAju} belum dimuat, jadi belum ada yang bisa ditunjuk ke daftar ini. Muat aturannya dulu lewat Rekap Promo.`]
                    : []),
            ...(surat.skipped > 0 ? [`${surat.skipped} baris lampiran tidak terbaca sebagai baris outlet.`] : []),
        ],
    });
}

/** Berkas terpisah (xlsx/csv) dengan kolom TEMPLATE_HEADER. */
async function dariBerkas(
    raw: Uint8Array, form: FormData, resolve: ReturnType<typeof resolverOf>, email: string,
) {
    const listName = text(form.get("listName")).toUpperCase();
    if (!listName) return NextResponse.json({ ok: false, error: "Nama daftar wajib diisi untuk berkas terpisah" }, { status: 422 });

    let sheet: Record<string, unknown>[];
    try {
        const book = XLSX.read(raw, { type: "array" });
        sheet = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets[book.SheetNames[0]], { defval: "" });
    } catch (error) {
        return NextResponse.json({ ok: false, error: `Berkas tidak terbaca: ${error instanceof Error ? error.message : "gagal"}` }, { status: 422 });
    }

    const pick = (row: Record<string, unknown>, ...names: string[]) => {
        const key = Object.keys(row).find((k) => names.includes(k.trim().toUpperCase().replace(/\s+/g, " ")));
        return key ? text(row[key]) : "";
    };
    const rows: (typeof promoOutlet.$inferInsert)[] = [];
    const ditolak: string[] = [];
    const sudah = new Set<string>();
    sheet.forEach((row, index) => {
        const kode = pick(row, "KODE_OUTLET", "KODE OUTLET", "KODE", "KODE INTERNAL", "KODE PELANGGAN");
        if (!kode) return;
        const hasil = resolve(kode);
        if ("error" in hasil) { ditolak.push(`baris ${index + 2}: ${hasil.error}`); return; }
        if (sudah.has(hasil.code)) return;
        sudah.add(hasil.code);
        rows.push({
            listName, customerCode: hasil.code, customerName: hasil.name,
            tier: pick(row, "TINGKAT", "TIER", "KELAS").toUpperCase(),
            sourceCode: hasil.source,
            periodStart: (pick(row, "MULAI", "PERIOD_START", "PERIODE MULAI") || text(form.get("periodStart"))).slice(0, 10) || null,
            periodEnd: (pick(row, "SAMPAI", "PERIOD_END", "PERIODE SAMPAI") || text(form.get("periodEnd"))).slice(0, 10) || null,
            active: true, note: pick(row, "CATATAN", "KETERANGAN", "NOTE"), importedBy: email,
        });
    });
    if (!rows.length) {
        return NextResponse.json({ ok: false, error: `Tidak ada kode yang bisa dipakai. ${ditolak.slice(0, 5).join("; ")}` }, { status: 422 });
    }
    const ditambah = await simpanAnggota(rows, email);
    return NextResponse.json({ ok: true, sumber: "berkas", listName, ditambah, diminta: sheet.length,
        kembar: sheet.length - ditolak.length - rows.length, ditolak: ditolak.slice(0, 50), catatan: [] });
}

/**
 * Menambah anggota, SATU ATAU BANYAK SEKALIGUS.
 *
 * Borongan memang bentuk kerjanya: daftar loyalty datang sebagai satu kolom berisi puluhan
 * kode, dan menambahkannya satu per satu adalah cara terbaik untuk berhenti di tengah. Yang
 * tidak terbaca dikembalikan dengan alasannya masing-masing — bukan menggagalkan seluruhnya,
 * karena satu kode salah ketik tidak boleh membatalkan tiga puluh yang benar, dan bukan pula
 * dibuang diam-diam.
 */
export async function POST(request: NextRequest) {
    const gate = await gateOf("summary.edit");
    if (gate.response) return gate.response;
    if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
        return unggah(request, gate.email!);
    }
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ ok: false, error: "Isian tidak terbaca" }, { status: 400 });

    const listName = text(body.listName).toUpperCase();
    if (!listName) return NextResponse.json({ ok: false, error: "Nama daftar wajib diisi" }, { status: 422 });
    const principal = text(body.principal) || "KINO NON FOOD";
    const kode = String(body.codes ?? body.customerCode ?? "").split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean);
    if (!kode.length) return NextResponse.json({ ok: false, error: "Sebutkan kode outletnya" }, { status: 422 });
    if (kode.length > 1000) return NextResponse.json({ ok: false, error: "Maksimal 1000 kode sekali tambah" }, { status: 413 });

    const { mapping, internal } = await lookups(principal);
    const resolve = resolverOf(mapping, internal);

    const rows: typeof promoOutlet.$inferInsert[] = [];
    const ditolak: string[] = [];
    const sudahAda = new Set<string>();
    for (const satu of kode) {
        const hasil = resolve(satu);
        if ("error" in hasil) { ditolak.push(hasil.error); continue; }
        // Kembar di dalam satu kiriman diselesaikan di sini: menyerahkannya ke kunci unik
        // berarti seluruh kiriman gagal gara-gara satu kode yang tertulis dua kali.
        if (sudahAda.has(hasil.code)) continue;
        sudahAda.add(hasil.code);
        rows.push({
            listName, customerCode: hasil.code, customerName: hasil.name,
            tier: text(body.tier).toUpperCase(), sourceCode: hasil.source,
            periodStart: text(body.periodStart).slice(0, 10) || null,
            periodEnd: text(body.periodEnd).slice(0, 10) || null,
            active: body.active !== false, note: text(body.note), importedBy: gate.email!,
        });
    }
    if (!rows.length) {
        return NextResponse.json({ ok: false, error: `Tidak ada kode yang bisa dipakai. ${ditolak.join("; ")}` }, { status: 422 });
    }

    const ditambah = await simpanAnggota(rows, gate.email!);

    return NextResponse.json({
        ok: true, sumber: "ketik", listName, ditambah, diminta: kode.length,
        kembar: kode.length - ditolak.length - rows.length, ditolak: ditolak.slice(0, 50), catatan: [],
    });
}

/** Mengubah satu anggota — tingkat, periode, aktif, catatan. Kode outletnya tidak diubah di sini. */
export async function PATCH(request: NextRequest) {
    const gate = await gateOf("summary.edit");
    if (gate.response) return gate.response;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const id = Number(body?.id);
    if (!body || !Number.isFinite(id)) return NextResponse.json({ ok: false, error: "id wajib diisi" }, { status: 400 });

    const changed = await db.update(promoOutlet).set({
        tier: text(body.tier).toUpperCase(),
        periodStart: text(body.periodStart).slice(0, 10) || null,
        periodEnd: text(body.periodEnd).slice(0, 10) || null,
        active: body.active !== false,
        note: text(body.note),
        importedBy: gate.email!, importedAt: new Date(),
    }).where(eq(promoOutlet.id, id)).returning({ id: promoOutlet.id });
    if (!changed.length) return NextResponse.json({ ok: false, error: "Anggota tidak ditemukan" }, { status: 404 });
    return NextResponse.json({ ok: true, id });
}

export async function DELETE(request: NextRequest) {
    const gate = await gateOf("summary.edit");
    if (gate.response) return gate.response;
    const satu = request.nextUrl.searchParams.get("id");
    const banyak = request.nextUrl.searchParams.get("ids");
    const ids = [...new Set([satu, ...(banyak ?? "").split(",")]
        .map((value) => Number(String(value ?? "").trim()))
        .filter((value) => Number.isFinite(value) && value > 0))];
    if (!ids.length) return NextResponse.json({ ok: false, error: "Sebutkan id anggota yang mau dihapus" }, { status: 400 });
    if (ids.length > 1000) return NextResponse.json({ ok: false, error: "Maksimal 1000 anggota sekali hapus" }, { status: 413 });

    const gone = await db.delete(promoOutlet).where(inArray(promoOutlet.id, ids)).returning({ id: promoOutlet.id });
    if (!gone.length) return NextResponse.json({ ok: false, error: "Tidak ada anggota yang cocok" }, { status: 404 });
    return NextResponse.json({ ok: true, deleted: gone.length, diminta: ids.length });
}
