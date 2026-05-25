import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { offAuditLog, offBatch, offBatchItem, offPayment } from "@/db/schema";
import type { OffActor } from "./types";
import { canPerformOffAction, resolveOffRole, type OffAction } from "./access";

// Status batch yang No Surat-nya dianggap sudah dibatalkan / dibebaskan.
// Saat status batch berada di salah satu nilai ini, No Surat di dalamnya tidak
// dihitung sebagai bentrok untuk pengajuan baru.
const OFF_NO_SURAT_RELEASED_STATUSES = ["Cancelled by OM"] as const;

export type OffNoSuratConflict = {
    noSurat: string;
    batchId: string;
    noPengajuan: string;
    principleCode: string;
    principleName: string;
    status: string;
};

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

/**
 * Cari No Surat yang sudah dipakai batch lain pada principle yang sama.
 *
 * Aturan:
 * - Scope keunikan: per principleCode (boleh sama lintas principle berbeda).
 * - Status yang dianggap "sudah terpakai": semua kecuali Cancelled by OM.
 * - Batch sendiri (excludeBatchId) tidak dihitung supaya saat PATCH batch yang
 *   sedang diedit, item-itemnya sendiri tidak dianggap bentrok.
 *
 * Mengembalikan map dari noSurat -> daftar konflik (bisa lebih dari satu jika
 * No Surat memang sudah dipakai di beberapa batch lain).
 */
export async function findOffNoSuratConflicts(input: {
    principleCode: string;
    noSurats: string[];
    excludeBatchId?: string | null;
}): Promise<Map<string, OffNoSuratConflict[]>> {
    const result = new Map<string, OffNoSuratConflict[]>();
    const principleCode = String(input.principleCode || "").trim();
    if (!principleCode) return result;

    const candidates = Array.from(
        new Set(
            (input.noSurats || [])
                .map((value) => String(value || "").trim())
                .filter((value) => value.length > 0),
        ),
    );
    if (candidates.length === 0) return result;

    const itemConditions = [
        inArray(offBatchItem.noSurat, candidates),
        eq(offBatch.principleCode, principleCode),
    ];
    if (input.excludeBatchId) {
        itemConditions.push(ne(offBatch.id, input.excludeBatchId));
    }

    const rows = await db
        .select({
            noSurat: offBatchItem.noSurat,
            batchId: offBatch.id,
            noPengajuan: offBatch.noPengajuan,
            principleCode: offBatch.principleCode,
            principleName: offBatch.principleName,
            status: offBatch.status,
        })
        .from(offBatchItem)
        .innerJoin(offBatch, eq(offBatchItem.batchId, offBatch.id))
        .where(and(...itemConditions));

    for (const row of rows) {
        const noSurat = String(row.noSurat || "").trim();
        if (!noSurat) continue;
        if (
            OFF_NO_SURAT_RELEASED_STATUSES.includes(
                row.status as (typeof OFF_NO_SURAT_RELEASED_STATUSES)[number],
            )
        ) {
            continue;
        }
        const conflict: OffNoSuratConflict = {
            noSurat,
            batchId: row.batchId,
            noPengajuan: row.noPengajuan,
            principleCode: row.principleCode,
            principleName: row.principleName,
            status: row.status,
        };
        const existing = result.get(noSurat);
        if (existing) {
            existing.push(conflict);
        } else {
            result.set(noSurat, [conflict]);
        }
    }

    return result;
}

/**
 * Cari duplikat No Surat dalam payload itu sendiri (intra-batch).
 * Mengembalikan daftar nilai noSurat yang muncul lebih dari satu kali.
 */
export function findDuplicateNoSuratWithinPayload(noSurats: string[]): string[] {
    const counts = new Map<string, number>();
    for (const raw of noSurats) {
        const value = String(raw || "").trim();
        if (!value) continue;
        counts.set(value, (counts.get(value) || 0) + 1);
    }
    return Array.from(counts.entries())
        .filter(([, count]) => count > 1)
        .map(([value]) => value);
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
