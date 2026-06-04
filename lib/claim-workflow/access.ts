import { eq } from "drizzle-orm";
import {
    canActorAccessOffData,
    requireOffSession,
} from "@/lib/off-program-control";
import { db } from "@/lib/db";
import { user } from "@/db/schema";
import { canAccess } from "@/lib/rbac";
import type { ClaimActor } from "./types";

/**
 * Actor untuk Claim Workflow. Memperluas OffActor dengan role dan permission
 * mentah dari tabel `user`, agar gating bisa memakai kedua model role
 * (OFF heuristic + RBAC modular).
 */
export type ClaimSessionActor = ClaimActor & {
    rawRole: string | null;
    rawPermissions: unknown;
};

export async function requireClaimSession(): Promise<ClaimSessionActor | null> {
    const offActor = await requireOffSession();
    if (!offActor) return null;
    const [row] = await db
        .select({ role: user.role, permissions: user.permissions })
        .from(user)
        .where(eq(user.id, offActor.id));
    return {
        ...offActor,
        rawRole: row?.role ?? null,
        rawPermissions: row?.permissions ?? null,
    };
}

/**
 * Gate luas: dapat melihat list/aggregate Claim Workflow.
 * Mempertahankan kompat dengan logic OFF (role ≠ unknown/sales).
 */
export function canActorAccessClaimData(actor: ClaimActor | null): boolean {
    return canActorAccessOffData(actor);
}

function isPrivilegedClaimRole(actor: ClaimSessionActor | null): boolean {
    return Boolean(actor && (actor.role === "admin" || actor.role === "claim"));
}

/**
 * Gate detail workflow (item, payment, totals). Lebih ketat dari list:
 * harus admin/claim ATAU memiliki permission `claim_workflow.view` yang
 * eksplisit di RBAC.
 */
export function canActorReadClaimWorkflow(actor: ClaimSessionActor | null): boolean {
    if (!actor) return false;
    if (isPrivilegedClaimRole(actor)) return true;
    return canAccess("claim_workflow", "view", actor.rawRole, actor.rawPermissions);
}

/**
 * Gate audit log. Audit menyimpan catatan keputusan dan PII actor, jadi
 * hanya admin/claim atau permission `claim_workflow.approve` (manager
 * level) yang boleh membaca.
 */
export function canActorReadClaimAudit(actor: ClaimSessionActor | null): boolean {
    if (!actor) return false;
    if (isPrivilegedClaimRole(actor)) return true;
    return canAccess("claim_workflow", "approve", actor.rawRole, actor.rawPermissions);
}

/**
 * Gate pembuatan workflow baru. Creation from OFF is a workflow boundary,
 * jadi hanya resolved OFF role admin/claim yang boleh melakukannya.
 *
 * Penting: gate ini SENGAJA tidak fallback ke `canAccess("claim_workflow",
 * "create", ...)`. Walaupun RBAC modular punya action `create`, role staff
 * (dan custom permission) tidak boleh dipakai untuk membuat Claim Workflow
 * dari OFF. No Surat dan komponen pajak adalah data pajak yang sensitif,
 * jadi pembuatan harus tetap eksklusif admin/claim.
 */
export function canActorCreateClaimWorkflow(actor: ClaimSessionActor | null): boolean {
    return isPrivilegedClaimRole(actor);
}
