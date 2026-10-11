/*
 * Tujuan: Riwayat otorisasi per USER (permission_audit_log.target_user_id), dipaginasi keyset — S7-1.
 * Izin: users.manage ATAU users.view. Kontrak: docs/handover/S7-KONTRAK-ADMIN-API.md §5.9. Side Effects: DB read-only.
 */
import { NextRequest } from "next/server";
import { jawabRiwayat } from "@/lib/rbac/riwayat";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
    return jawabRiwayat(request, { userId: (await context.params).id });
}
