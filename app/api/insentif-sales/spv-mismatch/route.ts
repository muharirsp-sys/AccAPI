/*
 * Tujuan: Deteksi + sinkronisasi SPV yang tidak cocok antara file target (sales_targets.spv_name)
 *   dan file closing (sales_daily_progress.spv_name, asalnya kolom GOLONGAN).
 * Caller: app/(dashboard)/insentif-sales/page.tsx → SpvMismatchSection.
 * Dependensi: db/schema (salesTargets, salesDailyProgress, spvSalesAssignment), lib/rbac/resolve.
 * Main Functions: GET daftar ketidaksinkronan per periode; POST sinkronkan 1 baris ke SPV pilihan.
 * Side Effects: POST menulis sales_targets.spv_name + spv_sales_assignment (agar scope hierarki ikut).
 *
 * Catatan: satu salesCode+principle bisa punya >1 SPV di closing (mis. pindah tengah bulan).
 * Semua kandidat dikembalikan; user memilih mana yang benar — sistem tidak menebak.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { salesDailyProgress, salesTargets, spvSalesAssignment } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";

export interface SpvMismatchRow {
    salesCode: string;
    salesName: string;
    principle: string;
    spvTarget: string | null;
    spvClosing: string[];
}

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;

    const { searchParams } = req.nextUrl;
    const now = new Date();
    const month = parseInt(searchParams.get("month") ?? String(now.getMonth() + 1), 10);
    const year = parseInt(searchParams.get("year") ?? String(now.getFullYear()), 10);

    const [targets, closing] = await Promise.all([
        db
            .select({
                salesCode: salesTargets.salesCode,
                salesName: salesTargets.salesName,
                principle: salesTargets.principle,
                spvName: salesTargets.spvName,
            })
            .from(salesTargets)
            .where(and(eq(salesTargets.periodMonth, month), eq(salesTargets.periodYear, year))),
        db
            .selectDistinct({
                salesCode: salesDailyProgress.salesCode,
                principle: salesDailyProgress.principle,
                spvName: salesDailyProgress.spvName,
            })
            .from(salesDailyProgress)
            .where(
                and(
                    eq(salesDailyProgress.periodMonth, month),
                    eq(salesDailyProgress.periodYear, year),
                    isNotNull(salesDailyProgress.spvName),
                ),
            ),
    ]);

    const closingMap = new Map<string, string[]>();
    for (const c of closing) {
        if (!c.spvName) continue;
        const k = `${c.salesCode}|${c.principle}`;
        const arr = closingMap.get(k) ?? [];
        if (!arr.includes(c.spvName)) arr.push(c.spvName);
        closingMap.set(k, arr);
    }

    const rows: SpvMismatchRow[] = [];
    for (const t of targets) {
        const spvClosing = closingMap.get(`${t.salesCode}|${t.principle}`);
        if (!spvClosing || spvClosing.length === 0) continue; // closing belum punya data SPV → bukan mismatch
        // Sinkron kalau SPV target ada di daftar SPV closing dan closing cuma menyebut satu nama.
        if (spvClosing.length === 1 && t.spvName === spvClosing[0]) continue;
        rows.push({ salesCode: t.salesCode, salesName: t.salesName, principle: t.principle, spvTarget: t.spvName, spvClosing });
    }

    return NextResponse.json({ month, year, count: rows.length, rows });
}

interface SyncInput {
    salesCode: string;
    principle: string;
    periodMonth: number;
    periodYear: number;
    spvName: string; // nama SPV yang dipilih sebagai benar
}

export async function POST(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.manage_hierarchy");
    if (gate.response) return gate.response;

    let body: SyncInput;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const spvName = body.spvName?.trim();
    if (!body.salesCode || !body.principle || !body.periodMonth || !body.periodYear || !spvName) {
        return NextResponse.json({ error: "salesCode, principle, periodMonth, periodYear, spvName wajib" }, { status: 400 });
    }

    const now = new Date();
    const updated = await db
        .update(salesTargets)
        .set({ spvName, updatedAt: now })
        .where(
            and(
                eq(salesTargets.salesCode, body.salesCode),
                eq(salesTargets.principle, body.principle),
                eq(salesTargets.periodMonth, body.periodMonth),
                eq(salesTargets.periodYear, body.periodYear),
            ),
        )
        .returning({ id: salesTargets.id });

    if (updated.length === 0) {
        return NextResponse.json({ error: "Baris target tidak ditemukan" }, { status: 404 });
    }

    // Ikutkan mapping hierarki supaya scope SPV/SM (lib/insentif-hierarchy-scope) konsisten.
    const [existing] = await db
        .select({ id: spvSalesAssignment.id })
        .from(spvSalesAssignment)
        .where(eq(spvSalesAssignment.salesCode, body.salesCode))
        .limit(1);
    if (existing) {
        await db.update(spvSalesAssignment).set({ spvName, updatedAt: now }).where(eq(spvSalesAssignment.id, existing.id));
    } else {
        await db.insert(spvSalesAssignment).values({
            id: randomUUID(), salesCode: body.salesCode, spvName, createdAt: now, updatedAt: now,
        });
    }

    return NextResponse.json({ synced: updated.length, spvName });
}
