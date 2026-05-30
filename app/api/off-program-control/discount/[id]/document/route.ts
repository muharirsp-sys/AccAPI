/*
 * Tujuan: Unduh dokumen pendukung pengajuan diskon SPV.
 * Caller: page.tsx Dashboard Diskon SPV (link dokumen).
 * Dependensi: Drizzle offDiscountSubmission, RBAC OFF, requireOffSession.
 * Main Functions: GET (stream file dokumen).
 * Side Effects: Membaca file dari runtime.
 */
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { offDiscountSubmission } from "@/db/schema";
import { normalizeOffRole, requireOffSession } from "@/lib/off-program-control";

type Context = { params: Promise<{ id: string }> };

function canViewDiscount(role: string) {
  const normalized = normalizeOffRole(role);
  return normalized === "supervisor" || normalized === "admin";
}

export async function GET(_request: Request, context: Context) {
  const actor = await requireOffSession();
  if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!canViewDiscount(actor.role)) {
    return NextResponse.json({ ok: false, error: "Role Anda tidak memiliki akses dokumen diskon." }, { status: 403 });
  }

  const { id } = await context.params;
  const [row] = await db.select().from(offDiscountSubmission).where(eq(offDiscountSubmission.id, id));
  if (!row || !row.documentPath) {
    return NextResponse.json({ ok: false, error: "Dokumen tidak ditemukan." }, { status: 404 });
  }

  try {
    const file = await readFile(row.documentPath);
    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": row.documentMime || "application/octet-stream",
        "Content-Disposition": `inline; filename="${(row.documentName || "dokumen").replace(/[^a-zA-Z0-9._-]+/g, "-")}"`,
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: "File dokumen tidak ditemukan." }, { status: 404 });
  }
}
