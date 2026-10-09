import { NextRequest, NextResponse } from "next/server";
import { isAllowedAccurateHost, requireApiSession } from "@/lib/api-security";
import { getAccurateSession } from "@/lib/accurate-session";
import { accurateTimeoutMessage, forwardAccurate, isGuardedAccurateWrite, isSalesReceiptWrite } from "@/lib/accurate-forward";
import { authorizeSalesReceiptWrite, checkSalesReceiptWrite, sendSalesReceipt, type SalesReceiptDispatch } from "@/lib/sales-receipt-guard";
import { db } from "@/lib/db";

export async function POST(req: NextRequest) {
    let requestMethod = "";
    try {
        const authCheck = await requireApiSession(req);
        if (authCheck.response) return authCheck.response;

        const body = await req.json();
        const { endpointPath, method, payload } = body;
        requestMethod = typeof method === "string" ? method : "";
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
        // ini yang mencakup setiap baris (atau override Finance tercatat). Pemeriksaan murni SEBELUM sesi & DB.
        const salesReceipt = isSalesReceiptWrite(endpointPath);
        const write = { lockId: body.idempotencyLockId, userId: String(authCheck.session.user.id), payload, endpointPath, method };
        if (salesReceipt) {
            const bad = checkSalesReceiptWrite(write);
            if (bad) return NextResponse.json({ error: bad, code: "SALES_RECEIPT_LOCK_REQUIRED" }, { status: 409 });
        }
        const accurateSession = await getAccurateSession(String(authCheck.session.user.id));
        const sessionHost = accurateSession?.sessionHost;
        const sessionId = accurateSession?.sessionId;
        const apiKey = accurateSession?.accessToken;

        if (!endpointPath || !method || !sessionHost || !sessionId || !apiKey || !isAllowedAccurateHost(sessionHost)) {
            // Tanpa sesi tidak ada yang dikirim: guard dinilai TANPA menulis (override & lock tidak hangus).
            if (salesReceipt) {
                const denied = await authorizeSalesReceiptWrite(db, write, { dryRun: true });
                if (typeof denied === "string") return NextResponse.json({ error: denied, code: "SALES_RECEIPT_LOCK_REQUIRED" }, { status: 409 });
            }
            return NextResponse.json({ error: sessionHost && !isAllowedAccurateHost(sessionHost)
                ? "Session host Accurate tidak diizinkan"
                : "Sesi Accurate belum lengkap. Login dan pilih database terlebih dahulu." }, { status: 400 });
        }
        // Re-review d60433f2 MEDIUM: baris ditandai SENDING (dan override dihabiskan) sebelum kirim; hasilnya
        // dicatat server di bawah — kirim ulang dengan lock yang sama / laporan FAILED palsu tidak lolos lagi.
        let dispatch: SalesReceiptDispatch | null = null;
        if (salesReceipt) {
            const r = await authorizeSalesReceiptWrite(db, write);
            if (typeof r === "string") return NextResponse.json({ error: r, code: "SALES_RECEIPT_LOCK_REQUIRED" }, { status: 409 });
            dispatch = r;
        }

        // Audit F5: log tanpa query string (bisa berisi data bisnis).
        console.log(`[PROXY FIRE] ${String(method).toUpperCase()} ${endpointPath}`);

        // Hasil per baris sales-receipt dicatat SERVER di sendSalesReceipt (timeout/non-JSON/5xx = UNKNOWN).
        const { status, text: rawText, json, data } = await sendSalesReceipt(db, dispatch,
            () => forwardAccurate({ sessionHost, sessionId, accessToken: apiKey }, endpointPath, method, payload));
        if (!json) {
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
            return NextResponse.json({ error: accurateTimeoutMessage(requestMethod) }, { status: 504 });
        }
        console.error("[PROXY SERVER INTERNAL ERROR]", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Proxy request failed" }, { status: 500 });
    }
}
