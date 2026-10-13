/*
 * Tujuan: Hierarki Sales Form Kontrol — SPV dan SM per salesman (tab Hierarki, admin/manager).
 * Caller: app/(dashboard)/form-kontrol/tabs/TabHierarki.tsx (GET + PUT), spv-dashboard/DashboardSpv.tsx (GET: pemilih SPV).
 * Dependensi: lib/form-kontrol (resolveScope, getAllSalesProfiles, updateSalesHierarchy, namaAkunPeran, pilihNamaAkun, kunciNama),
 *   lib/order-cabang (jawabGalat).
 * Main Functions: GET -> { rows, spvOptions, smOptions }; PUT { salesCode, spvName, smName }.
 * Side Effects: PUT mengubah sales_profile.spv_name/sm_name.
 *
 * Owner 13 Okt 2026: cakupan SPV/SM (resolveScope) = nama AKUN sesi tanpa akhiran "(SPV)"/"(SM)" dicocokkan dengan nama di sini, jadi
 * nama non-kosong WAJIB nama akun aktif ber-role itu (spvOptions/smOptions = nama akun aktif, satu per nama). Tidak ada akun = 400
 * SPV_TIDAK_DIKENAL / SM_TIDAK_DIKENAL; dua akun bernama sama = 409 NAMA_GANDA; disimpan ejaan akun; kosong/null = melepas.
 * Hanya cakupan global (admin/manager/admin_sales) — selain itu 403.
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { getAllSalesProfiles, kunciNama, namaAkunPeran, pilihNamaAkun, resolveScope, updateSalesHierarchy } from "@/lib/form-kontrol";
import { jawabGalat } from "@/lib/order-cabang";

/** Satu opsi per nama (kunciNama); nama ganda tetap ditawarkan sekali — PUT menolaknya dengan NAMA_GANDA. */
const unik = (nama: string[]) => [...new Map(nama.map((n) => [kunciNama(n), n])).values()];

export async function GET() {
    const gate = await requirePermissionH("form_kontrol.manage");
    if (gate.response) return gate.response;
    const session = gate.session;
    const scope = await resolveScope(session);
    if (scope.allowedSalesCodes !== null) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    try {
        const [rows, spv, sm] = await Promise.all([getAllSalesProfiles(), namaAkunPeran("spv"), namaAkunPeran("sm")]);
        return NextResponse.json({ rows, spvOptions: unik(spv), smOptions: unik(sm) });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

export async function PUT(req: Request) {
    const gate = await requirePermissionH("form_kontrol.manage");
    if (gate.response) return gate.response;
    const session = gate.session;
    const scope = await resolveScope(session);
    if (scope.allowedSalesCodes !== null) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    try {
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        const salesCode = typeof body?.salesCode === "string" ? body.salesCode.trim() : "";
        if (!body || !salesCode) return NextResponse.json({ error: "Missing salesCode" }, { status: 400 });
        const [akunSpv, akunSm] = await Promise.all([namaAkunPeran("spv"), namaAkunPeran("sm")]);
        const spv = pilihNamaAkun(body.spvName, akunSpv, "SPV");
        if ("galat" in spv) return jawabGalat(spv.galat);
        const sm = pilihNamaAkun(body.smName, akunSm, "SM");
        if ("galat" in sm) return jawabGalat(sm.galat);
        await updateSalesHierarchy(salesCode, spv.nama, sm.nama);
        return NextResponse.json({ success: true, spvName: spv.nama, smName: sm.nama });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
