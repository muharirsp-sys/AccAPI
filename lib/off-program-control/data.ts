import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { eq, asc } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { offAuditLog, offBatch, offBatchItem, offPayment } from "@/db/schema";
import type { OffActor } from "./types";
import { canPerformOffAction, resolveOffRole, type OffAction } from "./access";

export async function requireOffSession() {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return null;
    const user = session.user as typeof session.user & {
        userRole?: unknown;
        type?: unknown;
        position?: unknown;
        department?: unknown;
    };
    const { role } = resolveOffRole({
        role: user.role,
        userRole: user.userRole,
        type: user.type,
        position: user.position,
        department: user.department,
        email: session.user.email,
    });
    return {
        id: session.user.id,
        name: session.user.name || session.user.email || "Unknown User",
        role,
    };
}

export function canActorPerformOffAction(actor: OffActor | null, action: OffAction) {
    return Boolean(actor && canPerformOffAction(actor.role, action));
}

export function canActorAccessOffData(actor: OffActor | null) {
    return Boolean(actor && actor.role !== "unknown" && actor.role !== "sales");
}

export async function getBatchWithItems(batchId: string) {
    const [batch] = await db.select().from(offBatch).where(eq(offBatch.id, batchId));
    if (!batch) return null;
    const items = await db.select().from(offBatchItem).where(eq(offBatchItem.batchId, batchId)).orderBy(asc(offBatchItem.itemNo));
    const payments = await db.select().from(offPayment).where(eq(offPayment.batchId, batchId)).orderBy(asc(offPayment.paymentNo));
    return { batch, items, payments };
}

export async function writeOffAudit(input: {
    batchId: string;
    itemId?: string | null;
    actor?: OffActor | null;
    action: string;
    fromStatus?: string | null;
    toStatus?: string | null;
    note?: string | null;
    metadata?: unknown;
}) {
    await db.insert(offAuditLog).values({
        id: randomUUID(),
        batchId: input.batchId,
        itemId: input.itemId || null,
        actorId: input.actor?.id || null,
        actorName: input.actor?.name || null,
        actorRole: input.actor?.role || null,
        action: input.action,
        fromStatus: input.fromStatus || null,
        toStatus: input.toStatus || null,
        note: input.note || null,
        metadata: input.metadata ? input.metadata as Record<string, unknown> : null,
        createdAt: new Date(),
    });
}
