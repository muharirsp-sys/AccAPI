/*
 * Tujuan: Verifikasi sesi Better Auth untuk runtime lain (FastAPI) — Audit F9/D4.
 * Caller: python_backend get_current_user (forward cookie), hanya saat AUTH_VERIFY_URL di-set.
 * Keamanan: hanya mengembalikan identitas pemilik cookie yang dikirim — sama dengan
 * yang bisa diketahui klien ter-autentikasi tentang dirinya sendiri.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export async function GET(request: Request) {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
        return NextResponse.json({ ok: false }, { status: 401 });
    }
    const user = session.user as { email?: string; name?: string; role?: string };
    return NextResponse.json({
        ok: true,
        email: user.email ?? null,
        name: user.name ?? null,
        role: user.role ?? "viewer",
    });
}
