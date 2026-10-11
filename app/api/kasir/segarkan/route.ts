/*
 * Tujuan: Segarkan cache pelunasan Accurate SATU tanggal untuk Kasir ↔ Incaso (K1b, BL-59). POST membaca bertahap dengan identitas
 *   SINKRON (Kasir tak punya sesi Accurate, D-01); GET mengembalikan status baca terakhir TANPA Accurate.
 * Caller: K2 halaman /kasir (tombol Segarkan; selama `sebagian` klien memanggil lagi: "Membaca 600/824").
 * Dependensi: lib/kasir/baca-pelunasan (pelaksana + status), lib/kasir/pembaca (tanggalSah, pesan sesi), lib/rbac/resolve (kasir.view),
 *   lib/insentif-payment-date (todayWita).
 * Main Functions: POST { tanggal, penuh? } -> 200 lengkap/sebagian/jeda, 409 SEDANG_DIBACA, 503 SESI_SINKRON, 502 BACA_GAGAL;
 *   GET ?tanggal= -> status (belum_dibaca bila belum pernah).
 * Side Effects: POST = GET Accurate sales-receipt list.do/detail.do (baca-saja) + tulis cache kasir_pelunasan, kasir_pelunasan_faktur, kasir_pelunasan_baca; GET = SELECT saja.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { todayWita } from "@/lib/insentif-payment-date";
import { bacaPelunasanHari, databaseIdSinkron, jawabanSegarkan, statusBaca } from "@/lib/kasir/baca-pelunasan";
import { PESAN_SESI_SINKRON, tanggalSah } from "@/lib/kasir/pembaca";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Tanggal sah (YYYY-MM-DD, tanggal yang ada) dan tidak di masa depan WITA. */
function salahTanggal(t: unknown): string | null {
    if (!tanggalSah(t)) return "tanggal wajib YYYY-MM-DD dan tanggal yang ada.";
    const hariIni = todayWita(new Date());
    return t > hariIni ? `Tanggal ${t} belum tiba (hari ini ${hariIni} WITA).` : null;
}

export async function POST(request: NextRequest) {
    const gate = await requirePermission(request, "kasir.view");
    if (gate.response) return gate.response;
    const body = await request.json().catch(() => null) as { tanggal?: unknown; penuh?: unknown } | null;
    const salah = salahTanggal(body?.tanggal);
    if (salah) return NextResponse.json({ ok: false, error: salah }, { status: 400 });
    try {
        const hasil = await bacaPelunasanHari({ tanggal: body!.tanggal as string, pemicu: `manual:${gate.session.user.id}`, penuh: body?.penuh === true });
        const j = jawabanSegarkan(hasil);
        return NextResponse.json(j.body, { status: j.http });
    } catch (error) {
        console.error("[KASIR SEGARKAN]", error);
        return NextResponse.json({ ok: false, kode: "GALAT_INTERNAL", error: "Gagal membaca pelunasan Accurate." }, { status: 500 });
    }
}

export async function GET(request: NextRequest) {
    const gate = await requirePermission(request, "kasir.view");
    if (gate.response) return gate.response;
    const tanggal = request.nextUrl.searchParams.get("tanggal");
    const salah = salahTanggal(tanggal);
    if (salah) return NextResponse.json({ ok: false, error: salah }, { status: 400 });
    try {
        const databaseId = await databaseIdSinkron();
        if (!databaseId) return NextResponse.json({ ok: false, kode: "SESI_SINKRON", error: PESAN_SESI_SINKRON }, { status: 503 });
        return NextResponse.json({ ok: true, status: await statusBaca(databaseId, tanggal!) });
    } catch (error) {
        console.error("[KASIR STATUS BACA]", error);
        return NextResponse.json({ ok: false, kode: "GALAT_INTERNAL", error: "Gagal membaca status pelunasan." }, { status: 500 });
    }
}
