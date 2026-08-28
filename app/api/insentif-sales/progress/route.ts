/*
 * Tujuan: GET MTD aggregated progress + POST bulk daily progress records.
 * Caller: app/(dashboard)/insentif-sales/page.tsx dan admin upload form.
 * Dependensi: lib/insentif-sales, db/schema (salesDailyProgress).
 * Main Functions: GET aggregate MTD; POST simpan progress harian (mode ganti-per-kombinasi).
 * Side Effects: DB read + write.
 *
 * POST bersifat IDEMPOTEN PER HARI: baris untuk setiap kombinasi
 * (salesCode, principle, periode, TANGGAL) yang ada di payload DIHAPUS lebih dulu, lalu payload
 * disisipkan. Upload dua kali tidak menggandakan angka, upload file SM lain tidak menyentuh data
 * SM ini, dan upload closing berkala TIDAK menghapus hari-hari yang sudah masuk sebelumnya.
 *
 * `date` masuk kunci hapus sejak 2026-08-24 (audit temuan M13). Sebelumnya cakupannya hanya
 * (salesCode, principle, periode) tanpa tanggal, sehingga upload closing minggu ke-2 MENGHAPUS
 * seluruh data minggu ke-1 untuk sales & principal yang sama — realisasi MTD tinggal separuh,
 * pengali jatuh di bawah 0,9, insentif jadi Rp 0, tanpa pesan error apa pun.
 *
 * Riwayat: dulu dedup memakai (salesCode, invoiceNumber, periode) dan meng-skip baris duplikat.
 * Itu salah karena file closing berada di level BARIS BARANG — satu nota berisi banyak produk
 * (sampai 135 baris). Efeknya hanya baris pertama tiap nota yang tersimpan dan ~70% realisasi
 * hilang tanpa pesan error. Sekarang pemanggil mengagregasi per hari sebelum kirim, jadi tidak
 * ada lagi duplikat yang perlu di-dedup.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { salesDailyProgress } from "@/db/schema";
import { computeMtdProgress } from "@/lib/insentif-sales";
import { requirePermission } from "@/lib/rbac/resolve";
import { getScopeForUser } from "@/lib/insentif-hierarchy-scope";

// Upload closing ~2.000 baris + ratusan DELETE dalam satu transaksi. Konvensi repo:
// route unggah berat menaikkan batas ini (laporan-harian/upload & sales-history/import = 300).
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

    // Realisasi MTD per salesman juga data insentif: digabung dengan /support ia cukup untuk
    // menghitung sendiri insentif orang lain (audit 2026-08-28, M2).
    const [allRows, scope] = await Promise.all([
        computeMtdProgress(month, year, principle, branch),
        getScopeForUser(gate.session.user.id, { month, year }, gate.perms),
    ]);
    const rows = scope === null ? allRows : allRows.filter((r) => scope.has(r.salesCode));
    return NextResponse.json({ month, year, rows });
}

interface ProgressInput {
    salesCode: string;
    principle: string;
    branch: string;
    date: string; // YYYY-MM-DD
    periodMonth: number;
    periodYear: number;
    invoiceNumber?: string;
    spvName?: string; // kolom GOLONGAN di file closing
    achievedValueDpp: number;
    achievedEc: number;
    achievedAo: number;
    achievedIa: number;
}

export async function POST(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.upload_progress");
    if (gate.response) return gate.response;

    let body: ProgressInput[];
    try {
        const raw = await req.json();
        body = Array.isArray(raw) ? raw : [raw];
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const valid = body.filter((p) => p.salesCode && p.date && p.periodMonth && p.periodYear);
    if (valid.length === 0) return NextResponse.json({ inserted: 0, replaced: 0 });

    // Angka realisasi adalah dasar perhitungan insentif — tolak NaN/Infinity di trust boundary.
    // (Negatif SAH: baris retur memang bernilai minus.)
    for (const p of valid) {
        for (const [field, label] of [
            ["achievedValueDpp", "DPP"], ["achievedEc", "EC"],
            ["achievedAo", "AO"], ["achievedIa", "IA"],
        ] as const) {
            if (!Number.isFinite(Number(p[field]))) {
                return NextResponse.json(
                    { error: `Baris ${p.salesCode}/${p.principle} ${p.date}: ${label} tidak valid (${String(p[field])}).` },
                    { status: 400 },
                );
            }
        }
    }

    const now = new Date();

    // Kombinasi yang akan diganti. Cakupannya per (salesCode, principle, periode, TANGGAL) —
    // bukan seluruh periode, dan bukan pula seluruh bulan untuk kombinasi itu. Tanpa `date`,
    // upload closing minggu ke-2 menghapus data minggu ke-1 (audit temuan M13).
    const scopes = new Map<string, { salesCode: string; principle: string; periodMonth: number; periodYear: number; date: string }>();
    for (const p of valid) {
        const k = `${p.salesCode}|${p.principle}|${p.periodMonth}|${p.periodYear}|${p.date}`;
        if (!scopes.has(k)) {
            scopes.set(k, { salesCode: p.salesCode, principle: p.principle, periodMonth: p.periodMonth, periodYear: p.periodYear, date: p.date });
        }
    }

    let replaced = 0;
    await db.transaction(async (tx) => {
        for (const sc of scopes.values()) {
            const del = await tx
                .delete(salesDailyProgress)
                .where(
                    and(
                        eq(salesDailyProgress.salesCode, sc.salesCode),
                        eq(salesDailyProgress.principle, sc.principle),
                        eq(salesDailyProgress.periodMonth, sc.periodMonth),
                        eq(salesDailyProgress.periodYear, sc.periodYear),
                        eq(salesDailyProgress.date, sc.date),
                    ),
                );
            replaced += del.rowCount ?? 0;
        }

        // Sisip borongan. Dipotong per 1000 baris supaya satu statement tidak melewati
        // batas parameter Postgres.
        const rows = valid.map((p) => ({
            id: randomUUID(),
            salesCode: p.salesCode,
            principle: p.principle,
            branch: p.branch,
            date: p.date,
            periodMonth: p.periodMonth,
            periodYear: p.periodYear,
            invoiceNumber: p.invoiceNumber ?? null,
            spvName: p.spvName?.trim() || null,
            achievedValueDpp: p.achievedValueDpp,
            achievedEc: p.achievedEc,
            achievedAo: p.achievedAo,
            achievedIa: p.achievedIa,
            uploadedBy: gate.session.user.id,
            createdAt: now,
        }));
        for (let i = 0; i < rows.length; i += 1000) {
            await tx.insert(salesDailyProgress).values(rows.slice(i, i + 1000));
        }
    });

    return NextResponse.json({ inserted: valid.length, replaced, skipped: body.length - valid.length });
}
