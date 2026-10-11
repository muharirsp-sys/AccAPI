/*
 * Tujuan: Memulai masuk Accurate (AM-033): `state` acak kriptografis + `returnTo` (daftar putih) disimpan di cookie httpOnly berumur
 *   pendek yang hanya dikirim ke callback, lalu dialihkan ke halaman authorize Accurate (scope tetap, lib/accurate-oauth).
 * Caller: tombol "Masuk Accurate" di components/accurate/SesiAccurate.tsx (/sesi-accurate dan Konsol /api-wrapper).
 * Dependensi: node:crypto, lib/accurate-oauth; env ACCURATE_CLIENT_ID (cadangan NEXT_PUBLIC_ACCURATE_CLIENT_ID), NEXT_PUBLIC_ACCURATE_REDIRECT_URI.
 * Main Functions: GET.
 * Side Effects: Set-Cookie `accurate_oauth_state`; tidak memanggil Accurate dan tidak menulis DB.
 */
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { STATE_COOKIE, STATE_COOKIE_MAX_AGE, STATE_COOKIE_PATH, halamanMendarat, returnToAman, urlAuthorize } from "@/lib/accurate-oauth";

export async function GET(request: Request) {
    // Sama dengan callback: di belakang proxy request.url bisa alamat internal container.
    const publicBase = process.env.BETTER_AUTH_URL || process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;
    const returnTo = returnToAman(new URL(request.url).searchParams.get("returnTo"));
    // Client id penukar token (callback) = ACCURATE_CLIENT_ID; varian NEXT_PUBLIC_ (dulu dipakai peramban) sebagai cadangan.
    const clientId = process.env.ACCURATE_CLIENT_ID || process.env.NEXT_PUBLIC_ACCURATE_CLIENT_ID;
    const redirectUri = process.env.NEXT_PUBLIC_ACCURATE_REDIRECT_URI;
    if (!clientId || !redirectUri) {
        console.error("[accurate-login] ACCURATE_CLIENT_ID/NEXT_PUBLIC_ACCURATE_CLIENT_ID atau NEXT_PUBLIC_ACCURATE_REDIRECT_URI belum di-set.");
        return NextResponse.redirect(new URL(halamanMendarat(returnTo, { accurate: "error", alasan: "konfigurasi" }), publicBase));
    }

    const state = randomBytes(32).toString("base64url");
    const res = NextResponse.redirect(urlAuthorize(clientId, redirectUri, state));
    res.cookies.set(STATE_COOKIE, `${state}:${returnTo}`, {
        httpOnly: true, secure: true, sameSite: "lax", maxAge: STATE_COOKIE_MAX_AGE, path: STATE_COOKIE_PATH,
    });
    return res;
}
