/*
 * Tujuan: Hapus JKS (owner 14 Nov 2026: "hapus semua JKS yang ada agar saya bisa upload ulang JKS yang benar").
 *   GET  -> ringkasan JKS aktif per principal { rows: [{ principle, aktif, tambahan }] } untuk dialog.
 *   POST { principle: string | null (null = semua principal), pertahankanTambahan: boolean, konfirmasi: "HAPUS" } -> { jumlah, perPrincipal }.
 * Caller: app/(dashboard)/form-kontrol/tabs/TabJks.tsx (dialog Hapus JKS).
 * Dependensi: lib/form-kontrol (ringkasanJksAktif, hapusJks, writeKontrolAudit), lib/rbac/resolve (form_kontrol.manage, sama dengan Impor JKS).
 * Side Effects: UPDATE jks_master SET is_active = false (BUKAN DELETE; unggah ulang menghidupkan baris yang ada di berkas) + kontrol_audit_log.
 *   Tidak menyentuh ao_control_daily, kunjungan_luar_rute, toko_koordinat, atau Accurate.
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { KATA_HAPUS_JKS, hapusJks, ringkasanJksAktif, writeKontrolAudit } from "@/lib/form-kontrol";

export async function GET() {
    const gate = await requirePermissionH("form_kontrol.manage");
    if (gate.response) return gate.response;
    try {
        return NextResponse.json({ rows: await ringkasanJksAktif() });
    } catch {
        return NextResponse.json({ error: "Ringkasan JKS belum berhasil dimuat." }, { status: 500 });
    }
}

export async function POST(req: Request) {
    const gate = await requirePermissionH("form_kontrol.manage");
    if (gate.response) return gate.response;
    try {
        const body = await req.json().catch(() => null) as { principle?: unknown; pertahankanTambahan?: unknown; konfirmasi?: unknown } | null;
        if (!body || String(body.konfirmasi ?? "").trim().toUpperCase() !== KATA_HAPUS_JKS) {
            return NextResponse.json({ kode: "KONFIRMASI_WAJIB", error: `Ketik ${KATA_HAPUS_JKS} untuk menghapus JKS.` }, { status: 400 });
        }
        const principle = typeof body.principle === "string" && body.principle.trim() ? body.principle.trim() : null;
        if (body.principle != null && !principle) return NextResponse.json({ kode: "INPUT_TIDAK_VALID", error: "Principal tidak terbaca." }, { status: 400 });
        const pertahankanTambahan = body.pertahankanTambahan !== false;
        // Satu UPDATE (atomik): galat di sini = tidak ada baris yang berubah.
        let hasil: Awaited<ReturnType<typeof hapusJks>>;
        try { hasil = await hapusJks({ principle, pertahankanTambahan }); } catch {
            return NextResponse.json({ error: "JKS belum berhasil dihapus; tidak ada yang berubah. Coba lagi." }, { status: 500 });
        }
        // Jejak audit gagal tidak membatalkan hapus yang sudah tersimpan (layar tetap menerima hasilnya).
        let jejak = true;
        try {
            await writeKontrolAudit("jks", principle ?? "semua", "hapus", gate.session.user.id, gate.session.user.name ?? null,
                { principle, pertahankanTambahan, ...hasil });
        } catch { jejak = false; }
        return NextResponse.json({ success: true, ...hasil, jejakAudit: jejak });
    } catch {
        return NextResponse.json({ error: "Permintaan hapus JKS tidak terbaca; tidak ada yang berubah." }, { status: 500 });
    }
}
