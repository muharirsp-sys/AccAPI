/*
 * Tujuan: Daftar kombinasi (kode sales × principal) di data harian yang TIDAK punya target,
 *   lengkap dengan contoh nomor nota supaya bisa ditelusuri siapa salesman sebenarnya.
 * Caller: app/(dashboard)/insentif-sales/page.tsx — spanduk status Laporan Harian.
 * Dependensi: lib/db, db/schema, lib/insentif-sales (getMergeMap), lib/rbac/resolve.
 * Main Functions: GET ?month&year.
 * Side Effects: DB read saja.
 *
 * Dipisah dari /dashboard dengan sengaja: query ini hanya dibutuhkan saat seseorang membuka
 * daftarnya, dan menempelkannya ke jalur utama berarti setiap pemuatan dashboard membayar
 * biaya agregasi nota yang hampir selalu tidak dilihat.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { salesDailyProgress, salesTargets } from "@/db/schema";
import { getMergeMap } from "@/lib/insentif-sales";
import { requirePermission } from "@/lib/rbac/resolve";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;

    const { searchParams } = req.nextUrl;
    const now = new Date();
    const month = parseInt(searchParams.get("month") ?? String(now.getMonth() + 1), 10);
    const year = parseInt(searchParams.get("year") ?? String(now.getFullYear()), 10);

    const [progress, targets, mergeMap] = await Promise.all([
        db
            .select({
                salesCode: salesDailyProgress.salesCode,
                principle: salesDailyProgress.principle,
                branch: sql<string>`MIN(${salesDailyProgress.branch})`,
                baris: sql<number>`COUNT(*)::double precision`,
                dpp: sql<number>`SUM(${salesDailyProgress.achievedValueDpp})::double precision`,
                tanggalAwal: sql<string>`MIN(${salesDailyProgress.date})`,
                tanggalAkhir: sql<string>`MAX(${salesDailyProgress.date})`,
                // Lima nota pertama cukup untuk menelusuri di Accurate; menarik semuanya bisa
                // berarti ribuan nomor per baris dan tidak menambah kemampuan siapa pun.
                contohNota: sql<string[]>`(ARRAY_REMOVE(ARRAY_AGG(DISTINCT ${salesDailyProgress.invoiceNumber}), NULL))[1:5]`,
            })
            .from(salesDailyProgress)
            .where(and(eq(salesDailyProgress.periodMonth, month), eq(salesDailyProgress.periodYear, year)))
            .groupBy(salesDailyProgress.salesCode, salesDailyProgress.principle),
        db
            .select({
                salesCode: salesTargets.salesCode,
                principle: salesTargets.principle,
                targetValue: salesTargets.targetValue,
            })
            .from(salesTargets)
            .where(and(eq(salesTargets.periodMonth, month), eq(salesTargets.periodYear, year))),
        getMergeMap(month, year),
    ]);

    // Target 0 = tidak ada target. Sejak 2026-08-29 baris seperti itu tidak dibayar sama sekali
    // (keputusan user), jadi ia harus muncul di daftar peringatan ini — bukan diam-diam
    // dianggap "sudah punya target" hanya karena barisnya ada.
    const punyaTarget = new Set(
        targets.filter((t) => t.targetValue > 0).map((t) => `${t.salesCode}|${t.principle}`),
    );
    const targetNol = new Set(
        targets.filter((t) => !(t.targetValue > 0)).map((t) => `${t.salesCode}|${t.principle}`),
    );
    // Kode yang sudah digabungkan ke kode lain BUKAN yatim: realisasinya memang dihitung
    // di bawah kode tujuan. Tanpa cek ini, setiap penggabungan yang sudah diputuskan akan
    // muncul lagi di daftar "perlu dipetakan".
    const rows = progress
        .filter((p) => {
            const tujuan = mergeMap.get(p.salesCode) ?? p.salesCode;
            return !punyaTarget.has(`${p.salesCode}|${p.principle}`)
                && !punyaTarget.has(`${tujuan}|${p.principle}`);
        })
        .map((p) => ({
            ...p,
            contohNota: p.contohNota ?? [],
            sebab: targetNol.has(`${p.salesCode}|${p.principle}`)
                ? ("target 0" as const)
                : ("tanpa baris target" as const),
        }))
        .sort((a, b) => b.dpp - a.dpp);

    return NextResponse.json({ month, year, rows });
}
