/*
 * Tujuan: Tombol Kirim — petugas melepas faktur dari antrean ke Accurate, lalu hasilnya
 *         LANGSUNG dibaca balik dari Accurate dan dibandingkan dengan yang dikirim.
 * Caller: halaman Antrean Faktur (/antrean-faktur), tombol "Kirim ke Accurate".
 * Dependensi: lib/invoice-sender (jalur kirim yang sama dengan cron), lib/sync
 *             (tarik detail.do), lib/invoice-verify, rbac.
 * Main Functions: POST.
 * Side Effects: MENULIS FAKTUR DI ACCURATE. Tidak bisa dibatalkan.
 *
 * Kenapa tombol ini TIDAK memakai `ACCURATE_INVOICE_SEND`: env itu rem untuk jalur OTOMATIS —
 * cron yang berjalan sendiri tanpa ada yang menekan apa pun, dan yang karena itu wajib mati
 * selama belum dipercaya. Tombol ini kebalikannya: ada manusia berizin yang menekannya,
 * namanya tercatat, dan hasilnya diperiksa detik itu juga. Menggantungkannya pada env justru
 * memperburuk keadaan — env di Coolify TERTIMPA tiap deploy (terbukti 2026-09-12: dua env
 * pengirim lenyap dalam sehari), jadi tombolnya akan mati diam-diam pada waktu yang tak terduga.
 *
 * Gerbang yang TETAP ADA, dan semuanya gagal-tertutup:
 *   - izin `order.edit`,
 *   - sesi Accurate milik PENEKAN sendiri, bukan "sesi terbaru siapa pun",
 *   - `ACCURATE_INVOICE_DB_ID` wajib cocok dengan database sesi itu — salah database = tolak,
 *   - hanya baris `queued` yang terkirim; `rejected` menunggu manusia, `unknown` tidak pernah.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { invoiceOutbox, salesInvoiceCache } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { getAccurateSession } from "@/lib/accurate-session";
import { isAllowedAccurateHost } from "@/lib/api-security";
import { sendQueuedInvoices } from "@/lib/invoice-sender";
import { upsertSalesInvoiceById } from "@/lib/sync";
import { verifyInvoice } from "@/lib/invoice-verify";
import type { InvoicePayload } from "@/lib/accurate-invoice-write";

export const runtime = "nodejs";
export const maxDuration = 600;

const MAX_PER_PRESS = 50;

export async function POST(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.edit")) {
        return NextResponse.json({ ok: false, error: "Hanya petugas yang boleh mengirim faktur ke Accurate" }, { status: 403 });
    }

    const targetDb = String(process.env.ACCURATE_INVOICE_DB_ID || "").trim();
    if (!targetDb) {
        return NextResponse.json({
            ok: false,
            error: "ACCURATE_INVOICE_DB_ID belum di-set. Tanpa itu tidak ada yang menjamin faktur masuk ke database yang benar.",
        }, { status: 503 });
    }

    const userId = String(gate.session?.user?.id ?? "");
    const session = await getAccurateSession(userId);
    if (!session?.accessToken || !session.sessionHost || !session.sessionId) {
        return NextResponse.json({
            ok: false,
            error: "Sesi Accurate Anda tidak lengkap. Login Accurate dulu di /api-wrapper, lalu coba lagi.",
        }, { status: 503 });
    }
    if (!isAllowedAccurateHost(session.sessionHost)) {
        return NextResponse.json({ ok: false, error: "Session host Accurate tidak diizinkan" }, { status: 400 });
    }
    if (String(session.databaseId ?? "") !== targetDb) {
        return NextResponse.json({
            ok: false,
            error: `Sesi Accurate Anda terbuka pada database ${session.databaseId ?? "?"}, bukan ${targetDb}. Tidak ada faktur dikirim.`,
        }, { status: 409 });
    }

    const body = await request.json().catch(() => ({}));
    const orderIds = Array.isArray(body?.orderIds) ? body.orderIds.map(String) : undefined;

    const outcome = await sendQueuedInvoices(
        { sessionHost: session.sessionHost, sessionId: session.sessionId, accessToken: session.accessToken },
        { targetDb, limit: MAX_PER_PRESS, orderIds },
    );

    // Verifikasi balik DI TEMPAT. Tanpa ini, "terkirim" hanya berarti Accurate menerima request —
    // bukan bahwa isinya benar. Faktur yang baru terbentuk ditarik ulang lewat detail.do dulu,
    // karena hanya detail.do yang membawa rincian baris; list.do tidak.
    const verified: Record<string, unknown>[] = [];
    const postedIds = outcome.results.filter((row) => row.state === "posted" && row.accurateId);
    for (const row of postedIds) {
        let reason = "";
        try {
            await upsertSalesInvoiceById(Number(row.accurateId), {
                databaseId: targetDb, sessionHost: session.sessionHost,
                sessionId: session.sessionId, apiKey: session.accessToken,
            });
        } catch (error) {
            // Fakturnya SUDAH terbentuk; yang gagal hanya pembacaan baliknya. Itu bukan
            // kegagalan kirim, dan tidak boleh dilaporkan sebagai berhasil juga.
            reason = error instanceof Error ? error.message : "gagal menarik faktur dari Accurate";
        }
        const [outboxRow] = await db.select({ payload: invoiceOutbox.payload })
            .from(invoiceOutbox).where(eq(invoiceOutbox.orderId, row.orderId)).limit(1);
        const [cached] = await db.select({ raw: salesInvoiceCache.rawData })
            .from(salesInvoiceCache).where(eq(salesInvoiceCache.id, Number(row.accurateId))).limit(1);
        const result = outboxRow && cached
            ? verifyInvoice(outboxRow.payload as InvoicePayload, cached.raw)
            : { status: "tak-terperiksa" as const, reason: reason || "Faktur belum bisa dibaca balik dari Accurate",
                findings: [], invoiceNumber: row.number ?? "", invoiceId: row.accurateId ?? "",
                linesChecked: 0, salesman: "", invoiceDate: "" };
        verified.push({ orderId: row.orderId, ...result });
    }

    const mismatched = verified.filter((row) => row.status === "selisih").length;
    const unchecked = verified.filter((row) => row.status === "tak-terperiksa").length;
    // "Berhasil" berarti terkirim DAN isinya terbukti sama. Terkirim saja belum tentu benar,
    // dan melaporkannya sebagai sukses adalah persis kebiasaan yang verifikasi ini gantikan.
    const clean = verified.filter((row) => row.status === "cocok").length;

    const stillQueued = await db.select({ orderId: invoiceOutbox.orderId })
        .from(invoiceOutbox).where(inArray(invoiceOutbox.state, ["queued"]));

    return NextResponse.json({
        ok: outcome.unknown === 0 && mismatched === 0,
        sent: outcome.sent,
        verifiedOk: clean,
        mismatched,
        unchecked,
        rejected: outcome.rejected,
        unknown: outcome.unknown,
        remaining: stillQueued.length,
        results: outcome.results,
        verified,
        sentBy: String(gate.session?.user?.email ?? userId),
    });
}
