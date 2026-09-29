/**
 * Tujuan: Command server posting purchase-payment Finance ke Accurate (AM-014 / C.12, DRAFT
 *   zona Accurate write — butuh review manusia). Attempt diklaim di Postgres SEBELUM kirim.
 * Caller: app/(dashboard)/finance/page.tsx (approveTransfer).
 * Dependensi: lib/accurate-write-attempt, lib/accurate-forward, lib/accurate-session, lib/rbac/resolve.
 * Main Functions: POST {clientRef, payload:[PurchasePaymentItem]} -> {state, attemptId, accurateId,
 *   accurateNumber, message, response, persisted}; 409 {live} bila attempt hidup sudah ada.
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

    const body = await request.json().catch(() => null) as { clientRef?: unknown; payload?: unknown } | null;
    const normalized = normalizePurchasePaymentPayload(body?.payload);
    if ("error" in normalized) return NextResponse.json({ error: normalized.error }, { status: 400 });
    // Yang dikirim, di-hash dan dijadikan subjek = objek hasil allowlist, bukan kiriman browser.
    const payload = [normalized.item];
    const clientRef = String(body?.clientRef ?? "").slice(0, 300);

    // Semua pemeriksaan yang bisa gagal SEBELUM klaim: gagal di sini = pasti tidak terkirim.
    const session = await getAccurateSession(String(gate.session.user.id));
    if (!session?.sessionHost || !session.sessionId || !session.accessToken || !session.databaseId) {
        return NextResponse.json({ error: "Sesi Accurate belum lengkap. Login dan open database Accurate dulu." }, { status: 400 });
    }
    if (!isAllowedAccurateHost(session.sessionHost)) {
        return NextResponse.json({ error: "Session host Accurate tidak diizinkan" }, { status: 400 });
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
        return NextResponse.json({ error: "Gagal mencatat attempt sebelum kirim — tidak ada yang dikirim ke Accurate." }, { status: 503 });
    }

    if (!result.claimed) {
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
            },
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
