import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { getSmControl, namaDalamCakupan, namaSmBoleh, resolveScope, saveSmControl } from "@/lib/form-kontrol";

// FK-MSM putaran 2: nama SM dari sesi — SM hanya atas namanya, admin/manager/admin_sales semua, peran lain 403; nama klien lain = 403.

export async function GET(req: Request) {
    const gate = await requirePermissionH("form_kontrol.view");
    if (gate.response) return gate.response;
    const session = gate.session;

    try {
        const { searchParams } = new URL(req.url);
        const pilih = namaDalamCakupan(namaSmBoleh(await resolveScope(session)), searchParams.get("smName"));
        if ("tolak" in pilih) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        const smName = pilih.nama ?? session.user.name ?? "";
        const today = new Date();
        const dateStr = searchParams.get("date") ??
            `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

        const rows = await getSmControl(smName, dateStr);
        return NextResponse.json({ rows, total: rows.length });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

export async function POST(req: Request) {
    const gate = await requirePermissionH("form_kontrol.submit");
    if (gate.response) return gate.response;
    const session = gate.session;

    try {
        const body = await req.json();
        const { date, spvChecked, jksChecked, fotoChecked, coachingNote, deviations, followUp } = body;
        if (!date) {
            return NextResponse.json({ error: "Missing required fields (smName, date)" }, { status: 400 });
        }
        const pilih = namaDalamCakupan(namaSmBoleh(await resolveScope(session)), body.smName);
        if ("tolak" in pilih) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        if (!pilih.nama) return NextResponse.json({ error: "Missing required fields (smName, date)" }, { status: 400 });
        const id = await saveSmControl({
            smName: pilih.nama, date, spvChecked, jksChecked, fotoChecked,
            coachingNote, deviations, followUp, createdBy: session.user.id,
        });
        return NextResponse.json({ success: true, id });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
