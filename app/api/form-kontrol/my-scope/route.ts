import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { getJksPrinciples, resolveScope } from "@/lib/form-kontrol";
import { cakupanCabang } from "@/lib/order-cabang";

export async function GET() {
    const gate = await requirePermissionH("form_kontrol.view");
    if (gate.response) return gate.response;
    const session = gate.session;

    try {
        const scope = await resolveScope(session);
        // FK-MSM butir 1: principal = JKS aktif milik cakupan (salesman: miliknya; SPV: timnya; admin: semua). [] = belum ada JKS.
        const principles = await getJksPrinciples(scope.allowedSalesCodes);
        // FK-MSM2: salesman TANPA JKS (mis. salesman baru) tetap bisa menambah kunjungan luar rute dengan principal = nama cabang karyawan
        // Accurate-nya (cakupan O1). Tautan belum ada/galat = principalCabang null + alasannya (layar menjelaskan, bukan buntu diam).
        let principalCabang: string | null = null, alasanCabang: string | null = null;
        if (scope.salesCode && principles.length === 0) {
            const c = await cakupanCabang(String(session.user.id), gate.perms!);
            if ("galat" in c) alasanCabang = c.galat.error;
            else if (!c.cakupan.semua && c.cakupan.branchName) principalCabang = c.cakupan.branchName;
        }
        return NextResponse.json({ ...scope, principles, principalCabang, alasanCabang });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
