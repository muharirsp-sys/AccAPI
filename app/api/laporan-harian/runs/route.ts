/*
 * Tujuan: Daftar run Laporan Harian (report_run) + hitungan penerima per status, untuk bagian "Riwayat kirim" (Fiori S3).
 * Caller: app/(dashboard)/laporan-harian/LaporanHarian.tsx.
 * Dependensi: requirePermission("laporan_harian.view"), db/schema (reportRun, reportRunRecipient, user).
 * Main Functions: GET.
 * Side Effects: Tidak ada (SELECT saja).
 */
import { NextRequest, NextResponse } from "next/server";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { reportRun, reportRunRecipient, user } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "laporan_harian.view");
    if (gate.response) return gate.response;

    const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 30));
    const runs = await db
        .select({
            id: reportRun.id, reportDate: reportRun.reportDate, status: reportRun.status, fileCount: reportRun.fileCount,
            emailCount: reportRun.emailCount, note: reportRun.note, createdAt: reportRun.createdAt, uploadedBy: sql<string | null>`coalesce(${user.name}, ${reportRun.uploadedBy})`,
        })
        .from(reportRun)
        .leftJoin(user, eq(user.id, reportRun.uploadedBy))
        .orderBy(desc(reportRun.createdAt))
        .limit(limit);
    if (!runs.length) return NextResponse.json({ runs: [] });

    const counts = await db
        .select({ runId: reportRunRecipient.runId, sendStatus: reportRunRecipient.sendStatus, n: sql<number>`count(*)::int` })
        .from(reportRunRecipient)
        .where(inArray(reportRunRecipient.runId, runs.map((r) => r.id)))
        .groupBy(reportRunRecipient.runId, reportRunRecipient.sendStatus);
    const perRun = new Map<string, Record<string, number>>();
    for (const c of counts) perRun.set(c.runId, { ...(perRun.get(c.runId) ?? {}), [c.sendStatus]: Number(c.n) });

    return NextResponse.json({
        runs: runs.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), penerima: perRun.get(r.id) ?? {} })),
    });
}
