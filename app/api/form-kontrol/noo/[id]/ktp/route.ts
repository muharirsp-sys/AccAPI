/*
 * Tujuan: "Lihat KTP" NOO (DATA PRIBADI, owner 13 Okt 2026): NIK lengkap + nama KTP + foto KTP SATU KALI per permintaan, dicatat
 *   kontrol_audit_log `noo/lihat_ktp` (siapa, kapan, kode NOO) SEBELUM data dikembalikan. Sengaja POST (bukan URL GET yang bisa disimpan,
 *   di-cache, atau di-prefetch); foto KTP dikirim sebagai data URL di JSON `no-store`.
 * Caller: app/(dashboard)/form-kontrol/tabs/TabNoo.tsx (dialog Lihat KTP).
 * Dependensi: lib/form-kontrol/noo (aksesNoo, lihatKtp), lib/order-cabang (jawabGalat).
 * Main Functions: POST.
 * Side Effects: INSERT kontrol_audit_log; baca berkas data/private/noo.
 *
 * Hak (lib/form-kontrol/noo hakNoo().ktp): form_kontrol.noo_ktp (grup Admin) · SPV/SM pemegang noo_setujui untuk timnya · salesman pengaju
 * selama menunggu SPV (SM = pengganti atas SPV bawahannya, owner 13 Okt malam). Admin Sales dan Manager TIDAK. Luar cakupan = 404; dalam
 * cakupan tanpa hak = 403 KTP_TIDAK_BOLEH.
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { aksesNoo, lihatKtp } from "@/lib/form-kontrol/noo";
import { jawabGalat } from "@/lib/order-cabang";

const TANPA_SIMPAN = { "Cache-Control": "no-store, private", Pragma: "no-cache" };

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const gate = await requirePermissionH("form_kontrol.view");
    if (gate.response) return gate.response;
    try {
        const { id } = await params;
        const a = await aksesNoo(gate.session, gate.perms!);
        const hasil = await lihatKtp({ id, a, aktorNama: gate.session.user.name ?? null });
        if ("galat" in hasil) return jawabGalat(hasil.galat);
        return NextResponse.json({ ok: true, kode: hasil.kode, nik: hasil.nik, namaKtp: hasil.namaKtp,
            foto: `data:image/jpeg;base64,${hasil.foto.toString("base64")}` }, { headers: TANPA_SIMPAN });
    } catch {
        return NextResponse.json({ ok: false, error: "Internal server error" }, { status: 500, headers: TANPA_SIMPAN });
    }
}
