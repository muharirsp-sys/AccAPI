import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { claimAuditLog, claimWorkflow } from "@/db/schema";
import {
    canActorReadClaimAudit,
    requireClaimSession,
} from "@/lib/claim-workflow";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    if (!canActorReadClaimAudit(actor)) {
        return NextResponse.json({ ok: false, error: "Role Anda tidak memiliki akses audit Claim Workflow." }, { status: 403 });
    }

    try {
        const { id } = await context.params;
        const [workflow] = await db
            .select({ id: claimWorkflow.id })
            .from(claimWorkflow)
            .where(eq(claimWorkflow.id, id));
        if (!workflow) {
            return NextResponse.json({ ok: false, error: "Claim Workflow not found" }, { status: 404 });
        }

        const audit = await db
            .select()
            .from(claimAuditLog)
            .where(eq(claimAuditLog.claimWorkflowId, id))
            .orderBy(asc(claimAuditLog.createdAt));

        return NextResponse.json({ ok: true, audit });
    } catch (error) {
        console.error("[CLAIM WORKFLOW AUDIT ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal mengambil audit Claim Workflow." }, { status: 500 });
    }
}
