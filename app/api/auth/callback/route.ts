import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { upsertAccurateSession } from '@/lib/accurate-session';

export async function GET(request: Request) {
    // request.url bisa berupa alamat internal container di belakang proxy (Coolify) — semua
    // redirect di sini WAJIB pakai base URL publik, bukan request.url (lihat lib/auth.ts).
    const publicBase = process.env.BETTER_AUTH_URL || process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;

    const appSession = await auth.api.getSession({ headers: request.headers });
    if (!appSession) {
        return NextResponse.redirect(new URL('/login?error=Accurate+login+requires+app+session', publicBase));
    }

    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');

    if (!code) {
        return NextResponse.redirect(new URL('/?error=No+Authorization+Code', publicBase));
    }

    const clientId = process.env.ACCURATE_CLIENT_ID;
    const clientSecret = process.env.ACCURATE_CLIENT_SECRET;
    const redirectUri = process.env.NEXT_PUBLIC_ACCURATE_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
        console.error("Missing environment variables for Accurate OAuth");
        return NextResponse.redirect(new URL('/?error=Server+Configuration+Error', publicBase));
    }

    try {
        // 1. Tukar Authorization Code dengan Access Token
        const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

        const tokenResponse = await fetch("https://account.accurate.id/oauth/token", {
            method: "POST",
            headers: {
                "Authorization": `Basic ${authHeader}`,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code: code,
                redirect_uri: redirectUri,
            }),
        });

        if (!tokenResponse.ok) {
            const errText = await tokenResponse.text();
            console.error("Tukar Token Gagal:", errText);
            return NextResponse.redirect(new URL(`/?error=Failed+to+exchange+token`, publicBase));
        }

        const tokenData = await tokenResponse.json();
        const accessToken = tokenData.access_token;

        await upsertAccurateSession(String(appSession.user.id), {
            accessToken,
            sessionHost: null,
            sessionId: null,
            databaseId: null,
            databaseAlias: null,
        });

        const redirectUrl = new URL('/api-wrapper', publicBase);
        redirectUrl.searchParams.set("accurate", "connected");

        return NextResponse.redirect(redirectUrl);

    } catch (err: any) {
        console.error("OAuth Callback Exception:", err.message);
        return NextResponse.redirect(new URL(`/?error=OAuth+Exception`, publicBase));
    }
}
