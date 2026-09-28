/*
 * Tujuan: Verifikasi balik OTOMATIS (butir 4.30) — faktur yang SUDAH masuk Accurate
 *         disandingkan dengan payload beku antrean, per baris, lalu selisihnya ditandai.
 * Caller: halaman Antrean Faktur (/antrean-faktur), bagian "Verifikasi balik".
 * Dependensi: db (invoice_outbox, sales_invoice), lib/invoice-verify, lib/accurate-invoice-write, rbac.
 * Main Functions: GET, POST (jelaskan selisih), DELETE (cabut penjelasan).
 * Side Effects: GET read-only. POST/DELETE hanya menulis `invoice_verify_note`; tidak menyentuh
 *               Accurate dan tidak mengubah antrean.
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
import { invoiceOutbox, invoiceVerifyNote, salesInvoiceCache } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { toAccurateDate, type InvoicePayload } from "@/lib/accurate-invoice-write";
import { readAccurateInvoice, terapkanPenjelasan, verifyInvoice, type JenisTemuan, type VerifyResult } from "@/lib/invoice-verify";

export const runtime = "nodejs";

/** Yang berpotensi punya faktur di Accurate: `posted` pasti, `unknown` mungkin. */
const VERIFIABLE = ["posted", "unknown"];
const JENIS: JenisTemuan[] = ["sales", "isi"];

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
        return NextResponse.json({ ok: true, checked: 0, summary: { cocok: 0, selisih: 0, dijelaskan: 0, "tak-terperiksa": 0 }, rows: [] });
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

    // Penjelasan hanya berlaku untuk temuan PERSIS yang dijelaskan (`sidik`). Selisih yang semua
    // temuannya sudah dijelaskan dihitung "dijelaskan", bukan "selisih" — angka merah di layar
    // harus berarti "belum ada yang tahu kenapa", bukan "pernah berbeda".
    const catatan = await db.select().from(invoiceVerifyNote)
        .where(inArray(invoiceVerifyNote.orderId, rows.map((row) => row.orderId)));
    const summary: Record<string, number> = { cocok: 0, selisih: 0, dijelaskan: 0, "tak-terperiksa": 0 };
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
        const { findings, terbuka, sidik, penjelasan } = terapkanPenjelasan(result.findings, catatan
            .filter((entry) => entry.orderId === row.orderId)
            .map((entry) => ({ jenis: entry.jenis, sidik: entry.sidik, note: entry.note, by: entry.decidedBy, at: entry.decidedAt.toISOString() })));
        summary[result.status === "selisih" && terbuka === 0 ? "dijelaskan" : result.status] += 1;
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
            findings, terbuka, sidik, penjelasan,
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

/**
 * Jelaskan satu jenis selisih: `sales` cukup diterima (sales diganti di Accurate), `isi` wajib
 * disertai penjelasan (koreksi saat pengiriman). `sidik` = temuan yang dilihat penjelas; kalau
 * sudah basi, penjelasannya tersimpan tetapi tidak berlaku — gagalnya tertutup, bukan terbuka.
 */
export async function POST(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.edit")) {
        return NextResponse.json({ ok: false, error: "Hanya pengelola order yang boleh menjelaskan selisih" }, { status: 403 });
    }
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const orderId = String(body.orderId ?? "").trim();
    const jenis = String(body.jenis ?? "") as JenisTemuan;
    const sidik = String(body.sidik ?? "");
    const note = String(body.note ?? "").trim().slice(0, 500);
    if (!orderId || !JENIS.includes(jenis) || !sidik.startsWith("[") || sidik === "[]" || sidik.length > 20_000) {
        return NextResponse.json({ ok: false, error: "orderId, jenis (sales/isi), dan temuan yang dijelaskan wajib diisi" }, { status: 400 });
    }
    if (jenis === "isi" && !note) {
        return NextResponse.json({ ok: false, error: "Selisih isi faktur wajib dijelaskan, mis. \"koreksi qty saat pengiriman\"" }, { status: 400 });
    }
    const [ada] = await db.select({ orderId: invoiceOutbox.orderId }).from(invoiceOutbox).where(eq(invoiceOutbox.orderId, orderId));
    if (!ada) return NextResponse.json({ ok: false, error: "SO ini tidak ada di antrean faktur" }, { status: 404 });

    const values = {
        orderId, jenis, sidik, note: note || "Sales diganti di Accurate sesudah terkirim",
        decidedBy: String(gate.session?.user?.email ?? ""), decidedAt: new Date(),
    };
    await db.insert(invoiceVerifyNote).values(values).onConflictDoUpdate({
        target: [invoiceVerifyNote.orderId, invoiceVerifyNote.jenis],
        set: { sidik: values.sidik, note: values.note, decidedBy: values.decidedBy, decidedAt: values.decidedAt },
    });
    return NextResponse.json({ ok: true });
}

/** Cabut penjelasan: selisihnya terbuka lagi. */
export async function DELETE(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.edit")) {
        return NextResponse.json({ ok: false, error: "Hanya pengelola order yang boleh mencabut penjelasan" }, { status: 403 });
    }
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const orderId = String(body.orderId ?? "").trim();
    const jenis = String(body.jenis ?? "") as JenisTemuan;
    if (!orderId || !JENIS.includes(jenis)) {
        return NextResponse.json({ ok: false, error: "orderId dan jenis (sales/isi) wajib diisi" }, { status: 400 });
    }
    await db.delete(invoiceVerifyNote).where(and(eq(invoiceVerifyNote.orderId, orderId), eq(invoiceVerifyNote.jenis, jenis)));
    return NextResponse.json({ ok: true });
}
