/*
 * Tujuan: Konfirmasi kunjungan LUAR RUTE di akhir sesi (FK-MSM2): salesman memasukkan toko ke JKS miliknya (hari Senin–Sabtu + minggu
 *   ganjil/genap/setiap minggu) atau "jangan masukkan JKS". "Nanti" = tidak memanggil route ini (baris tetap menunggu).
 * Caller: app/(dashboard)/form-kontrol/tabs/LuarRute.tsx (KonfirmasiLuarRute di Laporan harian).
 * Dependensi: lib/form-kontrol (resolveScope, periksaKeputusan, konfirmasiLuarRute), lib/order-cabang (jawabGalat).
 * Main Functions: POST { id, salesCode, keputusan: "jks" | "tidak", hari?, mingguPattern? }.
 * Side Effects: UPDATE kunjungan_luar_rute; "jks" = INSERT/UPDATE jks_master (kode pelanggan Accurate LENGKAP); kontrol_audit_log.
 *
 * HANYA salesman pemilik (owner: salesman langsung mengonfirmasi, tanpa persetujuan SPV) → selain itu 403 BUKAN_PEMILIK. Toko yang sudah di
 * JKS salesman ini → baris jadi sudah_jks lalu 409 SUDAH_DI_JKS; "jks" tanpa kunjungan nyata → 409 BELUM_DIKUNJUNGI;
 * toko di JKS salesman LAIN → tetap ditulis, `jksLain` dikembalikan sebagai peringatan (layar sudah menampilkannya).
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { konfirmasiLuarRute, periksaKeputusan, resolveScope } from "@/lib/form-kontrol";
import { jawabGalat } from "@/lib/order-cabang";

export async function POST(req: Request) {
    const gate = await requirePermissionH("form_kontrol.submit");
    if (gate.response) return gate.response;
    const session = gate.session;
    try {
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        const id = typeof body?.id === "string" ? body.id.trim() : "";
        const salesCode = typeof body?.salesCode === "string" ? body.salesCode.trim() : "";
        if (!body || !id || !salesCode) return jawabGalat({ status: 400, kode: "INPUT_TIDAK_VALID", error: "Kunjungan dan kode sales wajib." });
        const keputusan = periksaKeputusan(body);
        if ("error" in keputusan) return jawabGalat({ status: 400, kode: "KEPUTUSAN_TIDAK_SAH", error: keputusan.error });
        const scope = await resolveScope(session);
        if (scope.salesCode !== salesCode) {
            return jawabGalat({ status: 403, kode: "BUKAN_PEMILIK", error: "Kunjungan luar rute dikonfirmasi oleh salesman pemiliknya dari akunnya sendiri." });
        }
        const hasil = await konfirmasiLuarRute({ id, salesCode, keputusan, aktorId: String(session.user.id), aktorNama: session.user.name ?? null });
        if ("galat" in hasil) return jawabGalat(hasil.galat);
        return NextResponse.json({ ok: true, row: hasil.row, jksLain: hasil.jksLain });
    } catch {
        return NextResponse.json({ ok: false, error: "Internal server error" }, { status: 500 });
    }
}
