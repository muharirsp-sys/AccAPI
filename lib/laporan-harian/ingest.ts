/*
 * Tujuan: Ingestion batch hasil pipeline Laporan Harian ke sales_daily_progress (feed dashboard).
 *         Ganti pola N+1 (SELECT dedup + insert per baris) di /api/insentif-sales/progress dengan
 *         strategi replace-per-periode + bulk insert (minimum I/O, idempotent per bulan-tahun).
 * Caller: app/api/laporan-harian/upload/route.ts (Tahap 3).
 * Dependensi: lib/db (Drizzle PostgreSQL), db/schema (salesDailyProgress), progress-normalize.
 * Main Functions: replaceDailyProgressForPeriod.
 * Side Effects: DB delete (scoped periode) + bulk insert dalam 1 transaksi.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { salesDailyProgress } from "@/db/schema";
import type { DailyProgressRow } from "./progress-normalize";

const CHUNK = 400; // SQLite ~999 var limit; 11 kolom/baris -> aman di bawah batas

/**
 * Replace seluruh baris progress untuk (bulan, tahun) tertentu dengan data baru, dalam 1 transaksi.
 * Idempotent: menjalankan ulang periode yang sama menghasilkan state sama (bukan duplikat).
 */
export async function replaceDailyProgressForPeriod(
    month: number,
    year: number,
    rows: DailyProgressRow[],
    uploadedBy?: string,
): Promise<{ deleted: boolean; inserted: number }> {
    const now = new Date();
    return db.transaction(async (tx) => {
        await tx
            .delete(salesDailyProgress)
            .where(and(eq(salesDailyProgress.periodMonth, month), eq(salesDailyProgress.periodYear, year)));

        let inserted = 0;
        for (let i = 0; i < rows.length; i += CHUNK) {
            const chunk = rows.slice(i, i + CHUNK).map((p) => ({
                id: randomUUID(),
                salesCode: p.salesCode,
                principle: p.principle,
                branch: p.branch,
                date: p.date,
                periodMonth: p.periodMonth,
                periodYear: p.periodYear,
                invoiceNumber: p.invoiceNumber ?? null,
                achievedValueDpp: p.achievedValueDpp,
                achievedEc: p.achievedEc,
                achievedAo: p.achievedAo,
                achievedIa: p.achievedIa,
                uploadedBy: uploadedBy ?? null,
                createdAt: now,
            }));
            if (chunk.length) {
                await tx.insert(salesDailyProgress).values(chunk);
                inserted += chunk.length;
            }
        }
        return { deleted: true, inserted };
    });
}
