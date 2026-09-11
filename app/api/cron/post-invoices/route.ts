/*
 * Tujuan: Mengirim faktur dari antrean ke Accurate — SATU-SATUNYA tempat request tulis terjadi.
 * Caller: Coolify scheduled task / cron dengan Bearer CRON_SECRET.
 * Dependensi: db invoice_outbox, lib/accurate-invoice-write (status + identitas), lib/accurate-session.
 * Main Functions: GET.
 * Side Effects: Menulis faktur, update antrean; membaca kembali faktur untuk verifikasi benefit program.
 *
 * GERBANG SENGAJA TERTUTUP (keputusan pengguna 2026-09-08: "bangun dulu tanpa mengirim").
 * Endpoint ini MENOLAK sampai dua env di-set eksplisit:
 *   ACCURATE_INVOICE_SEND=on         -> izin mengirim
 *   ACCURATE_INVOICE_DB_ID=<id>      -> database Accurate yang dituju, dicocokkan dengan
 *                                       databaseId sesi; salah database = tolak, jangan kirim.
 * Tanpa keduanya: 503 dan NOL request tulis. Ini bukan kerusakan, ini rem tangan.
 *
 * Aturan yang tidak boleh dilanggar:
 * - Timeout/koneksi putus = TIDAK PASTI (`unknown`), bukan gagal. Tidak pernah dikirim ulang
 *   otomatis: kunci unik lokal tidak menjamin tidak ada faktur ganda di Accurate.
 * - Yang diambil HANYA `queued`. `rejected` dilepas ulang manusia lewat /antrean-faktur.
 * - Nomor faktur datang dari Accurate; payload memakai typeAutoNumber.
 * - Identitas yang disimpan = database + record id.
 */
import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { invoiceOutbox } from "@/db/schema";
import { isAllowedAccurateHost, requireCronSecret } from "@/lib/api-security";
import { getAccurateSession } from "@/lib/accurate-session";
import { nextOutboxState, readInvoiceIdentity, type SendOutcome } from "@/lib/accurate-invoice-write";
import { refreshRealization } from "@/lib/program-realization-store";

export const runtime = "nodejs";
export const maxDuration = 600;

const BATCH = Math.max(1, Math.min(Number(process.env.ACCURATE_INVOICE_BATCH || 20), 50));

export async function GET(request: Request) {
    const gate = requireCronSecret(request);
    if (gate.response) return gate.response;

    const targetDb = String(process.env.ACCURATE_INVOICE_DB_ID || "").trim();
    if (String(process.env.ACCURATE_INVOICE_SEND || "").trim().toLowerCase() !== "on" || !targetDb) {
        const queued = await db.select({ orderId: invoiceOutbox.orderId }).from(invoiceOutbox)
            .where(eq(invoiceOutbox.state, "queued"));
        return NextResponse.json({
            ok: false,
            error: "Pengiriman faktur Accurate belum diizinkan. Set ACCURATE_INVOICE_SEND=on dan "
                + "ACCURATE_INVOICE_DB_ID=<database Accurate tujuan> setelah satu faktur uji diperiksa.",
            waiting: queued.length,
            sent: 0,
        }, { status: 503 });
    }

    // Penulisan faktur WAJIB terikat petugas yang eksplisit — bukan "sesi terbaru siapa pun".
    const officer = String(process.env.ACCURATE_INVOICE_USER_ID || "").trim();
    if (!officer) {
        return NextResponse.json({ ok: false, error: "ACCURATE_INVOICE_USER_ID belum di-set (petugas pemilik sesi Accurate)" }, { status: 503 });
    }
    const session = await getAccurateSession(officer);
    if (!session?.accessToken || !session.sessionHost || !session.sessionId) {
        return NextResponse.json({ ok: false, error: "Sesi Accurate petugas tidak lengkap; login ulang di /api-wrapper" }, { status: 503 });
    }
    if (!isAllowedAccurateHost(session.sessionHost)) {
        return NextResponse.json({ ok: false, error: "Session host Accurate tidak diizinkan" }, { status: 400 });
    }
    if (String(session.databaseId ?? "") !== targetDb) {
        return NextResponse.json({
            ok: false,
            error: `Sesi Accurate terbuka pada database ${session.databaseId ?? "?"}, bukan ${targetDb}. Tidak ada faktur dikirim.`,
        }, { status: 409 });
    }

    // HANYA `queued`. Yang `rejected` menunggu manusia menekan "Kirim ulang" di halaman
    // Antrean Faktur: Accurate menolaknya karena ada yang salah, dan mengulang tiap jalannya
    // cron hanya menumpuk kegagalan yang sama tanpa memperbaiki sebabnya.
    const rows = await db.select().from(invoiceOutbox)
        .where(eq(invoiceOutbox.state, "queued"))
        .orderBy(asc(invoiceOutbox.createdAt)).limit(BATCH);

    const results: { order_id: string; state: string; number?: string; error?: string }[] = [];
    for (const row of rows) {
        // Klaim baris dulu: `sending` menandai bahwa request MUNGKIN sudah terkirim, jadi
        // proses yang mati di tengah tidak meninggalkan baris yang terlihat aman dikirim ulang.
        const claimed = await db.update(invoiceOutbox)
            .set({ state: "sending", attempts: row.attempts + 1, updatedAt: new Date() })
            .where(and(eq(invoiceOutbox.orderId, row.orderId), eq(invoiceOutbox.state, row.state)))
            .returning({ orderId: invoiceOutbox.orderId });
        if (claimed.length === 0) continue; // diklaim proses lain

        let outcome: SendOutcome;
        try {
            const response = await fetch(`${session.sessionHost}/accurate/api/sales-invoice/save.do`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    Authorization: `Bearer ${session.accessToken}`,
                    "X-Session-ID": session.sessionId,
                },
                body: JSON.stringify(row.payload),
                signal: AbortSignal.timeout(60_000),
            });
            const text = await response.text();
            let body: unknown;
            try {
                body = JSON.parse(text);
            } catch {
                // Respons non-JSON: kita tidak tahu fakturnya terbentuk atau tidak.
                outcome = { kind: "no_answer", message: `respons non-JSON (${response.status})` };
                body = null;
            }
            if (body !== null) {
                const identity = readInvoiceIdentity(body);
                outcome = identity.ok
                    ? { kind: "posted", id: identity.id, number: identity.number }
                    : { kind: "rejected", message: identity.message };
            }
        } catch (error) {
            // Timeout atau koneksi putus: fakturnya MUNGKIN sudah terbentuk di Accurate.
            outcome = { kind: "no_answer", message: error instanceof Error ? error.message : "tanpa jawaban" };
        }

        const state = nextOutboxState("sending", outcome!);
        await db.update(invoiceOutbox).set({
            state,
            updatedAt: new Date(),
            ...(outcome!.kind === "posted"
                ? { accurateDbId: targetDb, accurateId: outcome!.id, accurateNumber: outcome!.number, lastError: "" }
                : { lastError: outcome!.message.slice(0, 1000) }),
        }).where(eq(invoiceOutbox.orderId, row.orderId));
        if (state === "posted") {
            try { await refreshRealization(row.orderId, { databaseId: targetDb, sessionHost: session.sessionHost,
                sessionId: session.sessionId, apiKey: session.accessToken }); }
            catch { /* Faktur sudah tersimpan; pemeriksaan dapat diulang dari laporan tanpa mengirim ulang. */ }
        }
        results.push({
            order_id: row.orderId, state,
            ...(outcome!.kind === "posted" ? { number: outcome!.number } : { error: outcome!.message.slice(0, 200) }),
        });
        // Status TIDAK PASTI menghentikan batch: satu jaringan bermasalah tidak boleh
        // menghasilkan sepuluh faktur yang tidak jelas nasibnya.
        if (state === "unknown") break;
    }
    const unknown = results.filter((item) => item.state === "unknown").length;
    return NextResponse.json({ ok: unknown === 0, sent: results.filter((i) => i.state === "posted").length, unknown, results });
}
