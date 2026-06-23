import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { offAuditLog, offBatch } from "@/db/schema";
import { requireOffSession } from "@/lib/off-program-control";
import { requirePermissionH } from "@/lib/rbac/resolve";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
    // Audit log berisi jejak aktor (id/nama) + metadata sensitif: wajib autentikasi.
    const actor = await requireOffSession();
    if (!actor) return NextResponse.json({ ok: false, error: "Anda tidak memiliki akses untuk melakukan tindakan ini." }, { status: 401 });
    const gate = await requirePermissionH("off_program_control.view");
    if (gate.response) return gate.response;

    const { id } = await context.params;
    const [batch] = await db.select({ createdBy: offBatch.createdBy }).from(offBatch).where(eq(offBatch.id, id));
    if (!batch) return NextResponse.json({ ok: false, error: "Batch not found" }, { status: 404 });
    // Isolasi per-supervisor: SPV hanya boleh melihat audit batch miliknya sendiri.
    if (actor.role === "supervisor" && batch.createdBy !== actor.id) {
        return NextResponse.json({ ok: false, error: "Batch not found" }, { status: 404 });
    }

    const audit = await db.select().from(offAuditLog).where(eq(offAuditLog.batchId, id)).orderBy(asc(offAuditLog.createdAt));
    return NextResponse.json({ ok: true, audit });
}
