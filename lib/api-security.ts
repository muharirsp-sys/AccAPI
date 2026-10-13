import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { auth } from "@/lib/auth";
import { isLocalAuthBypassEnabled } from "@/lib/local-dev-auth";

export async function requireApiSession(request: NextRequest | Request) {
    if (isLocalAuthBypassEnabled(request.headers)) {
        return {
            session: { user: { id: "local-dev-admin", email: "local-admin@localhost.invalid", name: "LOCAL Admin", role: "admin" } },
            response: null,
        };
    }
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
        return {
            session: null,
            response: NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
        };
    }
    return { session, response: null };
}

/** Banding konstan-waktu: sidik sha256 kedua sisi (panjang sama) -> timingSafeEqual; panjang secret pun tidak bocor lewat waktu. */
export function samaRahasia(diberikan: string, rahasia: string): boolean {
    const h = (v: string) => createHash("sha256").update(v, "utf8").digest();
    return timingSafeEqual(h(diberikan), h(rahasia));
}

/**
 * Gate untuk endpoint cron/seed internal + layanan FastAPI -> Next. HANYA header `Authorization: Bearer <secret>`, dibandingkan
 * konstan-waktu. Fail-closed: kalau CRON_SECRET belum di-set, selalu tolak.
 *
 * O1 putaran 1 (butir 6): fallback query `?secret=` DIHAPUS — secret di URL tercatat di log akses proxy/Next dan riwayat shell. Pemakai
 * dicari 12 Okt 2026: crontab produksi (`/usr/local/bin/accapi-cron.sh`, KASIR-KONTRAK) dan FastAPI (outlet_channel, order_cabang)
 * memakai header; satu-satunya rujukan query = komentar seed demo Form Kontrol (endpoint seed itu dihapus 13 Okt 2026, owner).
 */
export function requireCronSecret(request: NextRequest | Request) {
    const secret = process.env.CRON_SECRET;
    const deny = NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!secret) return { response: deny };
    const header = request.headers.get("authorization");
    const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!bearer || !samaRahasia(bearer, secret)) return { response: deny };
    return { response: null };
}

/**
 * Gate untuk integrasi Web Sales (`/api/ext/*`). Token statis via
 * `Authorization: Bearer <EXT_SALES_TOKEN>`. Fail-closed: env belum di-set → selalu tolak.
 *
 * ponytail: token statis, bukan HMAC per-request. Transport sudah dijaga VPN antar server
 * (Internal tidak punya jalur publik) dan replay sudah ditutup oleh cursor keyset yang
 * idempoten. Naikkan ke HMAC + timestamp kalau endpoint ini pernah diekspos ke internet.
 */
export function requireExtToken(request: NextRequest | Request) {
    const token = process.env.EXT_SALES_TOKEN;
    const deny = NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    if (!token) return { response: deny };
    const header = request.headers.get("authorization");
    const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!bearer || bearer !== token) return { response: deny };
    return { response: null };
}

export function isAllowedAccurateHost(rawHost: unknown): boolean {
    if (typeof rawHost !== "string" || rawHost.trim() === "") return false;
    try {
        const url = new URL(rawHost);
        const hostname = url.hostname.toLowerCase();
        return url.protocol === "https:" && (hostname === "accurate.id" || hostname.endsWith(".accurate.id"));
    } catch {
        return false;
    }
}
