/*
 * Tujuan: Kosongkan acuan wajah salesman (owner 16 Nov 2026) — POST { salesCode } dari tab Hierarki bila acuan keliru (mis. selfie pertama
 *   bukan wajah salesman). Check-in berwajah berikutnya otomatis menjadi acuan baru.
 * Caller: app/(dashboard)/form-kontrol/tabs/TabHierarki.tsx.
 * Dependensi: lib/rbac/resolve (form_kontrol.manage), lib/form-kontrol (resolveScope, writeKontrolAudit), lib/form-kontrol/wajah-db.
 * Side Effects: DELETE wajah_acuan satu baris + kontrol_audit_log. Hanya cakupan global (admin/manager/admin_sales), sama dengan Hierarki.
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { resolveScope, writeKontrolAudit } from "@/lib/form-kontrol";
import { hapusAcuanWajah } from "@/lib/form-kontrol/wajah-db";

export async function POST(req: Request) {
    const gate = await requirePermissionH("form_kontrol.manage");
    if (gate.response) return gate.response;
    const session = gate.session;
    if ((await resolveScope(session)).allowedSalesCodes !== null) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    try {
        const body = (await req.json().catch(() => null)) as { salesCode?: unknown } | null;
        const salesCode = typeof body?.salesCode === "string" ? body.salesCode.trim() : "";
        if (!salesCode) return NextResponse.json({ kode: "INPUT_TIDAK_VALID", error: "salesCode wajib." }, { status: 400 });
        const dihapus = await hapusAcuanWajah(salesCode);
        if (dihapus) await writeKontrolAudit("wajah_acuan", salesCode, "hapus", session.user.id, session.user.name, { salesCode });
        return NextResponse.json({ success: true, dihapus });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
