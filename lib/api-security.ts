import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export async function requireApiSession(request: NextRequest | Request) {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
        return {
            session: null,
            response: NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
        };
    }
    return { session, response: null };
}

/**
 * Gate untuk endpoint cron/seed internal. Terima secret via header
 * `Authorization: Bearer <secret>` (disukai) atau query `?secret=` (fallback
 * back-compat). Fail-closed: kalau CRON_SECRET belum di-set, selalu tolak.
 */
export function requireCronSecret(request: NextRequest | Request) {
    const secret = process.env.CRON_SECRET;
    const deny = NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!secret) return { response: deny };
    const header = request.headers.get("authorization");
    const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
    const query = new URL(request.url).searchParams.get("secret");
    const provided = bearer || query;
    if (!provided || provided !== secret) return { response: deny };
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
