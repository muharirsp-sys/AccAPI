import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { claimAuditLog, claimWorkflow } from "@/db/schema";
import {
    requireClaimSession,
} from "@/lib/claim-workflow";
import { requirePermissionH } from "@/lib/rbac/resolve";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const gate = await requirePermissionH("claim_workflow.approve");
    if (gate.response) return gate.response;

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
