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
import { db } from "@/lib/db";
import { salesTargets, spvSalesAssignment } from "@/db/schema";
import { getTargetsForPeriod } from "@/lib/insentif-sales";
import { requirePermission } from "@/lib/rbac/resolve";
import { normalizeStatus, normalizeTipe } from "@/lib/insentif-sales-calc";
import { getScopeForUser, getUserHierarchyIdentity, getSpvOwnerMap } from "@/lib/insentif-hierarchy-scope";

// Upload target bisa ratusan baris. Konvensi repo: route unggah berat menaikkan batas ini
// (lihat laporan-harian/upload = 300, sales-history/import = 300).
export const maxDuration = 300;

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
        getScopeForUser(gate.session.user.id, { month, year }),
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

    // Periode diambil dari payload — semua baris satu upload selalu satu periode.
    const period = body.find((t) => t.periodMonth && t.periodYear);
    const scopePeriod = period ? { month: period.periodMonth, year: period.periodYear } : undefined;
    const scope = await getScopeForUser(gate.session.user.id, scopePeriod);
    const identity = scope !== null ? await getUserHierarchyIdentity(gate.session.user.id) : null;

    const now = new Date();
    const actor = gate.session.user.id;

    // ── PASS 1: validasi SELURUH payload sebelum menyentuh DB ────────────────────
    // Dulu validasi dilakukan di dalam loop tulis, sehingga `return 400` di baris ke-50
    // meninggalkan 49 baris sudah permanen dan user melihat "upload gagal".
    const rows = body.filter((t) => t.salesCode && t.periodMonth && t.periodYear);

    // Angka nominal: tolak NaN/Infinity/negatif. Tanpa ini, Infinity tersimpan lalu
    // "konstanta − Infinity" ter-floor jadi 0 → insentif hilang tanpa error ke Finance.
    const finiteNonNeg = (v: unknown) => Number.isFinite(Number(v)) && Number(v) >= 0;
    const NUMERIC_FIELDS: Array<[keyof TargetInput, string]> = [
        ["targetValue", "Target Value"], ["targetEc", "Target EC"],
        ["targetAo", "Target AO"], ["targetIa", "Target IA"], ["splmValue", "SPLM Value"],
    ];

    interface PreparedRow {
        input: TargetInput;
        tipeSales: string;
        statusInsentif: string;
        spvName: string | null;
        smName: string | null;
    }
    const prepared: PreparedRow[] = [];

    for (const t of rows) {
        // principle ikut KUNCI UPSERT — kosong berarti baris ini menimpa baris lain yang
        // principle-nya juga kosong, bukan menyimpan data baru. branch menentukan acuan Value
        // (DPP vs NILAI_JUAL). Keduanya tidak boleh ditebak dari default.
        if (!t.principle?.trim() || !t.branch?.trim()) {
            return NextResponse.json(
                { error: `Baris ${t.salesCode}: Principal & Cabang wajib diisi.` },
                { status: 400 },
            );
        }
        for (const [field, label] of NUMERIC_FIELDS) {
            const raw = t[field];
            if (raw === undefined || raw === null) continue;
            if (!finiteNonNeg(raw)) {
                return NextResponse.json(
                    { error: `Baris ${t.salesCode}/${t.principle}: ${label} tidak valid (${String(raw)}).` },
                    { status: 400 },
                );
            }
        }
        let tipeSales: string, statusInsentif: string;
        try {
            tipeSales = normalizeTipe(t.tipeSales ?? "exclusive");
            statusInsentif = normalizeStatus(t.statusInsentif ?? "distributor_principle");
        } catch (e) {
            const msg = e instanceof Error ? e.message : "Nilai tidak valid";
            return NextResponse.json({ error: `Baris ${t.salesCode}/${t.principle}: ${msg}` }, { status: 400 });
        }
        prepared.push({
            input: t,
            tipeSales,
            statusInsentif,
            // trim() WAJIB: spvName/smName dipakai LANGSUNG sebagai kunci grouping di
            // spv-dashboard & sm-dashboard. "MARTEN" vs "MARTEN " = dua orang berbeda →
            // grup pecah, rate per principal naik, dan support SPV (yang di-trim di
            // spv-support/route.ts) tidak akan pernah cocok.
            spvName: t.spvName?.trim() || null,
            smName: t.smName?.trim() || null,
        });
    }

    // ── PASS 2: cek kepemilikan scope, sekali jalan pakai peta yang dihitung SEKALI ──
    // getCurrentSpvOwner di dalam loop = 2 full-scan sales_targets PER BARIS.
    const claims: string[] = [];
    if (scope !== null) {
        const spvOwnerOf = identity?.role === "spv" ? await getSpvOwnerMap(scopePeriod) : null;
        const claimed = new Set<string>();
        for (const { input: t } of prepared) {
            if (scope.has(t.salesCode) || claimed.has(t.salesCode)) continue;
            if (identity?.role !== "spv" || !spvOwnerOf) {
                return NextResponse.json(
                    { error: `Baris ${t.salesCode}: di luar cakupan tim Anda.` },
                    { status: 403 },
                );
            }
            const owner = spvOwnerOf.get(t.salesCode) ?? null;
            if (owner && owner !== identity.name) {
                return NextResponse.json(
                    { error: `Baris ${t.salesCode}: sudah milik SPV lain (${owner}). Ajukan klaim lewat Kelola Hierarki.` },
                    { status: 403 },
                );
            }
            claimed.add(t.salesCode);
            claims.push(t.salesCode);
        }
    }

    // ── PASS 3: tulis, seluruhnya dalam SATU transaksi ───────────────────────────
    let upserted = 0;
    await db.transaction(async (tx) => {
        for (const salesCode of claims) {
            // spv_sales_assignment.sales_code sudah UNIQUE di produksi — klaim yang sudah ada
            // dibiarkan apa adanya (DoNothing), bukan ditimpa: kepemilikan sudah diverifikasi
            // di PASS 2, dan menimpanya akan menghapus assignment manual admin.
            await tx.insert(spvSalesAssignment)
                .values({ id: randomUUID(), salesCode, spvName: identity!.name, createdAt: now, updatedAt: now })
                .onConflictDoNothing({ target: spvSalesAssignment.salesCode });
        }

        for (const p of prepared) {
            const t = p.input;
            // Kunci unik = salesCode + principle + periode (mix → 1 baris per principle),
            // ditegakkan oleh uq_sales_targets_key di DB sejak 2026-08-24. Pola lama
            // SELECT-cek-lalu-INSERT bisa kecolongan saat dua request paralel: dua-duanya
            // SELECT-miss lalu dua-duanya INSERT → baris kembar yang menaikkan `n` mix dan
            // mengubah nominal insentif tanpa error (audit temuan C2).
            await tx
                .insert(salesTargets)
                .values({
                    id: randomUUID(),
                    salesCode: t.salesCode,
                    salesName: t.salesName,
                    principle: t.principle,
                    branch: t.branch,
                    channel: t.channel ?? "TT",
                    spvName: p.spvName,
                    smName: p.smName,
                    periodMonth: t.periodMonth,
                    periodYear: t.periodYear,
                    targetValue: t.targetValue,
                    targetEc: t.targetEc,
                    targetAo: t.targetAo,
                    targetIa: t.targetIa,
                    splmValue: t.splmValue ?? 0,
                    tipeSales: p.tipeSales,
                    statusInsentif: p.statusInsentif,
                    updatedBy: actor,
                    createdAt: now,
                    updatedAt: now,
                })
                .onConflictDoUpdate({
                    target: [salesTargets.salesCode, salesTargets.principle, salesTargets.periodMonth, salesTargets.periodYear],
                    set: {
                        salesName: t.salesName,
                        branch: t.branch,
                        channel: t.channel ?? "TT",
                        spvName: p.spvName,
                        smName: p.smName,
                        targetValue: t.targetValue,
                        targetEc: t.targetEc,
                        targetAo: t.targetAo,
                        targetIa: t.targetIa,
                        splmValue: t.splmValue ?? 0,
                        tipeSales: p.tipeSales,
                        statusInsentif: p.statusInsentif,
                        updatedBy: actor,
                        updatedAt: now,
                        // createdAt sengaja TIDAK di-set — baris lama mempertahankan waktu buatnya.
                    },
                });
            upserted++;
        }
    });

    return NextResponse.json({ upserted });
}
