/*
 * Tujuan: SPV/SM acknowledge laporan harian salesman (tulis spvAck/spvAckBy/spvAckAt).
 * Caller: tombol "Acknowledge" di app/(dashboard)/form-kontrol/spv-dashboard/page.tsx.
 * Dependensi: acknowledgeReport + resolveScope.
 * Akses: admin/manager bebas; SPV/SM hanya anak buahnya (dicek di acknowledgeReport).
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { acknowledgeReport, resolveScope } from "@/lib/form-kontrol";

export async function POST(req: Request) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
