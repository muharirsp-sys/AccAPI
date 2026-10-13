/*
 * Tujuan: Daftar SPV di bawah SM + briefing mereka hari itu (ganti hardcode di Kontrol SM).
 * Caller: app/(dashboard)/form-kontrol/tabs/TabSmControl.tsx.
 * Dependensi: getSmSpvBriefings + resolveScope.
 * Akses: SM → namanya sendiri (sesi); admin boleh ?smName=; peran lain 403 (FK-MSM putaran 2).
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { getSmSpvBriefings, namaDalamCakupan, namaSmBoleh, resolveScope } from "@/lib/form-kontrol";

export async function GET(req: Request) {
    const gate = await requirePermissionH("form_kontrol.view");
    if (gate.response) return gate.response;
    const session = gate.session;

    try {
        const { searchParams } = new URL(req.url);
        const date = searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
        const scope = await resolveScope(session);
        // SM diidentifikasi lewat namanya (profil anak buah menyimpan smName = nama SM).
        const pilih = namaDalamCakupan(namaSmBoleh(scope), scope.allowedSalesCodes === null ? searchParams.get("smName") : null);
        if ("tolak" in pilih) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        const smName = pilih.nama ?? session.user.name ?? "";
        if (!smName) return NextResponse.json({ rows: [] });

        const rows = await getSmSpvBriefings(smName, date);
        return NextResponse.json({ rows, smName });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
