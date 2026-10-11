/*
 * Tujuan: Daftar database Accurate milik sesi OAuth user (kartu Sesi Accurate).
 * Caller: components/accurate/SesiAccurate.tsx (/sesi-accurate, Konsol).
 * Dependensi: lib/accurate-session (token terenkripsi), lib/api-security (sesi app).
 * Main Functions: GET.
 * Side Effects: GET https://account.accurate.id/api/db-list.do. Galat = kode tetap + kalimat netral; isi jawaban Accurate dan pesan
 *   exception TIDAK dikirim ke peramban maupun dicetak ke log (bisa memuat token) — S7-sesi.
 */
import { NextResponse } from 'next/server';
import { getAccurateSession } from '@/lib/accurate-session';
import { requireApiSession } from '@/lib/api-security';

const galat = (status: number, code: string, error: string, extra: Record<string, unknown> = {}) => NextResponse.json({ ok: false, code, error, ...extra }, { status });

export async function GET(request: Request) {
    const authCheck = await requireApiSession(request);
    if (authCheck.response) return authCheck.response;

    const accurateSession = await getAccurateSession(String(authCheck.session.user.id));
    if (!accurateSession?.accessToken) {
        return galat(400, "SESI_BELUM_TERHUBUNG", "Sesi Accurate belum terhubung.");
    }

    try {
        const response = await fetch("https://account.accurate.id/api/db-list.do", {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${accurateSession.accessToken}`
            }
        });

        const data = response.ok ? await response.json().catch(() => null) : null;
        if (!response.ok || data?.s === false || !Array.isArray(data?.d)) {
            console.error(`[db-list] Accurate menolak: HTTP ${response.status}`);
            return galat(502, "ACCURATE_MENOLAK", "Accurate menolak permintaan daftar database.", { accurateStatus: response.status });
        }
        return NextResponse.json(data);
    } catch (err: unknown) {
        console.error("[db-list] exception:", err instanceof Error ? err.name : typeof err);
        return galat(500, "GALAT_SERVER", "Server gagal mengambil daftar database Accurate.");
    }
}
