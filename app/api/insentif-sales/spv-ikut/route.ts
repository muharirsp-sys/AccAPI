/*
 * Tujuan: Tombol per SPV × principal — principal tetap dihitung untuk insentif SPV walau SEMUA
 *   sales bawahannya berstatus "principle" (sales dibayar principal, SPV dibayar distributor).
 * Caller: app/(dashboard)/insentif-sales/page.tsx → SpvSupportInputSection.
 * Dependensi: lib/insentif-settings (spvIkutKey, pasanganKey, getDaftar, toggleDaftar),
 *   lib/rbac/resolve, lib/insentif-hierarchy-scope (canSeeAllInsentif).
 * Main Functions: GET daftar periode; PATCH { spvName, principle, periodMonth, periodYear, ikut }.
 * Side Effects: PATCH menulis app_setting dan MENGUBAH NOMINAL SPV itu pada periode itu saja
 *   (jumlah principal valid naik → rate per principal berubah). Dibaca spv-dashboard.
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { canSeeAllInsentif } from "@/lib/insentif-hierarchy-scope";
import { spvIkutKey, pasanganKey, getDaftar, toggleDaftar } from "@/lib/insentif-settings";

const periodeSah = (bulan: number, tahun: number) =>
    Number.isInteger(bulan) && bulan >= 1 && bulan <= 12 && Number.isInteger(tahun) && tahun >= 2020 && tahun <= 2100;

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;
    const bulan = Number(req.nextUrl.searchParams.get("month"));
    const tahun = Number(req.nextUrl.searchParams.get("year"));
    if (!periodeSah(bulan, tahun)) return NextResponse.json({ error: "Periode tidak valid." }, { status: 400 });
    return NextResponse.json({ ikut: await getDaftar(spvIkutKey(bulan, tahun), []) });
}

export async function PATCH(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.upload_target");
    if (gate.response) return gate.response;
    // Tombol ini MENAIKKAN nominal SPV. SPV/SM yang ter-scope tidak boleh menyalakannya untuk
    // dirinya sendiri — hanya pemegang izin lihat-semua (admin/Finance).
    if (!canSeeAllInsentif(gate.perms)) {
        return NextResponse.json({ error: "Hanya admin/Finance yang boleh mengubah hitungan principal SPV." }, { status: 403 });
    }

    let body: Record<string, unknown>;
    try {
        body = (await req.json()) ?? {};
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const spvName = typeof body.spvName === "string" ? body.spvName.trim() : "";
    const principle = typeof body.principle === "string" ? body.principle.trim() : "";
    const bulan = Number(body.periodMonth);
    const tahun = Number(body.periodYear);
    const ikut = body.ikut;
    if (!spvName || !principle) {
        return NextResponse.json({ error: "Nama SPV dan Principal wajib diisi." }, { status: 400 });
    }
    if (!periodeSah(bulan, tahun)) return NextResponse.json({ error: "Periode tidak valid." }, { status: 400 });
    // Boolean ketat: "false" (string) yang lolos sebagai truthy akan MENYALAKAN tombolnya.
    if (typeof ikut !== "boolean") return NextResponse.json({ error: "ikut harus true/false." }, { status: 400 });

    const hasil = await toggleDaftar(spvIkutKey(bulan, tahun), pasanganKey(spvName, principle), ikut, gate.session.user.id);
    return NextResponse.json({ ikut: hasil });
}
