/*
 * Tujuan: Callback OAuth Accurate (AM-033): cocokkan `state` dengan cookie httpOnly dari /api/auth/accurate-login SEBELUM menukar code,
 *   simpan access token terenkripsi ke sesi Accurate user, lalu alihkan ke halaman berkartu Sesi Accurate dengan kabar berkode.
 * Caller: Accurate (redirect_uri = NEXT_PUBLIC_ACCURATE_REDIRECT_URI).
 * Dependensi: Better Auth (sesi app), lib/accurate-session (upsertAccurateSession), lib/accurate-oauth (returnTo, halaman, kode galat).
 * Main Functions: GET.
 * Side Effects: POST https://account.accurate.id/oauth/token; tulis accurate_oauth_session; hapus cookie state di SEMUA cabang.
 *   Log tidak memuat token maupun isi jawaban Accurate (bisa memuat token) — hanya status HTTP / nama galat.
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { upsertAccurateSession } from "@/lib/accurate-session";
import { STATE_COOKIE, STATE_COOKIE_PATH, halamanMendarat, returnToAman, type KodeGalatAccurate } from "@/lib/accurate-oauth";

function samaAman(a: string, b: string) {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}

export async function GET(request: NextRequest) {
    // request.url bisa berupa alamat internal container di belakang proxy (Coolify) — semua
    // redirect di sini WAJIB pakai base URL publik, bukan request.url (lihat lib/auth.ts).
    const publicBase = process.env.BETTER_AUTH_URL || process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;

    const isiCookie = request.cookies.get(STATE_COOKIE)?.value ?? "";
    const pisah = isiCookie.indexOf(":");
    const stateCookie = pisah > 0 ? isiCookie.slice(0, pisah) : "";
    const returnTo = returnToAman(pisah > 0 ? isiCookie.slice(pisah + 1) : null);

    const selesai = (path: string) => {
        const res = NextResponse.redirect(new URL(path, publicBase));
        res.cookies.set(STATE_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", maxAge: 0, path: STATE_COOKIE_PATH });
        return res;
    };
    const galat = (alasan: KodeGalatAccurate) => selesai(halamanMendarat(returnTo, { accurate: "error", alasan }));

    const appSession = await auth.api.getSession({ headers: request.headers });
    if (!appSession) {
        // Cabang ini dulu diam. Dengan LOCAL_AUTH_BYPASS, /login melempar balik ke home
        // sehingga gagalnya terlihat seperti "login Accurate berputar-putar" tanpa sebab.
        // Nilai query TETAP persis (halaman masuk S7c memetakan string ini).
        console.error("Accurate callback ditolak: tidak ada sesi Better Auth yang aktif. Login aplikasi dulu (bypass localhost tidak membuat sesi).");
        return selesai("/login?error=Accurate+login+requires+app+session");
    }

    const { searchParams } = new URL(request.url);
    // State diperiksa SEBELUM code disentuh: tanpa cookie (kedaluwarsa/alamat lain) atau beda = code tidak ditukar.
    if (!stateCookie) return galat("state_hilang");
    const state = searchParams.get("state");
    if (!state || !samaAman(state, stateCookie)) return galat("state_beda");

    const code = searchParams.get("code");
    if (!code) return galat("tanpa_kode");

    const clientId = process.env.ACCURATE_CLIENT_ID;
    const clientSecret = process.env.ACCURATE_CLIENT_SECRET;
    const redirectUri = process.env.NEXT_PUBLIC_ACCURATE_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
        console.error("Missing environment variables for Accurate OAuth");
        return galat("konfigurasi");
    }

    try {
        // 1. Tukar Authorization Code dengan Access Token
        const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
        const tokenResponse = await fetch("https://account.accurate.id/oauth/token", {
            method: "POST",
            headers: {
                "Authorization": `Basic ${authHeader}`,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code,
                redirect_uri: redirectUri,
            }),
        });

        if (!tokenResponse.ok) {
            // Isi jawaban TIDAK dicetak (bisa memuat token/kode).
            console.error(`[accurate-callback] tukar token gagal: HTTP ${tokenResponse.status}`);
            return galat("tukar_token_gagal");
        }

        const tokenData = await tokenResponse.json().catch(() => null) as { access_token?: unknown } | null;
        const accessToken = tokenData?.access_token;
        if (typeof accessToken !== "string" || !accessToken) {
            console.error("[accurate-callback] tukar token gagal: jawaban tanpa access_token");
            return galat("tukar_token_gagal");
        }

        await upsertAccurateSession(String(appSession.user.id), {
            accessToken,
            sessionHost: null,
            sessionId: null,
            databaseId: null,
            databaseAlias: null,
        });

        return selesai(halamanMendarat(returnTo, { accurate: "connected" }));
    } catch (err: unknown) {
        // Hanya nama galat: pesan bisa memuat potongan isi jawaban (mis. SyntaxError JSON).
        console.error("[accurate-callback] exception:", err instanceof Error ? err.name : typeof err);
        return galat("galat_server");
    }
}
