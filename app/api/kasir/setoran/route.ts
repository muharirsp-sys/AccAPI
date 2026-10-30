/*
 * Tujuan: Catat/koreksi setoran Kasir per ORANG per hari (K2a, BL-59): Tunai/Transfer/Giro (teks ≤ 2 desimal), Form Kasir wajib bila
 *   > 0, bukti Transfer WAJIB (unggah jpg/png/pdf, magic bytes, ≤ 5 MB) atau bukti revisi sebelumnya, Giro wajib nomor BG + jatuh tempo.
 * Caller: K2b dialog `setoran` di /kasir. Kontrak: docs/handover/KASIR-KONTRAK.md §8.4.
 * Dependensi: lib/kasir/hari (uraiSetoran, catatSetoran), lib/kasir/bukti (jenisBukti, simpanBukti, hapusBukti), lib/rbac/resolve (kasir.catat).
 * Main Functions: POST JSON | multipart (data + bukti; badan ≤ 6 MB dibaca bertahap, juga chunked) -> 200 { orang, revisi[], buktiUrl } |
 *   400 INPUT_SALAH | 413 BADAN_TERLALU_BESAR | 409 SETORAN_BERUBAH /
 *   HARI_TERKUNCI | 500 GALAT_INTERNAL | 502 TIDAK_PASTI.
 * Side Effects: tulis berkas bukti (data/uploads/kasir-bukti, SEBELUM transaksi; dihapus bila galat pasti) + INSERT kasir_setoran
 *   (semua baris rencana satu transaksi). TANPA Accurate.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { bawaanHari, catatSetoran, GalatKasir, jawabanGalat, uraiSetoran } from "@/lib/kasir/hari";
import {
    BadanTerlaluBesar, bacaBadanTerbatas, BuktiRusak, hapusBukti, jenisBukti, MAKS_BADAN_SETORAN_BYTES, MAKS_BUKTI_BYTES, normalkanBukti, simpanBukti,
} from "@/lib/kasir/bukti";

export const runtime = "nodejs";

const salahBukti = (pesan: string) => new GalatKasir(400, "INPUT_SALAH", pesan, { field: "buktiTransfer" });

async function badan(request: NextRequest): Promise<{ raw: unknown; berkas: File | null }> {
    let isi: Uint8Array;
    try {
        isi = await bacaBadanTerbatas(request, MAKS_BADAN_SETORAN_BYTES);
    } catch (e) {
        if (!(e instanceof BadanTerlaluBesar)) throw e;
        throw new GalatKasir(413, "BADAN_TERLALU_BESAR", "Permintaan terlalu besar. Berkas bukti maksimal 5 MB.", { field: "buktiTransfer" });
    }
    const jenis = request.headers.get("content-type") || "";
    if (!jenis.toLowerCase().startsWith("multipart/form-data")) {
        try { return { raw: JSON.parse(new TextDecoder().decode(isi)), berkas: null }; } catch { return { raw: null, berkas: null }; }
    }
    const fd = await new Response(isi as BodyInit, { headers: { "content-type": jenis } }).formData().catch(() => null);
    if (!fd) throw new GalatKasir(400, "INPUT_SALAH", "Badan multipart tidak terbaca.", { field: "badan" });
    const data = fd.get("data");
    let raw: unknown = null;
    try { raw = typeof data === "string" ? JSON.parse(data) : null; } catch { raw = null; }
    const b = fd.get("bukti");
    if (b !== null && !(b instanceof File)) throw salahBukti("Bagian bukti harus berkas.");
    return { raw, berkas: b && b.size > 0 ? b : null };
}

export async function POST(request: NextRequest) {
    const gate = await requirePermission(request, "kasir.catat");
    if (gate.response) return gate.response;
    let buktiBaru: string | null = null;
    try {
        const { raw, berkas } = await badan(request);
        const isian = uraiSetoran(raw, bawaanHari.sekarang(), Boolean(berkas));
        if (berkas) {
            if (berkas.size > MAKS_BUKTI_BYTES) throw salahBukti("Berkas bukti maksimal 5 MB.");
            const isi = new Uint8Array(await berkas.arrayBuffer());
            const jenis = jenisBukti(isi);
            if (!jenis) throw salahBukti("Bukti transfer harus foto JPG/PNG atau PDF (isi berkas diperiksa, bukan nama berkas).");
            // Gambar di-encode ulang (EXIF/GPS & polyglot terbuang, ≤ 2000 px, JPEG); PDF apa adanya.
            const n = await normalkanBukti(isi, jenis).catch((e: unknown) => {
                if (e instanceof BuktiRusak) throw salahBukti("Gambar bukti rusak atau tidak terbaca. Unggah ulang foto/PDF bukti.");
                throw e;
            });
            buktiBaru = await simpanBukti(n.isi, n.jenis);
        }
        const h = await catatSetoran({ ...isian, buktiBaru }, gate.session.user.id, bawaanHari);
        return NextResponse.json({ ok: true, ...h });
    } catch (e) {
        // Galat PASTI (sebelum commit) -> berkas belum terikat ke baris mana pun: hapus. TIDAK_PASTI -> biarkan (baris mungkin tersimpan).
        if (buktiBaru && !(e instanceof GalatKasir && e.kode === "TIDAK_PASTI")) await hapusBukti(buktiBaru);
        const j = jawabanGalat(e, "[KASIR SETORAN]");
        return NextResponse.json(j.body, { status: j.http });
    }
}
