/*
 * Tujuan: Koordinat toko per kode JKS untuk peta Supervisor Review (spec docs/superpowers/specs/2026-10-16-supervisor-review-design.md §3.3).
 * Caller: app/(dashboard)/form-kontrol/tabs/TabKoordinat (SR-3).
 * Dependensi: lib/rbac/resolve (form_kontrol.manage), xlsx (SheetJS, pola app/api/form-kontrol/jks/route.ts), lib/supervisor-review/db.
 * Main Functions: GET -> RingkasanKoordinat; POST multipart `file` (xlsx: kode toko, latitude, longitude) -> JawabanUnggahKoordinat.
 * Side Effects: POST upsert toko_koordinat. Baris ditolak (kode bukan JKS, bukan angka, di luar Indonesia, ganda) dilaporkan dengan nomor
 *   baris Excel; baris sah tetap disimpan.
 */
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { ringkasanKoordinat, simpanKoordinat } from "@/lib/supervisor-review/db";

const MAKS_BERKAS = 5 * 1024 * 1024;
// Judul kolom (ID/EN, huruf/spasi/tanda diabaikan) -> isian.
const KOLOM: Record<string, "kode" | "lat" | "lng"> = {
    kodetoko: "kode", kode: "kode", kodejks: "kode", custcode: "kode", kodepelanggan: "kode", kodecustomer: "kode",
    latitude: "lat", lat: "lat", lintang: "lat",
    longitude: "lng", lng: "lng", long: "lng", lon: "lng", bujur: "lng",
};

export async function GET() {
    const gate = await requirePermissionH("form_kontrol.manage");
    if (gate.response) return gate.response;
    try {
        return NextResponse.json(await ringkasanKoordinat());
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

export async function POST(req: Request) {
    const gate = await requirePermissionH("form_kontrol.manage");
    if (gate.response) return gate.response;
    try {
        const form = await req.formData().catch(() => null);
        const file = form?.get("file");
        if (!(file instanceof File)) return NextResponse.json({ kode: "BERKAS_TIDAK_ADA", error: "Berkas xlsx (field `file`) tidak ditemukan." }, { status: 400 });
        if (file.size > MAKS_BERKAS) return NextResponse.json({ kode: "BERKAS_TERLALU_BESAR", error: "Berkas maksimal 5 MB." }, { status: 413 });
        const wb = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: "buffer" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const mentah = sheet ? XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" }) : [];
        const baris = mentah.map((r) => {
            const isi: { baris: number; kode: unknown; lat: unknown; lng: unknown } = {
                // __rowNum__ (SheetJS, 0-based, tak terhitung) = baris Excel sebenarnya walau ada baris kosong di antaranya.
                baris: Number((r as { __rowNum__?: number }).__rowNum__ ?? 0) + 1, kode: "", lat: "", lng: "" };
            for (const [k, v] of Object.entries(r)) { const f = KOLOM[k.toLowerCase().replace(/[^a-z]/g, "")]; if (f) isi[f] = v; }
            return isi;
        });
        const judul = new Set(Object.keys(mentah[0] ?? {}).map((k) => KOLOM[k.toLowerCase().replace(/[^a-z]/g, "")]));
        if (!judul.has("kode") || !judul.has("lat") || !judul.has("lng")) {
            return NextResponse.json({ kode: "KOLOM_TIDAK_LENGKAP", error: "Kolom wajib: kode toko, latitude, longitude." }, { status: 400 });
        }
        return NextResponse.json(await simpanKoordinat(baris, gate.session.user.id));
    } catch (e) {
        console.error("[supervisor-review/koordinat] gagal:", e instanceof Error ? e.message : e);
        return NextResponse.json({ error: "Gagal menyimpan koordinat." }, { status: 500 });
    }
}
