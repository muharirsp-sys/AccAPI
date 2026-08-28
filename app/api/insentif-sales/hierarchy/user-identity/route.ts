/*
 * Tujuan: Link akun login (user.id) ke identitas SPV/SM (hierarchyRole/hierarchyName) —
 *         syarat aktifnya scoping "SPV/SM cuma lihat bawahan sendiri" (lib/insentif-hierarchy-scope).
 * Caller: app/(dashboard)/insentif-sales/page.tsx (HierarchyAssignmentSection, AdminView).
 * Dependensi: db/schema (user).
 * Main Functions: GET list user + identitas hierarki; POST set/clear (hierarchyRole=null → clear).
 * Side Effects: DB read + write (kolom user.hierarchyRole/hierarchyName SAJA — tidak menyentuh
 *   field auth/permission user lainnya).
 */

import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { user } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.manage_hierarchy");
    if (gate.response) return gate.response;

    const rows = await db
        .select({ id: user.id, name: user.name, email: user.email, hierarchyRole: user.hierarchyRole, hierarchyName: user.hierarchyName })
        .from(user)
        .orderBy(asc(user.email));
    return NextResponse.json({ users: rows });
}

interface IdentityInput {
    userId?: string;
    hierarchyRole?: "spv" | "sm" | "sales" | null;
    hierarchyName?: string | null;
}

export async function POST(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.manage_hierarchy");
    if (gate.response) return gate.response;

    let body: IdentityInput;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (!body.userId) return NextResponse.json({ error: "userId wajib diisi" }, { status: 400 });

    const clearing = !body.hierarchyRole;
    if (!clearing) {
        // "sales" ditambahkan 2026-08-29: tanpa peran ini seorang salesman tidak bisa dibatasi
        // ke datanya sendiri sama sekali — hierarchyName-nya adalah KODE SALES, bukan nama.
        if (body.hierarchyRole !== "spv" && body.hierarchyRole !== "sm" && body.hierarchyRole !== "sales") {
            return NextResponse.json({ error: "hierarchyRole harus 'spv' atau 'sm'" }, { status: 400 });
        }
        if (!body.hierarchyName?.trim()) {
            return NextResponse.json({ error: "hierarchyName wajib diisi" }, { status: 400 });
        }
    }

    await db
        .update(user)
        .set({
            hierarchyRole: clearing ? null : body.hierarchyRole,
            hierarchyName: clearing ? null : body.hierarchyName!.trim(),
            updatedAt: new Date(),
        })
        .where(eq(user.id, body.userId));

    return NextResponse.json({ ok: true });
}
