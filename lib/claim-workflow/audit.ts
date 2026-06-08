import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { claimAuditLog } from "@/db/schema";
import type { ClaimActor } from "./types";

function normalizeMetadata(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

type AuditWriter = Pick<typeof db, "insert">;

/**
 * Phase R7b — Multi No Claim:
 * Audit row dapat di-attach ke `claim_submission` lewat
 * `claimSubmissionId` + `auditScope = "submission"`. Default tetap
 * workflow-scope supaya audit existing R1-R6 tidak ikut berubah.
 */
export async function writeClaimAudit(input: {
    claimWorkflowId: string;
    actor?: ClaimActor | null;
    action: string;
    fromStatus?: string | null;
    toStatus?: string | null;
    note?: string | null;
    metadata?: unknown;
    claimSubmissionId?: string | null;
    auditScope?: "workflow" | "submission" | null;
}, writer: AuditWriter = db) {
    await writer.insert(claimAuditLog).values({
        id: randomUUID(),
        claimWorkflowId: input.claimWorkflowId,
        claimSubmissionId: input.claimSubmissionId ?? null,
        auditScope: input.auditScope ?? null,
        actorId: input.actor?.id || null,
        actorName: input.actor?.name || null,
        actorRole: input.actor?.role || null,
        action: input.action,
        fromStatus: input.fromStatus || null,
        toStatus: input.toStatus || null,
        note: input.note || null,
        metadata: normalizeMetadata(input.metadata),
        createdAt: new Date(),
    });
}
