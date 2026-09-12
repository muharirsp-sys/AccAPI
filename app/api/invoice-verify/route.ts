/*
 * Tujuan: Verifikasi balik OTOMATIS (butir 4.30) — faktur yang SUDAH masuk Accurate
 *         disandingkan dengan payload beku antrean, per baris, lalu selisihnya ditandai.
 * Caller: halaman Antrean Faktur (/antrean-faktur), bagian "Verifikasi balik".
 * Dependensi: db (invoice_outbox, sales_invoice), lib/invoice-verify, lib/accurate-invoice-write, rbac.
 * Main Functions: GET.
 * Side Effects: TIDAK ADA. Read-only — tidak menulis DB dan tidak menyentuh Accurate.
 *
 * Kenapa read-only meski hasilnya bisa "menyelesaikan" baris TIDAK PASTI: menemukan fakturnya
 * di Accurate memang bukti kuat, tetapi mengubah status antrean atas dasar pencocokan otomatis
 * berarti satu kekeliruan pasangan langsung menutup masalah yang belum selesai. Di sini
 * fakturnya DILAPORKAN ketemu; yang menutup tetap manusia.
 *
 * Penjodohannya dua lapis, dan `charField1` yang menang:
 *   1. `charField1` = kunci antrean (`PRINCIPAL:NO-SO`) — inilah kaitan yang sengaja kita
 *      tanam saat mengirim, dan satu-satunya yang juga bekerja untuk baris TIDAK PASTI yang
 *      tidak pernah menerima record id dari Accurate.
 *   2. `accurate_id` hasil jawaban save.do, sebagai cadangan bila charField1 hilang.
 * Calon fakturnya dipersempit lebih dulu lewat kolom terindeks (id, customer_no, trans_date);
 * memindai seluruh tabel faktur untuk mencari charField1 tidak akan selesai di produksi.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { invoiceOutbox, salesInvoiceCache } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { toAccurateDate, type InvoicePayload } from "@/lib/accurate-invoice-write";
import { readAccurateInvoice, verifyInvoice, type VerifyResult } from "@/lib/invoice-verify";

export const runtime = "nodejs";

/** Yang berpotensi punya faktur di Accurate: `posted` pasti, `unknown` mungkin. */
const VERIFIABLE = ["posted", "unknown"];

export async function GET(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.view")) {
        return NextResponse.json({ ok: false, error: "Akses verifikasi faktur tidak diizinkan" }, { status: 403 });
    }
    const orderId = (request.nextUrl.searchParams.get("orderId") ?? "").trim();
    const limit = Math.max(1, Math.min(Number(request.nextUrl.searchParams.get("limit") ?? 100), 300));

    const rows = await db.select({
        orderId: invoiceOutbox.orderId, customerNo: invoiceOutbox.customerNo, orderDate: invoiceOutbox.orderDate,
        state: invoiceOutbox.state, payload: invoiceOutbox.payload,
        accurateId: invoiceOutbox.accurateId, accurateNumber: invoiceOutbox.accurateNumber,
        updatedAt: invoiceOutbox.updatedAt,
    }).from(invoiceOutbox)
        .where(orderId ? eq(invoiceOutbox.orderId, orderId) : inArray(invoiceOutbox.state, VERIFIABLE))
        .orderBy(desc(invoiceOutbox.updatedAt)).limit(limit);

    if (rows.length === 0) {
        return NextResponse.json({ ok: true, checked: 0, summary: { cocok: 0, selisih: 0, "tak-terperiksa": 0 }, rows: [] });
    }

    const ids = [...new Set(rows.map((row) => Number(row.accurateId)).filter((id) => Number.isFinite(id) && id > 0))];
    const customerNos = [...new Set(rows.map((row) => row.customerNo).filter(Boolean))];
    const transDates = [...new Set(rows.map((row) => {
        try { return toAccurateDate(String(row.orderDate)); } catch { return ""; }
    }).filter(Boolean))];

    // Dua cabang, keduanya lewat kolom terindeks. Yang kedua menjaring faktur yang record id-nya
    // tidak pernah sampai ke kita (status TIDAK PASTI) — di situlah charField1 jadi satu-satunya kait.
    const reach: SQL[] = [];
    if (ids.length) reach.push(inArray(salesInvoiceCache.id, ids));
    if (customerNos.length && transDates.length) {
        reach.push(and(
            inArray(salesInvoiceCache.customerNo, customerNos),
            inArray(salesInvoiceCache.transDate, transDates),
        )!);
    }
    const candidates = reach.length
        ? await db.select({ id: salesInvoiceCache.id, raw: salesInvoiceCache.rawData })
            .from(salesInvoiceCache).where(reach.length === 1 ? reach[0] : or(...reach)!).limit(2000)
        : [];

    // Dikumpulkan sebagai DAFTAR per charField1, bukan satu-satu: dua faktur dengan kunci yang
    // sama berarti SO ini terfakturkan dua kali di Accurate — bencana yang tidak bisa dibatalkan
    // dan satu-satunya cara menemukannya adalah menghitung, bukan mengambil yang pertama.
    const byKey = new Map<string, { id: number; raw: unknown }[]>();
    const byId = new Map<number, unknown>();
    for (const candidate of candidates) {
        const id = Number(candidate.id);
        byId.set(id, candidate.raw);
        const key = readAccurateInvoice(candidate.raw).charField1;
        if (!key) continue;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key)!.push({ id, raw: candidate.raw });
    }

    const summary: Record<string, number> = { cocok: 0, selisih: 0, "tak-terperiksa": 0 };
    const results = rows.map((row) => {
        const sameKey = byKey.get(row.orderId) ?? [];
        // Kalau ada lebih dari satu, yang dibandingkan adalah yang record id-nya kita catat
        // sendiri — supaya laporan gandanya tidak ikut bergantung pada urutan baris DB.
        const picked = sameKey.find((entry) => String(entry.id) === String(row.accurateId)) ?? sameKey[0];
        const raw = picked?.raw ?? byId.get(Number(row.accurateId)) ?? null;
        const matchedBy = picked ? "charField1" : raw ? "record id" : "";
        const duplicates = sameKey.length > 1 ? sameKey.map((entry) => entry.id) : [];
        const result: VerifyResult = raw
            ? verifyInvoice(row.payload as InvoicePayload, raw)
            : {
                status: "tak-terperiksa",
                reason: row.state === "unknown"
                    ? "Faktur dengan charField1 ini TIDAK ditemukan di cache. Belum berarti tidak ada di Accurate — cache bisa tertinggal."
                    : "Faktur belum ada di cache sales_invoice (webhook/sync belum menariknya)",
                findings: [], invoiceNumber: row.accurateNumber ?? "", invoiceId: String(row.accurateId ?? ""),
                linesChecked: 0, salesman: "", invoiceDate: "",
            };
        // Faktur ganda mengalahkan hasil apa pun: isinya boleh cocok semua, tetapi ADA DUA.
        if (duplicates.length > 1) {
            result.status = "selisih";
            result.findings = [{
                line: null, field: "faktur ganda di Accurate",
                expected: "1 faktur untuk SO ini", actual: `${duplicates.length} faktur (id ${duplicates.join(", ")})`,
            }, ...result.findings];
        }
        summary[result.status] += 1;
        return {
            orderId: row.orderId,
            soNo: row.orderId.includes(":") ? row.orderId.slice(row.orderId.indexOf(":") + 1) : null,
            state: row.state,
            customerNo: row.customerNo,
            orderDate: row.orderDate,
            matchedBy,
            // Baris TIDAK PASTI yang fakturnya ternyata KETEMU: bukti bahwa fakturnya sudah
            // terbentuk di Accurate. Dilaporkan, tidak diputuskan sendiri.
            foundWhileUnknown: row.state === "unknown" && Boolean(raw),
            duplicates,
            ...result,
        };
    });

    return NextResponse.json({
        ok: true,
        checked: results.length,
        summary,
        mismatched: summary.selisih,
        rows: results,
    });
}
