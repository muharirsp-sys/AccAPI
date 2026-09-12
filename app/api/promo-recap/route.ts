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
import { and, eq, gte, lte, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db } from "@/lib/db";
import { promoRule, salesInvoiceCache } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { invoiceLines, recap, type PromoRule } from "@/lib/promo-recap";

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

export async function GET(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("summary.view") && !gate.perms?.has("order.view")) {
        return NextResponse.json({ ok: false, error: "Akses rekap promo tidak diizinkan" }, { status: 403 });
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
        promoGroup: row.promoGroup, itemCode: row.itemCode,
        periodStart: row.periodStart, periodEnd: row.periodEnd,
        benefitType: row.benefitType, benefitValue: row.benefitValue, benefitUnit: row.benefitUnit,
        onFaktur: row.onFaktur,
    }));

    const lines = rows.flatMap((row) => invoiceLines(row.raw));
    const result = recap(lines, rules);

    // Faktur yang `raw_data`-nya belum memuat rincian baris: hanya jalur webhook (detail.do)
    // yang membawanya, faktur hasil sync daftar tidak. Wajib terlihat, bukan hilang diam-diam.
    // Dihitung dari hasil bongkar, bukan dari bentuk mentahnya: `raw_data` tersimpan sebagai
    // TEKS JSON (lihat catatan di lib/promo-recap), jadi memeriksa `raw.detailItem` langsung
    // selalu menjawab "tidak ada rincian" untuk semua faktur.
    const withDetail = new Set(lines.map((line) => line.invoiceId || line.invoiceNo));
    const withoutDetail = rows.length - withDetail.size;

    return NextResponse.json({
        ok: true, from, to,
        invoicesInRange: rows.length,
        invoicesWithoutDetail: withoutDetail,
        rules: rules.length,
        recap: result,
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
    if (!sheet) return NextResponse.json({ ok: false, error: "Berkas ini tidak punya sheet `Detail`" }, { status: 422 });
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

    const issues: string[] = [];
    const values = raw.map((row, index) => {
        const periode = text(row.PERIODE);
        const start = text(row.PERIOD_START) || monthStart(periode);
        const end = text(row.PERIOD_END) || monthEnd(periode);
        if (!start || !end) issues.push(`Baris ${index + 2}: periode "${periode}" tidak terbaca`);
        return {
            principal,
            suratProgram: text(row.SURAT_PROGRAM), promoLabel: text(row.PROMO_LABEL),
            promoGroupId: text(row.PROMO_GROUP_ID), promoGroup: text(row.PROMO_GROUP),
            itemCode: text(row.KODE_BARANG), itemName: text(row.NAMA_BARANG), prdId: text(row.PRD_ID_KINO),
            periodStart: start || null, periodEnd: end || null,
            active: text(row.PROMO_ACTIVE).toLowerCase() !== "false",
            tierNo: Number(row.TIER_NO) || 1,
            triggerQty: String(Number(row.TRIGGER_QTY) || 0),
            triggerUnit: text(row.TRIGGER_UNIT) || "PCS",
            benefitType: text(row.BENEFIT_TYPE), benefitValue: text(row.BENEFIT_VALUE),
            benefitUnit: text(row.BENEFIT_UNIT), benefitBeban: text(row.BENEFIT_BEBAN) || "PRINCIPAL",
            onFaktur: !text(row.CARA_TAGIH).toUpperCase().startsWith("BUKAN"),
            note: text(row.CATATAN), importedBy: String(gate.session?.user?.email ?? ""),
        };
    });
    if (values.length === 0) return NextResponse.json({ ok: false, error: "Sheet `Detail` kosong" }, { status: 422 });

    // Satu barang internal bisa punya DUA kode principal (pecahan berbeda di sistem Kino),
    // sehingga barisnya kembar. Aturan promo melekat pada barang internal, jadi yang kembar
    // digabung dan kode principalnya dicatat berdampingan — bukan dibuang diam-diam.
    const unik = new Map<string, (typeof values)[number]>();
    let digabung = 0;
    for (const row of values) {
        const key = `${row.suratProgram}|${row.promoGroup}|${row.itemCode}|${row.tierNo}`;
        const ada = unik.get(key);
        if (!ada) { unik.set(key, row); continue; }
        digabung += 1;
        if (row.prdId && !ada.prdId.split(", ").includes(row.prdId)) ada.prdId = `${ada.prdId}, ${row.prdId}`;
    }
    const baris = [...unik.values()];

    const summary = {
        rows: baris.length,
        merged: digabung,
        programs: new Set(baris.map((v) => `${v.suratProgram}|${v.promoGroup}`)).size,
        tingkatFaktur: baris.filter((v) => !v.itemCode).length,
        issues: issues.slice(0, 50),
    };
    if (!apply) return NextResponse.json({ ok: true, applied: false, ...summary });

    await db.transaction(async (tx) => {
        // Muat ulang MENGGANTI aturan principal ini: program yang dicabut harus benar-benar
        // hilang, bukan menumpuk dari muatan sebelumnya lalu ikut menjelaskan diskon.
        await tx.delete(promoRule).where(eq(promoRule.principal, principal));
        for (let start = 0; start < baris.length; start += 500) {
            await tx.insert(promoRule).values(baris.slice(start, start + 500));
        }
    });
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
