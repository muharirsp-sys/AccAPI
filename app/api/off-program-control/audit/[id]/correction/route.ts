/*
 * Tujuan: Koreksi audit log OFF (non-destruktif) oleh Claim.
 * Caller: page.tsx tab Audit (role Claim/Admin) tombol koreksi.
 * Dependensi: Drizzle offAuditLog, RBAC OFF (audit_correct), requireOffSession.
 * Main Functions: POST (membuat record koreksi baru tanpa menghapus jejak lama).
 * Side Effects: INSERT record audit baru; record lama TIDAK diubah/dihapus.
 *
 * Catatan J:
 * - Walau disebut "edit", implementasi tidak menghapus jejak lama.
 * - Setiap correction membuat audit log baru (parentAuditLogId menunjuk record asal).
 * - Snapshot previousValue & newValue disimpan agar Admin bisa melihat sebelum/sesudah.
 * - Tidak ada permanent delete.
 */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { offAuditLog } from "@/db/schema";
import {
  requireOffSession,
} from "@/lib/off-program-control";
import { requirePermissionH } from "@/lib/rbac/resolve";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const actor = await requireOffSession();
    if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    const gate = await requirePermissionH("off_program_control.audit_correct");
    if (gate.response) return gate.response;

    const { id } = await context.params;
    const [original] = await db.select().from(offAuditLog).where(eq(offAuditLog.id, id));
    if (!original) {
      return NextResponse.json({ ok: false, error: "Audit log tidak ditemukan." }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const correctionReason = String(body.correctionReason || body.reason || "").trim();
    const newNote = body.note !== undefined ? String(body.note || "").trim() : original.note;
    const newToStatus = body.toStatus !== undefined ? String(body.toStatus || "").trim() : original.toStatus;
    const newFromStatus = body.fromStatus !== undefined ? String(body.fromStatus || "").trim() : original.fromStatus;

    if (!correctionReason) {
      return NextResponse.json({ ok: false, error: "Alasan koreksi wajib diisi." }, { status: 400 });
    }

    const now = new Date();
    // Snapshot nilai sebelum & sesudah (tanpa mengubah record asal).
    const previousValue = {
      action: original.action,
      fromStatus: original.fromStatus,
      toStatus: original.toStatus,
      note: original.note,
    };
    const newValue = {
      action: original.action,
      fromStatus: newFromStatus,
      toStatus: newToStatus,
      note: newNote,
    };

    const correctionId = randomUUID();
    await db.insert(offAuditLog).values({
      id: correctionId,
      batchId: original.batchId,
      itemId: original.itemId,
      actorId: actor.id,
      actorName: actor.name,
      actorRole: actor.role,
      action: "audit_correction",
      fromStatus: newFromStatus || null,
      toStatus: newToStatus || null,
      note: newNote || null,
      metadata: { correctedAuditLogId: id, originalAction: original.action },
      correctedBy: actor.id,
      correctedAt: now,
      correctionReason,
      previousValue,
      newValue,
      parentAuditLogId: id,
      createdAt: now,
    });

    return NextResponse.json({
      ok: true,
      message: "Koreksi tercatat sebagai riwayat baru tanpa menghapus jejak lama.",
      correctionId,
      parentAuditLogId: id,
    });
  } catch (error) {
    console.error("[OFF AUDIT CORRECTION ERROR]", error);
    return NextResponse.json({ ok: false, error: "Gagal menyimpan koreksi audit log." }, { status: 500 });
  }
}
