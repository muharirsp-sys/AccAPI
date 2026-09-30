import { NextRequest, NextResponse } from "next/server";
import { isAllowedAccurateHost, requireApiSession } from "@/lib/api-security";
import { getAccurateSession } from "@/lib/accurate-session";
import { forwardAccurate, isGuardedAccurateWrite, isSalesReceiptWrite } from "@/lib/accurate-forward";
import { authorizeSalesReceiptWrite } from "@/lib/sales-receipt-guard";
import { db } from "@/lib/db";

export async function POST(req: NextRequest) {
    try {
        const authCheck = await requireApiSession(req);
        if (authCheck.response) return authCheck.response;

        const body = await req.json();
        const { endpointPath, method, payload } = body;
        if (typeof endpointPath !== "string" || typeof method !== "string") {
            return NextResponse.json({ error: "endpointPath dan method wajib teks" }, { status: 400 });
        }
        // AM-014 / C.14: tulis purchase-payment hanya lewat command server yang mengklaim attempt
        // sebelum kirim; lewat proxy generik guard pengiriman ganda bisa dilewati.
        if (endpointPath && isGuardedAccurateWrite(String(endpointPath))) {
            return NextResponse.json({
                error: "Posting purchase-payment hanya lewat halaman Finance (pencegahan posting ganda). Proxy generik menolak operasi ini.",
            }, { status: 403 });
        }
        // AM-024 (owner D-18): tulis sales-receipt tidak boleh melewati idempotency — wajib lock milik user
        // ini yang mencakup setiap baris (atau override Finance tercatat). Diperiksa SEBELUM sesi & kirim.
        if (isSalesReceiptWrite(endpointPath)) {
            const denied = await authorizeSalesReceiptWrite(db, {
                lockId: body.idempotencyLockId, userId: String(authCheck.session.user.id), payload,
            });
            if (denied) return NextResponse.json({ error: denied, code: "SALES_RECEIPT_LOCK_REQUIRED" }, { status: 409 });
        }
        const accurateSession = await getAccurateSession(String(authCheck.session.user.id));
        const sessionHost = accurateSession?.sessionHost;
        const sessionId = accurateSession?.sessionId;
        const apiKey = accurateSession?.accessToken;

        if (!endpointPath || !method || !sessionHost || !sessionId || !apiKey) {
            return NextResponse.json({ error: "Sesi Accurate belum lengkap. Login dan pilih database terlebih dahulu." }, { status: 400 });
        }
        if (!isAllowedAccurateHost(sessionHost)) {
            return NextResponse.json({ error: "Session host Accurate tidak diizinkan" }, { status: 400 });
        }

        // Audit F5: log tanpa query string (bisa berisi data bisnis).
        console.log(`[PROXY FIRE] ${String(method).toUpperCase()} ${endpointPath}`);

        const { status, text: rawText } = await forwardAccurate({ sessionHost, sessionId, accessToken: apiKey }, endpointPath, method, payload);
        let data: unknown;

        try {
            data = JSON.parse(rawText);
        } catch (e) {
            console.error("[ACCURATE API RETURNED NON-JSON]", rawText);
            return NextResponse.json({ error: "Accurate mengembalikan respons non-JSON (Gagal)", detail: rawText.substring(0, 1000) }, { status: 502 });
        }

        // SERVER LOG FOR DEBUGGING
        const accurateResult = data as { s?: boolean };
        if (status < 200 || status >= 300 || !accurateResult.s) {
            console.error("[ACCURATE API ERROR FORMAT JSON]", JSON.stringify(data, null, 2));
        }

        return NextResponse.json(data);
    } catch (error: unknown) {
        if (error instanceof Error && error.name === "TimeoutError") {
            return NextResponse.json({ error: "Accurate tidak merespons dalam 30 detik (timeout). Coba lagi." }, { status: 504 });
        }
        console.error("[PROXY SERVER INTERNAL ERROR]", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Proxy request failed" }, { status: 500 });
    }
}
