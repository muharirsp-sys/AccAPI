/*
 * Tujuan: Membuka database Accurate untuk sesi OAuth user dan menyimpan host + session database (kartu Sesi Accurate).
 * Caller: components/accurate/SesiAccurate.tsx (/sesi-accurate, Konsol).
 * Dependensi: lib/accurate-session (get/upsert), lib/api-security (sesi app).
 * Main Functions: GET, POST.
 * Side Effects: GET https://account.accurate.id/api/open-db.do; tulis accurate_oauth_session. Galat = kode tetap + kalimat netral;
 *   isi jawaban Accurate dan pesan exception TIDAK dikirim ke peramban maupun dicetak ke log — S7-sesi.
 */
import { NextResponse } from 'next/server';
import { getAccurateSession, upsertAccurateSession } from '@/lib/accurate-session';
import { requireApiSession } from '@/lib/api-security';

const galat = (status: number, code: string, error: string, extra: Record<string, unknown> = {}) => NextResponse.json({ ok: false, code, error, ...extra }, { status });

export async function GET(request: Request) {
    return openDatabase(request);
}

export async function POST(request: Request) {
    return openDatabase(request);
}

async function openDatabase(request: Request) {
    const authCheck = await requireApiSession(request);
    if (authCheck.response) return authCheck.response;

    const url = new URL(request.url);
    const queryDbId = url.searchParams.get('id');
    const body = request.method === "POST"
        ? await request.json().catch(() => ({})) as { id?: unknown; alias?: unknown }
        : {};
    const dbId = String(body.id || queryDbId || "").trim();
    const databaseAlias = typeof body.alias === "string" ? body.alias : null;

    if (!dbId) {
        return galat(400, "DATABASE_ID_KOSONG", "Pilih database dulu.");
    }

    const accurateSession = await getAccurateSession(String(authCheck.session.user.id));
    if (!accurateSession?.accessToken) {
        return galat(400, "SESI_BELUM_TERHUBUNG", "Sesi Accurate belum terhubung.");
    }

    try {
        const response = await fetch(`https://account.accurate.id/api/open-db.do?id=${encodeURIComponent(dbId)}`, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${accurateSession.accessToken}`
            }
        });

        const data = response.ok ? await response.json().catch(() => null) : null;
        if (!response.ok || !data?.host || !data?.session) {
            console.error(`[open-db] Accurate menolak: HTTP ${response.status}`);
            return galat(502, "ACCURATE_MENOLAK", "Accurate menolak membuka database ini.", { accurateStatus: response.status });
        }
        await upsertAccurateSession(String(authCheck.session.user.id), {
            sessionHost: data.host,
            sessionId: data.session,
            databaseId: dbId,
            databaseAlias,
        });
        return NextResponse.json(data);
    } catch (err: unknown) {
        console.error("[open-db] exception:", err instanceof Error ? err.name : typeof err);
        return galat(500, "GALAT_SERVER", "Server gagal membuka database Accurate.");
    }
}
