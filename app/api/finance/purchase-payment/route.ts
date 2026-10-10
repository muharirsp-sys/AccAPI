/**
 * Tujuan: Command server posting purchase-payment Finance ke Accurate (AM-014 / C.12, DRAFT
 *   zona Accurate write — butuh review manusia). Attempt diklaim di Postgres SEBELUM kirim.
 * Caller: app/(dashboard)/finance/posting.ts (postingPurchasePayment).
 * Dependensi: lib/accurate-write-attempt, lib/accurate-forward, lib/accurate-session, lib/rbac/resolve.
 * Main Functions: POST {clientRef, expectedDatabaseId, payload:[PurchasePaymentItem]} -> {state, attemptId, accurateId,
 *   accurateNumber, ...}; tanpa expectedDatabaseId = 400 {claimed:false}; database sesi ≠ expectedDatabaseId = 409
 *   {code: database_changed, claimed:false, live:null} (S6b A-1, sebelum klaim). Selain itu -> {state, attemptId, accurateId,
 *   accurateNumber, message, response, persisted}; 409 {live, generation, currentGeneration} bila attempt hidup
 *   sudah ada; 409 {code: reopened_use_repost} bila subjek sudah dibuka ulang (ADR-004 rilis B, belum ada di sini).
 *   Gagal SEBELUM klaim (validasi, sesi, DB) = {claimed:false}: pasti tidak terkirim (UI tidak mengunci record).
 * Side Effects: INSERT/UPDATE accurate_write_attempt; POST purchase-payment/bulk-save.do ke Accurate.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/resolve";
import { getAccurateSession } from "@/lib/accurate-session";
import { isAllowedAccurateHost } from "@/lib/api-security";
import { forwardAccurate } from "@/lib/accurate-forward";
import {
    normalizePurchasePaymentPayload, PURCHASE_PAYMENT_OPERATION, purchasePaymentSubject, runGuardedWrite,
} from "@/lib/accurate-write-attempt";

const ENDPOINT = "/api/purchase-payment/bulk-save.do";

export async function POST(request: Request) {
    // ponytail: finance.update = gate yang sama dengan pencatatan status di FastAPI hari ini.
    // finance.post_accurate terdaftar tapi belum ditegakkan di mana pun — pemetaannya D-01/AM-042.
    const gate = await requirePermission(request, "finance.update");
    if (gate.response) return gate.response;

    const body = await request.json().catch(() => null) as { clientRef?: unknown; payload?: unknown; expectedDatabaseId?: unknown } | null;
    const normalized = normalizePurchasePaymentPayload(body?.payload);
    if ("error" in normalized) return NextResponse.json({ error: normalized.error, claimed: false }, { status: 400 });
    // Tinjauan S6b A-1: database yang DILIHAT Finance di dialog BL-03. Wajib — tanpa itu server tidak tahu database mana yang
    // disetujui (sesi bisa berganti di tab lain antara dialog dan kirim).
    const expectedDatabaseId = typeof body?.expectedDatabaseId === "string" || typeof body?.expectedDatabaseId === "number"
        ? String(body.expectedDatabaseId).trim() : "";
    if (!expectedDatabaseId) {
        return NextResponse.json({ error: "Database Accurate tujuan tidak disebut — muat ulang halaman Finance lalu ulangi. Tidak ada yang dikirim ke Accurate.", claimed: false }, { status: 400 });
    }
    // Yang dikirim, di-hash dan dijadikan subjek = objek hasil allowlist, bukan kiriman browser.
    const payload = [normalized.item];
    const clientRef = String(body?.clientRef ?? "").slice(0, 300);

    // Semua pemeriksaan yang bisa gagal SEBELUM klaim: gagal di sini = pasti tidak terkirim.
    // Tinjauan S6-0a: galat membaca sesi (DB putus, dekripsi) dulu lolos sebagai 500 -> UI mengunci record sebagai
    // TIDAK PASTI padahal tidak ada yang dikirim.
    let session: Awaited<ReturnType<typeof getAccurateSession>>;
    try {
        session = await getAccurateSession(String(gate.session.user.id));
    } catch (err) {
        console.error("[finance/purchase-payment] baca sesi Accurate gagal:", err);
        return NextResponse.json({ error: "Gagal membaca sesi Accurate — tidak ada yang dikirim ke Accurate.", claimed: false }, { status: 503 });
    }
    if (!session?.sessionHost || !session.sessionId || !session.accessToken || !session.databaseId) {
        return NextResponse.json({ error: "Sesi Accurate belum lengkap. Login dan open database Accurate dulu.", claimed: false }, { status: 400 });
    }
    if (!isAllowedAccurateHost(session.sessionHost)) {
        return NextResponse.json({ error: "Session host Accurate tidak diizinkan", claimed: false }, { status: 400 });
    }
    // Dicek di server SEBELUM klaim (cek klien saja menyisakan celah waktu): sesi berganti database sejak dialog = tolak.
    if (String(session.databaseId) !== expectedDatabaseId) {
        return NextResponse.json({
            code: "database_changed", claimed: false, live: null,
            error: `Database Accurate berganti sejak dialog dibuka (sekarang ${session.databaseAlias || `ID ${session.databaseId}`}). Tidak ada yang dikirim ke Accurate; muat ulang lalu periksa tujuan.`,
        }, { status: 409 });
    }
    const target = { sessionHost: session.sessionHost, sessionId: session.sessionId, accessToken: session.accessToken };

    let result;
    try {
        result = await runGuardedWrite({
            db,
            operation: PURCHASE_PAYMENT_OPERATION,
            subjectKey: purchasePaymentSubject(payload[0]),
            clientRef,
            targetDbId: String(session.databaseId),
            actor: String(gate.session.user.id),
            payload,
            send: () => forwardAccurate(target, ENDPOINT, "POST", payload),
        });
    } catch (err) {
        // Klaim gagal (DB) = belum ada yang dikirim.
        console.error("[finance/purchase-payment] klaim attempt gagal:", err);
        return NextResponse.json({ error: "Gagal mencatat attempt sebelum kirim — tidak ada yang dikirim ke Accurate.", claimed: false }, { status: 503 });
    }

    if (!result.claimed) {
        if (result.reopened) {
            return NextResponse.json({
                code: "reopened_use_repost",
                error: "Pembayaran untuk faktur ini sudah dibuka ulang untuk posting ulang (repost). Posting biasa ditolak — posting ulang belum tersedia di versi ini.",
                live: null, generation: result.generation, currentGeneration: result.currentGeneration,
            }, { status: 409 });
        }
        const live = result.live;
        // UI hanya boleh merekonsiliasi "posted" ke record yang SAMA pada database yang SAMA
        // (review sesi 2 M3); selain itu diperlakukan tidak pasti.
        return NextResponse.json({
            error: live?.state === "posted"
                ? `Himpunan faktur ini SUDAH diposting (${live.accurateNumber || live.accurateId}).`
                : "Ada attempt posting yang belum pasti untuk faktur ini — periksa Accurate lalu selesaikan manual.",
            live: live && {
                attemptId: live.id, state: live.state, accurateId: live.accurateId, accurateNumber: live.accurateNumber,
                targetDbId: live.targetDbId, clientRef: live.clientRef, payloadHash: live.payloadHash,
                actor: live.actor, createdAt: live.createdAt, updatedAt: live.updatedAt,
                // Record yang sama = clientRef sama. payloadHash sengaja TIDAK dibandingkan: deskripsi
                // memuat nama file bukti (uuid baru tiap upload) dan tanggal diketik ulang setelah
                // reload — kasus "browser ditutup setelah kirim" tidak akan pernah cocok (re-review N1).
                sameRecord: live.clientRef === clientRef,
                sameTarget: live.targetDbId === String(session.databaseId),
                // Tinjauan N1: basi menurut jam DB (>= 2 menit) — 'sending' basi = tidak pasti, bukan "sedang diposting".
                stale: live.stale,
            },
            // ADR-004: UI merekonsiliasi "posted" hanya bila generasi kiriman = generasi terkini.
            generation: result.generation,
            currentGeneration: result.currentGeneration,
        }, { status: 409 });
    }

    return NextResponse.json({
        attemptId: result.attemptId,
        state: result.outcome.state,
        accurateId: result.outcome.id,
        accurateNumber: result.outcome.number,
        message: result.outcome.message,
        response: result.response,
        persisted: result.persisted,
    });
}
