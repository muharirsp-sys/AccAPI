/*
 * Tujuan: Verifikasi sesi Better Auth untuk runtime lain (FastAPI) — Audit F9/D4.
 * Caller: python_backend get_current_user (forward cookie), hanya saat AUTH_VERIFY_URL di-set.
 * Keamanan: hanya mengembalikan identitas & izin efektif pemilik cookie yang dikirim — sama
 * dengan yang bisa diketahui klien ter-autentikasi tentang dirinya sendiri. Respons non-200
 * selain 401 dibaca FastAPI sebagai gangguan sementara (tidak di-cache), bukan sesi invalid.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { user as userTable } from "@/db/schema";
import { getUserPermissions } from "@/lib/rbac/resolve";

export async function GET(request: Request) {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
        return NextResponse.json({ ok: false }, { status: 401 });
    }
    const user = session.user as { id: string; email?: string; name?: string; role?: string };
    // D4: FastAPI butuh user.permissions (kolom custom, tidak ikut session.user) utk
    // get_user_permissions_info — dulu dibaca langsung dari sqlite.
    const [row] = await db.select({ permissions: userTable.permissions })
        .from(userTable).where(eq(userTable.id, user.id)).limit(1);
    return NextResponse.json({
        ok: true,
        email: user.email ?? null,
        name: user.name ?? null,
        role: user.role ?? "viewer",
        permissions: row?.permissions ?? null,
        // AM-010: izin EFEKTIF (group otoritatif, legacy hanya bila belum ber-group) dari
        // resolver yang sama dengan requirePermission — FastAPI memakainya sebagai satu-satunya
        // sumber kebijakan, sehingga role legacy tidak bisa mengembalikan akses yang dicabut group.
        effectivePermissions: [...(await getUserPermissions(user.id))].sort(),
    });
}
