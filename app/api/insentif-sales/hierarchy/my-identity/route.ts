/*
 * Tujuan: Info identitas hierarki milik SENDIRI (bukan daftar user lain) — dipakai frontend
 *         untuk tahu apakah user ini SPV/SM (tampilkan form self-service claim) atau bukan.
 * Caller: app/(dashboard)/insentif-sales/page.tsx (HierarchyAssignmentSection).
 * Dependensi: lib/insentif-hierarchy-scope (getUserHierarchyIdentity).
 * Main Functions: GET.
 * Side Effects: DB read-only. Hanya mengembalikan data user yang sedang login sendiri.
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { getUserHierarchyIdentity } from "@/lib/insentif-hierarchy-scope";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;

    const identity = await getUserHierarchyIdentity(gate.session.user.id);
    const isAdmin = gate.perms.has("insentif_sales.manage_hierarchy");
    return NextResponse.json({ identity, isAdmin });
}
