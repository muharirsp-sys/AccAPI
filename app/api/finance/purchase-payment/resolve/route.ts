/**
 * Tujuan: Penyelesaian manusia atas attempt purchase-payment yang TIDAK PASTI (AM-014 / C.15,
 *   DRAFT — butuh review manusia). Atestasi manual, bukan verifikasi provider.
 * Caller: app/(dashboard)/finance/page.tsx (handleResolveUnknown).
 * Dependensi: lib/accurate-write-attempt (resolveAttempt), lib/rbac/resolve.
 * Main Functions: POST (sesi Accurate = DB target) {invoiceNos[], decision:"posted"|"absent", accurateNumber, reason,
 *   checkedSource} -> {ok, state} | 404 no_open_attempt | 409 in_flight/already_posted/wrong_database/changed.
 * Side Effects: UPDATE accurate_write_attempt (state + resolution); baris lama tidak dihapus.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/resolve";
import { getAccurateSession } from "@/lib/accurate-session";
import { PURCHASE_PAYMENT_OPERATION, purchasePaymentSubject, resolveAttempt } from "@/lib/accurate-write-attempt";

export async function POST(request: Request) {
    // D-14 (owner 2026-09-30): hanya kewenangan Finance — finance.retry_post (makna di lib/rbac/registry.ts).
    // Tidak ada aturan pengirim ≠ penyelesai (belum diputuskan owner).
    const gate = await requirePermission(request, "finance.retry_post");
    if (gate.response) return gate.response;

    const b = await request.json().catch(() => null) as Record<string, unknown> | null;
    const invoiceNos = Array.isArray(b?.invoiceNos) ? b.invoiceNos.map(String).filter((x) => x.trim()) : [];
    const decision = b?.decision === "posted" || b?.decision === "absent" ? b.decision : null;
    if (!invoiceNos.length || !decision) {
        return NextResponse.json({ ok: false, error: "invoiceNos dan decision (posted|absent) wajib" }, { status: 400 });
    }

    // Yang memeriksa harus melihat database yang sama dengan target attempt (review sesi 2 M3).
    const session = await getAccurateSession(String(gate.session.user.id));
    if (!session?.databaseId) {
        return NextResponse.json({ ok: false, error: "Open database Accurate yang diperiksa dulu." }, { status: 400 });
    }
    const result = await resolveAttempt({
        db,
        operation: PURCHASE_PAYMENT_OPERATION,
        subjectKey: purchasePaymentSubject({ detailInvoice: invoiceNos.map((invoiceNo) => ({ invoiceNo, paymentAmount: 0 })) }),
        decision,
        accurateNumber: String(b!.accurateNumber ?? ""),
        reason: String(b!.reason ?? ""),
        checkedSource: String(b!.checkedSource ?? ""),
        actor: String(gate.session.user.id),
        resolverDbId: String(session.databaseId),
    });
    if (result.ok) return NextResponse.json({ ok: true, attemptId: result.attemptId, state: result.state });
    const status = result.code === "invalid" ? 400 : result.code === "no_open_attempt" ? 404 : 409;
    return NextResponse.json({ ok: false, code: result.code, error: result.message }, { status });
}
