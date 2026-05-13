import { NextResponse } from 'next/server';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');

    if (!code) {
        return NextResponse.redirect(new URL('/?error=No+Authorization+Code', request.url));
    }

    const clientId = process.env.ACCURATE_CLIENT_ID;
    const clientSecret = process.env.ACCURATE_CLIENT_SECRET;
    const redirectUri = process.env.NEXT_PUBLIC_ACCURATE_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
        console.error("Missing environment variables for Accurate OAuth");
        return NextResponse.redirect(new URL('/?error=Server+Configuration+Error', request.url));
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
            return NextResponse.redirect(new URL(`/?error=Failed+to+exchange+token`, request.url));
        }

        const tokenData = await tokenResponse.json();
        const accessToken = tokenData.access_token;

        // 2. Redirect kembali ke frontend dengan access token sebagai hash/fragment URL
        // Frontend (app/api-wrapper/page.tsx) akan memproses token ini lalu menghapusnya dari URL demi keamanan
        const redirectUrl = new URL('/api-wrapper', request.url);
        redirectUrl.hash = `access_token=${accessToken}`;

        return NextResponse.redirect(redirectUrl);

    } catch (err: any) {
        console.error("OAuth Callback Exception:", err.message);
        return NextResponse.redirect(new URL(`/?error=OAuth+Exception`, request.url));
    }
}
