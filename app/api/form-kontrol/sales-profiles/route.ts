/*
 * Tujuan: Hierarki Sales Form Kontrol — SPV dan SM per salesman (tab Hierarki, admin/manager).
 * Caller: app/(dashboard)/form-kontrol/tabs/TabHierarki.tsx (GET + PUT), spv-dashboard/DashboardSpv.tsx (GET: pemilih SPV).
 * Dependensi: lib/form-kontrol (resolveScope, getAllSalesProfiles, updateSalesHierarchy, namaAkunPeran, pilihNamaAkun, kunciNama),
 *   lib/order-cabang (jawabGalat).
 * Main Functions: GET -> { rows (+ noHp), spvOptions, smOptions }; PUT { salesCode, spvName, smName, noHp? }.
 * Side Effects: PUT mengubah sales_profile.spv_name/sm_name/no_hp.
 *
 * Supervisor Review (owner 16 Okt 2026, kontrak lib/supervisor-review/kontrak.ts HierarkiNoHp): `noHp` opsional — kunci absen = tidak diubah;
 * null/"" = hapus; selain itu dinormalkan ke 08… (normalHp, sama dengan NOO), tidak sah = 400 NO_HP_TIDAK_SAH. Kiriman berisi noHp TANPA
 * spvName dan smName hanya mengubah No HP (hierarki tidak dilepas diam-diam).
 *
 * Owner 13 Okt 2026: cakupan SPV/SM (resolveScope) = nama AKUN sesi tanpa akhiran "(SPV)"/"(SM)" dicocokkan dengan nama di sini, jadi
 * nama non-kosong WAJIB nama akun aktif ber-role itu (spvOptions/smOptions = nama akun aktif, satu per nama). Tidak ada akun = 400
 * SPV_TIDAK_DIKENAL / SM_TIDAK_DIKENAL; dua akun bernama sama = 409 NAMA_GANDA; disimpan ejaan akun; kosong/null = melepas; kode sales
 * tanpa profil = 404 PROFIL_TIDAK_ADA (bukan 200 tanpa tulis).
 * Hanya cakupan global (admin/manager/admin_sales) — selain itu 403.
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { getAllSalesProfiles, kunciNama, namaAkunPeran, pilihNamaAkun, resolveScope, updateSalesHierarchy } from "@/lib/form-kontrol";
import { jawabGalat } from "@/lib/order-cabang";
import { normalHp } from "@/lib/form-kontrol/noo-aturan";

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
        const adaHp = "noHp" in body;
        const kosong = body.noHp === null || body.noHp === undefined || (typeof body.noHp === "string" && !body.noHp.trim());
        const noHp = !adaHp ? undefined : kosong ? null : typeof body.noHp === "string" ? normalHp(body.noHp) : null;
        if (adaHp && !kosong && !noHp) {
            return jawabGalat({ status: 400, kode: "NO_HP_TIDAK_SAH", error: "No HP harus nomor seluler Indonesia (08…, +62…), 10–13 angka." });
        }
        let spvNama: string | null | undefined, smNama: string | null | undefined;
        if (!adaHp || "spvName" in body || "smName" in body) {
            const [akunSpv, akunSm] = await Promise.all([namaAkunPeran("spv"), namaAkunPeran("sm")]);
            const spv = pilihNamaAkun(body.spvName, akunSpv, "SPV");
            if ("galat" in spv) return jawabGalat(spv.galat);
            const sm = pilihNamaAkun(body.smName, akunSm, "SM");
            if ("galat" in sm) return jawabGalat(sm.galat);
            [spvNama, smNama] = [spv.nama, sm.nama];
        }
        if (!await updateSalesHierarchy(salesCode, spvNama, smNama, noHp)) {
            return jawabGalat({ status: 404, kode: "PROFIL_TIDAK_ADA", error: `Profil sales ${salesCode} tidak ditemukan; muat ulang Hierarki.` });
        }
        return NextResponse.json({ success: true, spvName: spvNama, smName: smNama, ...(adaHp && { noHp }) });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
