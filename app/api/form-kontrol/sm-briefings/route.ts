/*
 * Tujuan: Daftar SPV di bawah SM + briefing mereka hari itu (ganti hardcode di Kontrol SM).
 * Caller: app/(dashboard)/form-kontrol/tabs/TabSmControl.tsx.
 * Dependensi: getSmSpvBriefings + resolveScope.
 * Akses: non-admin → di-scope ke namanya (salesName/smName); admin boleh ?smName=.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { getSmSpvBriefings, resolveScope } from "@/lib/form-kontrol";

export async function GET(req: Request) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { searchParams } = new URL(req.url);
        const date = searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
        const scope = await resolveScope(session);
        // SM diidentifikasi lewat namanya (profil anak buah menyimpan smName = nama SM).
        const smName = scope.allowedSalesCodes === null
            ? (searchParams.get("smName") ?? session.user.name ?? "")
            : (scope.smName ?? scope.salesName ?? session.user.name ?? "");
        if (!smName) return NextResponse.json({ rows: [] });

        const rows = await getSmSpvBriefings(smName, date);
        return NextResponse.json({ rows, smName });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
