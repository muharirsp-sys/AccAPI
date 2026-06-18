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
