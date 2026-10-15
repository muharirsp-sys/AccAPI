/*
 * Tujuan: Unduh berkas bukti setoran Transfer Kasir (K2a, BL-59) untuk pemegang `kasir.view`. Nama berkas dari kasir_setoran.bukti_transfer
 *   (pola UUID ketat, basename) — tidak pernah dari input pengguna.
 * Caller: K2b (buktiUrl di GET /api/kasir: riwayat revisi & setoranTerakhir). Kontrak: docs/handover/KASIR-KONTRAK.md §8.4.
 * Dependensi: lib/kasir/hari (cariBukti), lib/kasir/bukti (bacaBukti, MIME_BUKTI), lib/rbac/resolve.
 * Main Functions: GET ?id=<kasir_setoran.id> -> berkas (gambar inline, PDF attachment, nosniff, CSP sandbox, no-store) | 400 |
 *   404 TIDAK_ADA (baris/berkas tak ada) | 500 GALAT_INTERNAL (galat baca selain ENOENT, dicatat).
 * Side Effects: SELECT kasir_setoran + baca berkas dari volume data. Tidak menulis.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { bawaanHari, cariBukti, jawabanGalat } from "@/lib/kasir/hari";
import { bacaBukti, MIME_BUKTI } from "@/lib/kasir/bukti";

export const runtime = "nodejs";

const tidakAda = () => NextResponse.json({ ok: false, kode: "TIDAK_ADA", error: "Bukti transfer tidak ditemukan." }, { status: 404 });

export async function GET(request: NextRequest) {
    const gate = await requirePermission(request, "kasir.view");
    if (gate.response) return gate.response;
    const idTeks = request.nextUrl.searchParams.get("id") ?? "";
    const id = /^[1-9]\d{0,15}$/.test(idTeks) ? Number(idTeks) : NaN;
    if (!Number.isSafeInteger(id)) return NextResponse.json({ ok: false, kode: "INPUT_SALAH", error: "id bukti tidak sah.", field: "id" }, { status: 400 });
    try {
        const r = await cariBukti(id, bawaanHari);
        if (!r?.bukti) return tidakAda();
        const f = await bacaBukti(r.bukti);
        if (!f) return tidakAda();
        const nama = `bukti-${r.tanggal}-${r.kode.replace(/[^\w.-]/g, "_")}-r${r.revisi}.${f.jenis}`;
        return new NextResponse(new Uint8Array(f.isi), {
            headers: {
                "content-type": MIME_BUKTI[f.jenis],
                "content-disposition": `${f.jenis === "pdf" ? "attachment" : "inline"}; filename="${nama}"`,
                "x-content-type-options": "nosniff",
                "content-security-policy": "sandbox",
                "cache-control": "private, no-store",
            },
        });
    } catch (e) {
        const j = jawabanGalat(e, "[KASIR BUKTI]");
        return NextResponse.json(j.body, { status: j.http });
    }
}
