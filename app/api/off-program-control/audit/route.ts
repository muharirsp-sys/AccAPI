/*
 * Tujuan: Akses audit log global OFF Program Control untuk Claim (read + export CSV).
 * Caller: page.tsx tab Audit (role Claim/Admin).
 * Dependensi: Drizzle offAuditLog/offBatch, RBAC OFF (audit_read/audit_export), search/period helper.
 * Main Functions: GET (read JSON atau export CSV).
 * Side Effects: Hanya membaca DB; tidak menulis.
 *
 * Catatan J: Claim bisa baca + export semua audit log. Tidak ada penghapusan.
 */
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { offAuditLog, offBatch } from "@/db/schema";
import {
  buildSearchHaystack,
  matchesSearch,
  requireOffSession,
} from "@/lib/off-program-control";
import { requirePermissionH } from "@/lib/rbac/resolve";

function withinPeriod(
  createdAt: Date | null,
  dateFrom: string,
  dateTo: string,
): boolean {
  if (!dateFrom && !dateTo) return true;
  if (!createdAt) return false;
  const time = createdAt.getTime();
  if (dateFrom) {
    const from = new Date(`${dateFrom}T00:00:00`).getTime();
    if (Number.isFinite(from) && time < from) return false;
  }
  if (dateTo) {
    const to = new Date(`${dateTo}T23:59:59`).getTime();
    if (Number.isFinite(to) && time > to) return false;
  }
  return true;
}

function csvEscape(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  // Cegah CSV/formula injection: cell yang diawali =, +, -, @, tab, atau CR
  // bisa dieksekusi sebagai formula di Excel/Sheets. Prefix dengan kutip tunggal.
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export async function GET(request: Request) {
  const actor = await requireOffSession();
  if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const gate = await requirePermissionH("off_program_control.audit_read");
  if (gate.response) return gate.response;

  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";
  const dateFrom = url.searchParams.get("dateFrom") || "";
  const dateTo = url.searchParams.get("dateTo") || "";
  const format = (url.searchParams.get("format") || "json").toLowerCase();

  try {
    const rows = await db
      .select({
        id: offAuditLog.id,
        batchId: offAuditLog.batchId,
        noPengajuan: offBatch.noPengajuan,
        principleName: offBatch.principleName,
        itemId: offAuditLog.itemId,
        actorId: offAuditLog.actorId,
        actorName: offAuditLog.actorName,
        actorRole: offAuditLog.actorRole,
        action: offAuditLog.action,
        fromStatus: offAuditLog.fromStatus,
        toStatus: offAuditLog.toStatus,
        note: offAuditLog.note,
        metadata: offAuditLog.metadata,
        correctedBy: offAuditLog.correctedBy,
        correctedAt: offAuditLog.correctedAt,
        correctionReason: offAuditLog.correctionReason,
        previousValue: offAuditLog.previousValue,
        newValue: offAuditLog.newValue,
        parentAuditLogId: offAuditLog.parentAuditLogId,
        createdAt: offAuditLog.createdAt,
      })
      .from(offAuditLog)
      .leftJoin(offBatch, eq(offAuditLog.batchId, offBatch.id))
      .orderBy(desc(offAuditLog.createdAt))
      .limit(5000);

    const filtered = rows.filter((row) => {
      if (!withinPeriod(row.createdAt, dateFrom, dateTo)) return false;
      if (!search) return true;
      const haystack = buildSearchHaystack([
        row.noPengajuan,
        row.principleName,
        row.actorName,
        row.actorRole,
        row.action,
        row.fromStatus,
        row.toStatus,
        row.note,
        row.correctionReason,
      ]);
      return matchesSearch(haystack, search);
    });

    if (format === "csv") {
      const header = [
        "id",
        "noPengajuan",
        "principleName",
        "action",
        "actorName",
        "actorRole",
        "fromStatus",
        "toStatus",
        "note",
        "correctionReason",
        "parentAuditLogId",
        "createdAt",
      ];
      const lines = [header.join(",")];
      for (const row of filtered) {
        lines.push(
          [
            row.id,
            row.noPengajuan,
            row.principleName,
            row.action,
            row.actorName,
            row.actorRole,
            row.fromStatus,
            row.toStatus,
            row.note,
            row.correctionReason,
            row.parentAuditLogId,
            row.createdAt ? new Date(row.createdAt).toISOString() : "",
          ]
            .map(csvEscape)
            .join(","),
        );
      }
      const csv = `\uFEFF${lines.join("\r\n")}`;
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="off-audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    return NextResponse.json({ ok: true, audit: filtered });
  } catch (error) {
    console.error("[OFF AUDIT GLOBAL ERROR]", error);
    return NextResponse.json({ ok: false, error: "Gagal mengambil audit log." }, { status: 500 });
  }
}
