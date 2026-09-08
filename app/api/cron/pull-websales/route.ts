/*
 * Tujuan: Penjadwal 5 menit untuk menarik order Web Sales ke internal.
 * Caller: Coolify scheduled task / cron dengan Bearer CRON_SECRET (pola sama dengan sync-accurate).
 * Dependensi: lib/api-security (requireCronSecret), FastAPI POST /orders/pull-cron.
 * Main Functions: GET.
 * Side Effects: Tidak menulis DB di sisi ini; penarikan dan pencatatannya terjadi di FastAPI.
 *
 * Petugas menyalakan koneksi dari halaman Order Masuk. Selama mati, endpoint FastAPI
 * menjawab `skipped` — jadi cron boleh terus terpasang tanpa efek apa pun.
 */
import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/api-security";

export const runtime = "nodejs";

const BACKEND = process.env.FASTAPI_BASE_URL || process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || "http://localhost:8000";

export async function GET(request: Request) {
    const gate = requireCronSecret(request);
    if (gate.response) return gate.response;

    let upstream: Response;
    try {
        upstream = await fetch(`${BACKEND}/orders/pull-cron`, {
            method: "POST",
            // Secret yang sama dipakai kedua sisi; FastAPI membandingkannya konstan-waktu.
            // WAJIB di-set juga pada container backend, bukan hanya frontend.
            headers: { "X-Cron-Secret": process.env.CRON_SECRET as string },
            signal: AbortSignal.timeout(120_000),
        });
    } catch {
        return NextResponse.json({ ok: false, error: "Backend order tidak dapat dihubungi" }, { status: 502 });
    }
    const data = await upstream.json().catch(() => ({}));
    return NextResponse.json(upstream.ok ? { ok: true, ...data } : { ok: false, error: String(data?.detail || "Pull gagal") },
        { status: upstream.status });
}
