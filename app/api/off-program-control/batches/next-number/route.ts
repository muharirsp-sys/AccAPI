import { NextResponse } from "next/server";
import { getNextOffBatchNumber, getPrincipleByCode, requireOffSession } from "@/lib/off-program-control";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";

export async function GET(request: Request) {
    const actor = await requireOffSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const access = await resolveRequestPermissionsH();
    if (access.response) return access.response;
    const perms = access.perms!;
    if (!perms.has("off_program_control.create_batch") && !perms.has("off_program_control.edit_returned_batch")) {
        return NextResponse.json({ ok: false, error: "Role Anda tidak memiliki akses membuat No Pengajuan OFF." }, { status: 403 });
    }

    const url = new URL(request.url);
    const principleCode = String(url.searchParams.get("principleCode") || "").trim();
    const bulan = String(url.searchParams.get("bulan") || "").padStart(2, "0");
    const tahun = String(url.searchParams.get("tahun") || "").trim();
    const source = String(url.searchParams.get("source") || "").trim() === "claim" ? "claim" : "supervisor";
    const excludeBatchId = String(url.searchParams.get("excludeBatchId") || "").trim() || null;

    const principle = getPrincipleByCode(principleCode);
    if (!principle) {
        return NextResponse.json({ ok: false, error: "Kode principal tidak valid." }, { status: 400 });
    }
    if (!bulan || !tahun) {
        return NextResponse.json({ ok: false, error: "Bulan dan tahun wajib diisi." }, { status: 400 });
    }

    try {
        const nextNumber = await getNextOffBatchNumber({
            principleCode: principle.code,
            bulan,
            tahun,
            createdByRole: source,
            excludeBatchId,
        });
        return NextResponse.json({ ok: true, ...nextNumber });
    } catch (error) {
        console.error("[OFF NEXT NUMBER ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal membuat No Pengajuan otomatis." }, { status: 500 });
    }
}
