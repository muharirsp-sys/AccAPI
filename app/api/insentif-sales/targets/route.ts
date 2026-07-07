/*
 * Tujuan: CRUD targets bulanan Insentif Sales.
 * Caller: app/(dashboard)/insentif-sales/page.tsx admin panel (SPV/SM input target tim sendiri;
 *   Admin upload laporan penjualan lewat route progress, bukan di sini).
 * Dependensi: lib/insentif-sales, db/schema (salesTargets, spvSalesAssignment),
 *   lib/insentif-hierarchy-scope.
 * Main Functions: GET list targets per periode (scoped kalau caller SPV/SM); POST upsert batch
 *   targets (scoped: SPV/SM cuma boleh tulis salesCode timnya; salesCode BARU/unclaimed oleh
 *   SPV -> otomatis di-claim jadi tim SPV itu; salesCode milik SPV LAIN -> ditolak, arahkan ke
 *   Kelola Hierarki utk proses klaim/approval).
 * Side Effects: DB read + write (upsert by salesCode+principle+periodMonth+periodYear).
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { salesTargets, spvSalesAssignment } from "@/db/schema";
import { getTargetsForPeriod } from "@/lib/insentif-sales";
import { requirePermission } from "@/lib/rbac/resolve";
import { normalizeStatus, normalizeTipe } from "@/lib/insentif-sales-calc";
import { getScopeForUser, getUserHierarchyIdentity, getCurrentSpvOwner } from "@/lib/insentif-hierarchy-scope";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;

    const { searchParams } = req.nextUrl;
    const now = new Date();
    const month = parseInt(searchParams.get("month") ?? String(now.getMonth() + 1), 10);
    const year = parseInt(searchParams.get("year") ?? String(now.getFullYear()), 10);
    const principle = searchParams.get("principle") ?? undefined;
    const branch = searchParams.get("branch") ?? undefined;

    const [rawRows, scope] = await Promise.all([
        getTargetsForPeriod(month, year, principle, branch),
        getScopeForUser(gate.session.user.id),
    ]);
    const rows = scope === null ? rawRows : rawRows.filter((r) => scope.has(r.salesCode));
    return NextResponse.json({ month, year, rows });
}

interface TargetInput {
    salesCode: string;
    salesName: string;
    principle: string;
    branch: string;
    channel?: string;
    spvName?: string;
    smName?: string;
    periodMonth: number;
    periodYear: number;
    targetValue: number;
    targetEc: number;
    targetAo: number;
    targetIa: number;
    splmValue?: number;
    tipeSales?: string;
    statusInsentif?: string;
}

export async function POST(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.upload_target");
    if (gate.response) return gate.response;

    let body: TargetInput[];
    try {
        const raw = await req.json();
        body = Array.isArray(raw) ? raw : [raw];
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const scope = await getScopeForUser(gate.session.user.id);
    const identity = scope !== null ? await getUserHierarchyIdentity(gate.session.user.id) : null;

    const now = new Date();
    let upserted = 0;

    for (const t of body) {
        if (!t.salesCode || !t.periodMonth || !t.periodYear) continue;

        // Scoping SPV/SM: hanya boleh tulis baris timnya sendiri. salesCode baru/unclaimed
        // oleh SPV -> auto-claim jadi tim SPV itu. Milik SPV lain / SM di luar scope -> tolak.
        if (scope !== null && !scope.has(t.salesCode)) {
            if (identity?.role === "spv") {
                const owner = await getCurrentSpvOwner(t.salesCode);
                if (owner && owner !== identity.name) {
                    return NextResponse.json(
                        { error: `Baris ${t.salesCode}: sudah milik SPV lain (${owner}). Ajukan klaim lewat Kelola Hierarki.` },
                        { status: 403 },
                    );
                }
                // Unclaimed atau sudah milik sendiri (belum masuk scope cache) -> claim otomatis.
                const [existingAssignment] = await db
                    .select({ id: spvSalesAssignment.id })
                    .from(spvSalesAssignment)
                    .where(eq(spvSalesAssignment.salesCode, t.salesCode))
                    .limit(1);
                if (!existingAssignment) {
                    await db.insert(spvSalesAssignment).values({
                        id: randomUUID(), salesCode: t.salesCode, spvName: identity.name, createdAt: now, updatedAt: now,
                    });
                }
            } else {
                return NextResponse.json(
                    { error: `Baris ${t.salesCode}: di luar cakupan tim Anda.` },
                    { status: 403 },
                );
            }
        }

        // Validasi nilai kolom Excel (trust boundary). Nilai aneh → 400.
        let tipeSales: string, statusInsentif: string;
        try {
            tipeSales = normalizeTipe(t.tipeSales ?? "exclusive");
            statusInsentif = normalizeStatus(t.statusInsentif ?? "distributor_principle");
        } catch (e) {
            const msg = e instanceof Error ? e.message : "Nilai tidak valid";
            return NextResponse.json({ error: `Baris ${t.salesCode}/${t.principle}: ${msg}` }, { status: 400 });
        }

        // Kunci unik = salesCode + principle + periode (mix → 1 baris per principle).
        const [existing] = await db
            .select({ id: salesTargets.id })
            .from(salesTargets)
            .where(
                and(
                    eq(salesTargets.salesCode, t.salesCode),
                    eq(salesTargets.principle, t.principle),
                    eq(salesTargets.periodMonth, t.periodMonth),
                    eq(salesTargets.periodYear, t.periodYear),
                ),
            )
            .limit(1);

        if (existing) {
            await db
                .update(salesTargets)
                .set({
                    salesName: t.salesName,
                    branch: t.branch,
                    channel: t.channel ?? "TT",
                    spvName: t.spvName ?? null,
                    smName: t.smName ?? null,
                    targetValue: t.targetValue,
                    targetEc: t.targetEc,
                    targetAo: t.targetAo,
                    targetIa: t.targetIa,
                    splmValue: t.splmValue ?? 0,
                    tipeSales,
                    statusInsentif,
                    updatedAt: now,
                })
                .where(eq(salesTargets.id, existing.id));
        } else {
            await db.insert(salesTargets).values({
                id: randomUUID(),
                salesCode: t.salesCode,
                salesName: t.salesName,
                principle: t.principle,
                branch: t.branch,
                channel: t.channel ?? "TT",
                spvName: t.spvName ?? null,
                smName: t.smName ?? null,
                periodMonth: t.periodMonth,
                periodYear: t.periodYear,
                targetValue: t.targetValue,
                targetEc: t.targetEc,
                targetAo: t.targetAo,
                targetIa: t.targetIa,
                splmValue: t.splmValue ?? 0,
                tipeSales,
                statusInsentif,
                createdAt: now,
                updatedAt: now,
            });
        }
        upserted++;
    }

    return NextResponse.json({ upserted });
}
