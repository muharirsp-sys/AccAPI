/*
 * Tujuan: CRUD support principle per salesman (insentif GT). Diisi Finance saat payout.
 * Caller: app/(dashboard)/insentif-sales/page.tsx Finance panel.
 * Dependensi: lib/insentif-sales (session), db/schema (incentiveSupport).
 * Main Functions: GET list support per periode; POST upsert batch (key: salesCode+principle+period).
 * Side Effects: DB read + write.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { incentiveSupport } from "@/db/schema";
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
        .from(incentiveSupport)
        .where(and(eq(incentiveSupport.periodMonth, month), eq(incentiveSupport.periodYear, year)));
    return NextResponse.json({ month, year, rows });
}

interface SupportInput {
    salesCode: string;
    principle: string;
    periodMonth: number;
    periodYear: number;
    supportAmount: number;
}

export async function POST(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.input_support");
    if (gate.response) return gate.response;
    const actorName = gate.session.user.name ?? gate.session.user.email ?? "Unknown";

    let body: SupportInput[];
    try {
        const raw = await req.json();
        body = Array.isArray(raw) ? raw : [raw];
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const now = new Date();

    // PASS 1: validasi seluruh payload sebelum menyentuh DB. Dulu `return 400` terjadi di
    // tengah loop tulis, sehingga "setengah support masuk" — dan karena support dikurangkan
    // dari konstanta insentif, itu berarti nominal SEBAGIAN orang salah tanpa ada yang tahu.
    const rows = body.filter((s) => s.salesCode && s.principle && s.periodMonth && s.periodYear);
    const prepared: Array<{ s: SupportInput; amount: number }> = [];
    for (const s of rows) {
        const amount = Number(s.supportAmount);
        // Number(x) || 0 lama meloloskan Infinity (Infinity > 0), lalu "konstanta − Infinity"
        // ter-floor jadi 0 → insentif sales itu hilang tanpa error ke Finance.
        if (!Number.isFinite(amount) || amount < 0) {
            return NextResponse.json(
                { error: `Support tidak valid: ${s.salesCode}/${s.principle} (${String(s.supportAmount)})` },
                { status: 400 },
            );
        }
        prepared.push({ s, amount });
    }

    // PASS 2: tulis seluruhnya dalam satu transaksi — gagal di tengah = rollback penuh.
    let upserted = 0;
    await db.transaction(async (tx) => {
        for (const { s, amount } of prepared) {
            const [existing] = await tx
                .select({ id: incentiveSupport.id })
                .from(incentiveSupport)
                .where(
                    and(
                        eq(incentiveSupport.salesCode, s.salesCode),
                        eq(incentiveSupport.principle, s.principle),
                        eq(incentiveSupport.periodMonth, s.periodMonth),
                        eq(incentiveSupport.periodYear, s.periodYear),
                    ),
                )
                .limit(1);

            if (existing) {
                await tx
                    .update(incentiveSupport)
                    .set({ supportAmount: amount, inputBy: actorName, updatedAt: now })
                    .where(eq(incentiveSupport.id, existing.id));
            } else {
                await tx.insert(incentiveSupport).values({
                    id: randomUUID(),
                    salesCode: s.salesCode,
                    principle: s.principle,
                    periodMonth: s.periodMonth,
                    periodYear: s.periodYear,
                    supportAmount: amount,
                    inputBy: actorName,
                    createdAt: now,
                    updatedAt: now,
                });
            }
            upserted++;
        }
    });

    return NextResponse.json({ upserted });
}
