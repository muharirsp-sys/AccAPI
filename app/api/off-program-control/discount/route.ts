/*
 * Tujuan: API pengajuan diskon SPV (jejak digital). BELUM approval resmi.
 * Caller: page.tsx Dashboard Diskon SPV (role Supervisor; Admin read-only + note).
 * Dependensi: Drizzle offDiscountSubmission/offDiscountAuditLog, RBAC OFF, search helper.
 * Main Functions: GET (list + filter), POST (create + audit + optional dokumen).
 * Side Effects: INSERT submission + audit; simpan dokumen opsional ke runtime.
 *
 * Catatan I:
 * - Modul terpisah; data diskon hanya muncul di SPV (dan Admin read-only).
 * - Workflow approval belum aktif; status hanya disiapkan untuk masa depan.
 * - Tidak memunculkan data ke Claim/Finance/OM dan bukan syarat workflow OFF.
 */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { offDiscountAuditLog, offDiscountSubmission } from "@/db/schema";
import {
  buildSearchHaystack,
  matchesSearch,
  normalizeOffRole,
  parseCurrency,
  requireOffSession,
} from "@/lib/off-program-control";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";

function withinPeriod(tanggal: string, dateFrom: string, dateTo: string): boolean {
  if (!dateFrom && !dateTo) return true;
  const value = String(tanggal || "").trim();
  if (!value) return false;
  if (dateFrom && value < dateFrom) return false;
  if (dateTo && value > dateTo) return false;
  return true;
}

function sanitizeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "discount-doc";
}

function docMimeOk(type: string) {
  return ["application/pdf", "image/png", "image/jpeg", "image/jpg"].includes(type);
}

function publicSubmission(row: typeof offDiscountSubmission.$inferSelect) {
  const safe = { ...row } as Partial<typeof offDiscountSubmission.$inferSelect>;
  delete safe.documentPath;
  return {
    ...safe,
    documentUrl: row.documentPath
      ? `/api/off-program-control/discount/${row.id}/document`
      : null,
  };
}

export async function GET(request: Request) {
  const actor = await requireOffSession();
  if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const access = await resolveRequestPermissionsH();
  if (access.response) return access.response;
  const perms = access.perms!;
  if (!perms.has("off_program_control.discount_view")) {
    return NextResponse.json({ ok: false, error: "Role Anda tidak memiliki akses dashboard diskon SPV." }, { status: 403 });
  }

  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";
  const dateFrom = url.searchParams.get("dateFrom") || "";
  const dateTo = url.searchParams.get("dateTo") || "";

  try {
    const rows = await db
      .select()
      .from(offDiscountSubmission)
      .orderBy(desc(offDiscountSubmission.createdAt))
      .limit(2000);

    // Isolasi per-supervisor: SPV hanya melihat pengajuan diskon miliknya sendiri.
    // Admin tetap melihat semua (read-only).
    const isSupervisor = normalizeOffRole(actor.role) === "supervisor";
    const filtered = rows.filter((row) => {
      if (isSupervisor && row.createdById !== actor.id) return false;
      if (!withinPeriod(row.tanggal || "", dateFrom, dateTo)) return false;
      if (!search) return true;
      const haystack = buildSearchHaystack([
        row.toko,
        row.principleName,
        row.principleCode,
        row.program,
        row.alasan,
        row.status,
        row.createdByName,
        row.catatan,
      ]);
      return matchesSearch(haystack, search);
    });

    return NextResponse.json({
      ok: true,
      readOnly: !perms.has("off_program_control.discount_manage"),
      submissions: filtered.map(publicSubmission),
    });
  } catch (error) {
    console.error("[OFF DISCOUNT LIST ERROR]", error);
    return NextResponse.json({ ok: false, error: "Gagal mengambil pengajuan diskon." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireOffSession();
    if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    const access = await resolveRequestPermissionsH();
    if (access.response) return access.response;
    const perms = access.perms!;
    if (!perms.has("off_program_control.discount_manage")) {
      return NextResponse.json({ ok: false, error: "Hanya Supervisor yang dapat membuat pengajuan diskon." }, { status: 403 });
    }

    const formData = await request.formData();
    const toko = String(formData.get("toko") || "").trim();
    const principleName = String(formData.get("principleName") || "").trim();
    const principleCode = String(formData.get("principleCode") || "").trim();
    const program = String(formData.get("program") || "").trim();
    const nominal = parseCurrency(formData.get("nominal"));
    const alasan = String(formData.get("alasan") || "").trim();
    const tanggal = String(formData.get("tanggal") || "").trim();
    const catatan = String(formData.get("catatan") || "").trim();
    const doc = formData.get("document");

    if (!toko) return NextResponse.json({ ok: false, error: "Toko/customer wajib diisi." }, { status: 400 });
    if (!nominal || nominal <= 0) return NextResponse.json({ ok: false, error: "Nominal diskon wajib lebih dari 0." }, { status: 400 });

    const now = new Date();
    const id = randomUUID();

    // Dokumen pendukung opsional.
    let documentPath: string | null = null;
    let documentName: string | null = null;
    let documentMime: string | null = null;
    let documentSize: number | null = null;
    if (doc instanceof File && doc.size > 0) {
      if (!docMimeOk(doc.type)) return NextResponse.json({ ok: false, error: "Dokumen harus PDF/PNG/JPG/JPEG." }, { status: 400 });
      if (doc.size > 5 * 1024 * 1024) return NextResponse.json({ ok: false, error: "Ukuran dokumen maksimal 5MB." }, { status: 400 });
      const dir = path.join(process.cwd(), "runtime", "off-program-control", "discount-docs", id);
      fs.mkdirSync(dir, { recursive: true });
      const storedName = `${sanitizeFileName(toko)}-${sanitizeFileName(doc.name)}`;
      const storedPath = path.join(dir, storedName);
      fs.writeFileSync(storedPath, Buffer.from(await doc.arrayBuffer()));
      documentPath = storedPath;
      documentName = doc.name;
      documentMime = doc.type;
      documentSize = doc.size;
    }

    await db.insert(offDiscountSubmission).values({
      id,
      toko,
      principleCode: principleCode || null,
      principleName: principleName || null,
      program: program || null,
      nominal,
      alasan: alasan || null,
      tanggal: tanggal || null,
      status: "Tercatat",
      catatan: catatan || null,
      documentPath,
      documentName,
      documentMime,
      documentSize,
      createdById: actor.id,
      createdByName: actor.name,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(offDiscountAuditLog).values({
      id: randomUUID(),
      submissionId: id,
      actorId: actor.id,
      actorName: actor.name,
      actorRole: actor.role,
      action: "discount_create",
      note: `Pengajuan diskon dibuat untuk ${toko}.`,
      metadata: { nominal, principleCode, program, hasDocument: Boolean(documentPath) },
      createdAt: now,
    });

    return NextResponse.json({ ok: true, id, message: "Pengajuan diskon tercatat sebagai jejak digital." });
  } catch (error) {
    console.error("[OFF DISCOUNT CREATE ERROR]", error);
    return NextResponse.json({ ok: false, error: "Gagal menyimpan pengajuan diskon." }, { status: 500 });
  }
}
