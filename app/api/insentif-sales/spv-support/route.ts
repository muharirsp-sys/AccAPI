/*
 * Tujuan: CRUD support principle untuk SPV (per SPV per principal per periode).
 * Caller: app/(dashboard)/insentif-sales/page.tsx → SpvSupportInputSection (view Finance).
 * Dependensi: db/schema (spvSupport), lib/rbac/resolve.
 * Main Functions: GET daftar support periode; POST upsert batch.
 * Side Effects: POST menulis spv_support. Dibaca app/api/insentif-sales/spv-dashboard.
 *
 * Angka ini tidak bisa diturunkan dari support per-sales — rasionya beda per principal
 * (KINO 10%, MOTASA 50% dari total support sales-nya), jadi harus diinput manual.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { spvSupport } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;

    const { searchParams } = req.nextUrl;
    const now = new Date();
    const month = parseInt(searchParams.get("month") ?? String(now.getMonth() + 1), 10);
    const year = parseInt(searchParams.get("year") ?? String(now.getFullYear()), 10);

    const rows = await db
        .select()
        .from(spvSupport)
        .where(and(eq(spvSupport.periodMonth, month), eq(spvSupport.periodYear, year)));

    return NextResponse.json({ month, year, rows });
}

interface SpvSupportInput {
    spvName: string;
    principle: string;
    periodMonth: number;
    periodYear: number;
    supportAmount: number;
}

export async function POST(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.input_support");
    if (gate.response) return gate.response;

    let body: SpvSupportInput[];
    try {
        const raw = await req.json();
        body = Array.isArray(raw) ? raw : [raw];
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const now = new Date();

    // PASS 1: validasi seluruh payload dulu — `return 400` di tengah loop tulis meninggalkan
    // sebagian support sudah commit, dan support memengaruhi nominal insentif SPV.
    const prepared: Array<{ spvName: string; principle: string; periodMonth: number; periodYear: number; amount: number }> = [];
    for (const s of body) {
        const spvName = s.spvName?.trim();
        const principle = s.principle?.trim();
        if (!spvName || !principle || !s.periodMonth || !s.periodYear) continue;

        const amount = Number(s.supportAmount);
        if (!Number.isFinite(amount) || amount < 0) {
            return NextResponse.json(
                { error: `${spvName}/${principle}: nilai support tidak valid` },
                { status: 400 },
            );
        }
        prepared.push({ spvName, principle, periodMonth: s.periodMonth, periodYear: s.periodYear, amount });
    }

    // PASS 2: satu transaksi.
    let upserted = 0;
    await db.transaction(async (tx) => {
        for (const p of prepared) {
            // uq_spv_support sudah ada di produksi sejak awal — pakai langsung.
            await tx.insert(spvSupport)
                .values({
                    id: randomUUID(), spvName: p.spvName, principle: p.principle,
                    periodMonth: p.periodMonth, periodYear: p.periodYear,
                    supportAmount: p.amount, inputBy: gate.session.user.id,
                    createdAt: now, updatedAt: now,
                })
                .onConflictDoUpdate({
                    target: [spvSupport.spvName, spvSupport.principle, spvSupport.periodMonth, spvSupport.periodYear],
                    set: { supportAmount: p.amount, inputBy: gate.session.user.id, updatedAt: now },
                });
            upserted++;
        }
    });

    return NextResponse.json({ upserted });
}
