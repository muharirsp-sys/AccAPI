/*
 * Tujuan: Tombol per baris — AO satu baris GT/TT dinilai terhadap Target AO di file target,
 *   bukan ambang 240, tanpa memindah setelan global.
 * Caller: app/(dashboard)/insentif-sales/page.tsx → SupportInputSection (kolom Ambang AO).
 * Dependensi: lib/insentif-settings (aoFileKey, pasanganKey, toggleDaftar),
 *   lib/rbac/resolve, lib/insentif-hierarchy-scope.
 * Main Functions: PATCH { salesCode, principle, periodMonth, periodYear, pakaiFile }.
 * Side Effects: Menulis app_setting dan MENGUBAH NOMINAL AO baris itu pada periode itu saja.
 *   Izin & cakupan sama dengan ubah Status Insentif per baris (targets/status).
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { getScopeForUser } from "@/lib/insentif-hierarchy-scope";
import { aoFileKey, pasanganKey, toggleDaftar } from "@/lib/insentif-settings";

export async function PATCH(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.upload_target");
    if (gate.response) return gate.response;

    let body: Record<string, unknown>;
    try {
        body = (await req.json()) ?? {};
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const salesCode = typeof body.salesCode === "string" ? body.salesCode.trim() : "";
    const principle = typeof body.principle === "string" ? body.principle.trim() : "";
    const bulan = Number(body.periodMonth);
    const tahun = Number(body.periodYear);
    if (!salesCode || !principle) {
        return NextResponse.json({ error: "Kode Salesman dan Principal wajib diisi." }, { status: 400 });
    }
    if (!Number.isInteger(bulan) || bulan < 1 || bulan > 12 || !Number.isInteger(tahun) || tahun < 2020 || tahun > 2100) {
        return NextResponse.json({ error: "Periode tidak valid." }, { status: 400 });
    }
    // Boolean ketat: "false" (string) yang lolos sebagai truthy akan MENYALAKAN tombolnya.
    if (typeof body.pakaiFile !== "boolean") {
        return NextResponse.json({ error: "pakaiFile harus true/false." }, { status: 400 });
    }

    const scope = await getScopeForUser(gate.session.user.id, { month: bulan, year: tahun }, gate.perms);
    if (scope !== null && !scope.has(salesCode)) {
        return NextResponse.json({ error: `Baris ${salesCode}: di luar cakupan tim Anda.` }, { status: 403 });
    }

    const pakaiFile = await toggleDaftar(aoFileKey(bulan, tahun), pasanganKey(salesCode, principle), body.pakaiFile, gate.session.user.id);
    return NextResponse.json({ pakaiFile });
}
