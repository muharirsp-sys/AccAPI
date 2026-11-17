/*
 * Tujuan: Data layar Incaso "Tagihan kunjungan" (owner 16 Nov 2026) — GET ?tanggal=YYYY-MM-DD -> kunjungan hari itu yang mencatat hasil tagih
 *   nota belum lunas (tertagih + nominal / tidak tertagih + alasan) + status order + nota belum lunas toko saat ini.
 * Caller: app/(dashboard)/tagihan-kunjungan/TagihanKunjungan.tsx.
 * Dependensi: lib/rbac/resolve, lib/form-kontrol/nota-db (daftarTagihanKunjungan), lib/beranda witaToday, IZIN_TAGIHAN_KUNJUNGAN (lib/rbac).
 * Side Effects: SELECT saja.
 */
import { NextResponse } from "next/server";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";
import { IZIN_TAGIHAN_KUNJUNGAN } from "@/lib/rbac";
import { daftarTagihanKunjungan } from "@/lib/form-kontrol/nota-db";
import { witaToday } from "@/lib/beranda";

export async function GET(req: Request) {
    const gate = await resolveRequestPermissions(req);
    if (gate.response) return gate.response;
    if (!IZIN_TAGIHAN_KUNJUNGAN.some((k) => gate.perms?.has(k))) {
        return NextResponse.json({ ok: false, kode: "TIDAK_DIIZINKAN", error: "Akses tagihan kunjungan tidak diizinkan." }, { status: 403 });
    }
    const hariIni = witaToday();
    const tanggal = new URL(req.url).searchParams.get("tanggal")?.trim() || hariIni;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) {
        return NextResponse.json({ ok: false, kode: "INPUT_TIDAK_VALID", error: "Tanggal harus YYYY-MM-DD." }, { status: 400 });
    }
    try {
        return NextResponse.json({ ok: true, tanggal, rows: await daftarTagihanKunjungan(tanggal, hariIni) });
    } catch {
        return NextResponse.json({ ok: false, kode: "TAGIHAN_GAGAL", error: "Data tagihan kunjungan gagal dibaca." }, { status: 500 });
    }
}
