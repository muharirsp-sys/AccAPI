/*
 * Tujuan: Status / keluar sesi OAuth Accurate milik user yang masuk.
 * Caller: components/accurate/SesiAccurate (?periksa=1), Pelunasan, Finance posting.
 * Dependensi: lib/accurate-session (getAccurateSession, periksaToken, clearAccurateSession), lib/api-security.
 * Main Functions: GET (status; `?periksa=1` = token diperiksa sungguhan ke Accurate), DELETE (keluar).
 * Side Effects: `?periksa=1` = 1 GET db-list.do ke Accurate. Insiden 22 Nov 2026: token mati tetapi kartu tetap "Database aktif"
 *   karena status hanya dibaca dari tabel sesi.
 */
import { NextRequest, NextResponse } from "next/server";
import { clearAccurateSession, getAccurateSession, periksaToken } from "@/lib/accurate-session";
import { requireApiSession } from "@/lib/api-security";

export async function GET(request: NextRequest) {
    const authCheck = await requireApiSession(request);
    if (authCheck.response) return authCheck.response;

    const accurateSession = await getAccurateSession(String(authCheck.session.user.id));
    // "hidup" | "mati" | "tak_terperiksa"; null = tidak diminta atau belum masuk Accurate.
    const hidup = accurateSession?.accessToken && request.nextUrl.searchParams.get("periksa") === "1"
        ? await periksaToken(accurateSession.accessToken) : undefined;
    return NextResponse.json({
        ok: true,
        connected: Boolean(accurateSession),
        token: hidup === undefined ? null : hidup === null ? "tak_terperiksa" : hidup ? "hidup" : "mati",
        databaseConnected: Boolean(accurateSession?.sessionHost && accurateSession?.sessionId),
        sessionHost: accurateSession?.sessionHost ?? null,
        databaseId: accurateSession?.databaseId ?? null,
        databaseAlias: accurateSession?.databaseAlias ?? null,
    });
}

export async function DELETE(request: NextRequest) {
    const authCheck = await requireApiSession(request);
    if (authCheck.response) return authCheck.response;

    await clearAccurateSession(String(authCheck.session.user.id));
    return NextResponse.json({ ok: true });
}
