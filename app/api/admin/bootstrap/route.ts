import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { count } from "drizzle-orm";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { appRoles, isAppRole } from "@/lib/rbac";
import { user } from "@/db/schema";

// Bandingkan token secara konstan-waktu untuk mencegah timing attack.
function safeTokenEqual(a: string, b: string) {
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
}

export async function POST(request: NextRequest) {
    const setupToken = process.env.ADMIN_SETUP_TOKEN;
    if (!setupToken) {
        return NextResponse.json({ error: "ADMIN_SETUP_TOKEN is not configured" }, { status: 503 });
    }

    const providedToken = request.headers.get("x-admin-setup-token") || "";
    if (!safeTokenEqual(providedToken, setupToken)) {
        return NextResponse.json({ error: "Invalid setup token" }, { status: 401 });
    }

    const [row] = await db.select({ value: count() }).from(user);
    if ((row?.value ?? 0) > 0) {
        return NextResponse.json({ error: "Bootstrap is only available before the first user exists" }, { status: 409 });
    }

    const body = await request.json().catch(() => null);
    const name = String(body?.name || "Admin").trim();
    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");
    const requestedRole = String(body?.role || "admin");
    const role = isAppRole(requestedRole) ? requestedRole : "admin";

    if (!email || !password || password.length < 6) {
        return NextResponse.json({ error: "Email and password with at least 6 characters are required" }, { status: 400 });
    }
    if (!appRoles.includes(role)) {
        return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }

    const result = await auth.api.createUser({
        body: {
            name,
            email,
            password,
            role,
            data: {
                emailVerified: true,
            },
        },
    });

    return NextResponse.json({ user: result.user });
}
