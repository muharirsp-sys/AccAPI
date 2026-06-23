/*
 * Tujuan: API keputusan Operational Manager untuk pengajuan OFF Program Control.
 * Caller: Halaman OFF Program Control tab OM.
 * Dependensi: Better Auth OFF session, Drizzle SQLite, helper workflow/data OFF.
 * Main Functions: POST om-decision approve/cancel.
 * Side Effects: DB write SQLite dan audit log OFF.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { offBatch } from "@/db/schema";
import { getBatchWithItems, isOffPeriodClosedForBatch, publicBatch, requireOffSession, writeOffAudit } from "@/lib/off-program-control";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";

type Context = { params: Promise<{ id: string }> };

function canDecideOm(batch: { smStatus: string; claimStatus: string; omStatus: string }) {
    if (batch.smStatus !== "Approved by SM") return "Pengajuan belum disetujui Sales Manager.";
    if (batch.claimStatus !== "Approved") return "Pengajuan belum disetujui Klaim.";
    if (batch.omStatus !== "Waiting Approval") return "Pengajuan tidak sedang menunggu persetujuan OM.";
    return null;
}

export async function POST(request: Request, context: Context) {
    try {
        const actor = await requireOffSession();
        if (!actor) return NextResponse.json({ ok: false, error: "Anda tidak memiliki akses untuk melakukan tindakan ini." }, { status: 401 });
        const access = await resolveRequestPermissionsH();
        if (access.response) return access.response;
        const perms = access.perms!;
        if (!perms.has("off_program_control.om_approve") && !perms.has("off_program_control.om_cancel")) return NextResponse.json({ ok: false, error: "Role Anda tidak memiliki akses keputusan OM." }, { status: 403 });
        const { id } = await context.params;
        const data = await getBatchWithItems(id);
        if (!data) return NextResponse.json({ ok: false, error: "Pengajuan tidak ditemukan." }, { status: 404 });
        if (actor.role !== "admin" && await isOffPeriodClosedForBatch(data.batch)) {
            return NextResponse.json({ ok: false, error: "Periode ini sudah ditutup dan tidak dapat diubah." }, { status: 409 });
        }
        const invalidReason = canDecideOm(data.batch);
        if (invalidReason) return NextResponse.json({ ok: false, error: invalidReason }, { status: 409 });

        const body = await request.json().catch(() => ({}));
        const action = String(body.action || body.decision || "approve");
        const note = String(body.note || "").trim();
        const now = new Date();

        if (action === "cancel") {
            if (!note) return NextResponse.json({ ok: false, error: "Catatan wajib diisi untuk cancel." }, { status: 400 });
            await db.update(offBatch).set({
                status: "Cancelled by OM",
                omStatus: "Cancelled",
                omNote: note,
                locked: true,
                updatedAt: now,
            }).where(eq(offBatch.id, id));
            await writeOffAudit({ batchId: id, actor, action: "om_cancel", fromStatus: data.batch.omStatus, toStatus: "Cancelled", note });
            const updated = await getBatchWithItems(id);
            return NextResponse.json({
                ok: true,
                message: "Pengajuan dibatalkan oleh Operational Manager.",
                batch: updated ? publicBatch(updated.batch) : null,
            });
        }

        if (action !== "approve") return NextResponse.json({ ok: false, error: "Action OM tidak valid." }, { status: 400 });
        await db.update(offBatch).set({
            status: "OM Approved",
            omStatus: "Approved",
            financeStatus: "Waiting Payment",
            omNote: note,
            locked: true,
            updatedAt: now,
        }).where(eq(offBatch.id, id));
        await writeOffAudit({ batchId: id, actor, action: "om_approve", fromStatus: data.batch.omStatus, toStatus: "Approved", note });
        const updated = await getBatchWithItems(id);
        return NextResponse.json({
            ok: true,
            message: "Pengajuan disetujui OM dan diteruskan ke Keuangan.",
            batch: updated ? publicBatch(updated.batch) : null,
        });
    } catch (error) {
        console.error("[OFF OM DECISION ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal memproses keputusan OM." }, { status: 500 });
    }
}
