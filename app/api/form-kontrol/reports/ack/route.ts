/*
 * Tujuan: SPV/SM acknowledge laporan harian salesman (tulis spvAck/spvAckBy/spvAckAt).
 * Caller: tombol "Acknowledge" di app/(dashboard)/form-kontrol/spv-dashboard/page.tsx.
 * Dependensi: acknowledgeReport + resolveScope.
 * Akses: admin/manager bebas; SPV/SM hanya anak buahnya (dicek di acknowledgeReport).
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { acknowledgeReport, resolveScope } from "@/lib/form-kontrol";

export async function POST(req: Request) {
    const gate = await requirePermissionH("form_kontrol.submit");
    if (gate.response) return gate.response;
    const session = gate.session;

    try {
        const { salesCode, date } = await req.json();
        if (!salesCode || !date) {
            return NextResponse.json({ error: "Missing salesCode/date" }, { status: 400 });
        }
        const scope = await resolveScope(session);
        const ok = await acknowledgeReport({
            salesCode, date,
            ackBy: session.user.name ?? session.user.id,
            supervisorName: scope.salesName ?? session.user.name ?? null,
            isAdmin: scope.allowedSalesCodes === null,
        });
        if (!ok) return NextResponse.json({ error: "Tidak berhak atau laporan belum disubmit" }, { status: 403 });
        return NextResponse.json({ success: true });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
