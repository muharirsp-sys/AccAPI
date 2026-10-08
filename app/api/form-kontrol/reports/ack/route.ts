/*
 * Tujuan: SPV/SM acknowledge laporan harian salesman (tulis spvAck/spvAckBy/spvAckAt),
 *   atau batalkan dengan body `ack: false` (S5-4a); keduanya tercatat di kontrol_audit_log.
 * Caller: tombol "Acknowledge" di app/(dashboard)/form-kontrol/spv-dashboard/page.tsx.
 * Dependensi: acknowledgeReport + resolveScope.
 * Akses: admin/manager bebas; SPV/SM hanya anak buahnya (dicek di acknowledgeReport).
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { acknowledgeReport, resolveScope, writeKontrolAudit } from "@/lib/form-kontrol";

export async function POST(req: Request) {
    const gate = await requirePermissionH("form_kontrol.submit");
    if (gate.response) return gate.response;
    const session = gate.session;

    try {
        const { salesCode, date, ack } = await req.json();
        if (!salesCode || !date) {
            return NextResponse.json({ error: "Missing salesCode/date" }, { status: 400 });
        }
        if (ack !== undefined && typeof ack !== "boolean") {
            return NextResponse.json({ error: "ack harus true/false" }, { status: 400 });
        }
        const scope = await resolveScope(session);
        const ok = await acknowledgeReport({
            salesCode, date,
            ackBy: session.user.name ?? session.user.id,
            supervisorName: scope.salesName ?? session.user.name ?? null,
            isAdmin: scope.allowedSalesCodes === null,
            ack,
        });
        if (!ok) return NextResponse.json({ error: "Tidak berhak atau laporan belum disubmit" }, { status: 403 });
        await writeKontrolAudit("report", ok.id, ack === false ? "ack_cancel" : "ack", session.user.id, session.user.name ?? null,
            { salesCode, date, prevAckBy: ok.prevAckBy, prevAckAt: ok.prevAckAt });
        return NextResponse.json({ success: true });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
