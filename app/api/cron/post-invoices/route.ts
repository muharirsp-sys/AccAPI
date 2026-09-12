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
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { invoiceOutbox } from "@/db/schema";
import { isAllowedAccurateHost, requireCronSecret } from "@/lib/api-security";
import { getAccurateSession } from "@/lib/accurate-session";
import { sendQueuedInvoices } from "@/lib/invoice-sender";

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
    //
    // Jalur kirimnya SAMA PERSIS dengan tombol Kirim (lib/invoice-sender). Yang berbeda hanya
    // gerbangnya: di sini env, di sana izin + sesi penekannya.
    const outcome = await sendQueuedInvoices(
        { sessionHost: session.sessionHost, sessionId: session.sessionId, accessToken: session.accessToken },
        { targetDb, limit: BATCH },
    );
    const results = outcome.results;
    const unknown = results.filter((item) => item.state === "unknown").length;
    return NextResponse.json({ ok: unknown === 0, sent: results.filter((i) => i.state === "posted").length, unknown, results });
}
