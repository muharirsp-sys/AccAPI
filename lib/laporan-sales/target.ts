/*
 * Tujuan: Laporan Sales › Target vs Realisasi (padanan EskaLink "Target vs Realization Monthly" per branch): target insentif vs
 *   realisasi DPP MTD, dikelompokkan per (cabang, principal). Angkanya = angka dashboard Insentif Sales: sumber & pemasangan sama
 *   (target `getTargetsForPeriod`, realisasi `computeMtdByPrinciple` — sudah melipat kode gabungan bulan itu; kunci salesman × principal;
 *   baris kantor `isOfficeRow` bukan salesman → keluar dari kedua sisi). Tidak ada rumus baru.
 * Caller: app/api/laporan-sales/target/route.ts (muatTarget); lib/laporan-sales/target.test.ts (rakitTarget).
 * Dependensi: lib/insentif-sales (target + realisasi, DB baca-saja), lib/insentif-sm-calc (isOfficeRow), lib/sales-code-merge (applyMergeMap),
 *   db/schema (salesDailyProgress — hanya untuk cabang baris tanpa target), lib/laporan-sales/kontrak.
 * Main Functions: rakitTarget (agregasi murni, tanpa DB), muatTarget (baca DB lalu rakitTarget).
 * Side Effects: Hanya baca DB. Bulan tanpa target = `baris: []` (UI menjelaskan; bukan galat).
 *
 * Aturan:
 *   - target = Σ target_value; realisasi = Σ realisasi DPP MTD; salesman = jumlah salesman BERTARGET (target_value > 0) di kelompok itu;
 *     persen = realisasi/target dalam persen, 1 desimal seperti `pct()` dashboard; null bila target 0. total = Σ seluruh baris.
 *   - Cabang baris target = kolom `branch` target. Realisasi yang kuncinya punya baris target ikut cabang target itu (seperti dashboard).
 *   - Realisasi TANPA baris target tetap tampil (target 0, persen null), tidak dibuang diam-diam; cabangnya dari progres harian
 *     (`sales_daily_progress.branch`, cabang dengan nilai terbesar bila lebih dari satu), lalu cabang salesman itu di target, lalu "Tanpa cabang".
 *   - Cakupan: `insentif_sales.view_all` = seluruh perusahaan; tidak ada penyaringan per orang.
 */
import { isOfficeRow } from "@/lib/insentif-sm-calc";
import { applyMergeMap } from "@/lib/sales-code-merge";
import { rentangBulan, type BarisTarget, type JawabanTarget } from "./kontrak";

export const TANPA_CABANG = "Tanpa cabang";

export type TargetMasuk = { salesCode: string; salesName: string; principle: string; branch: string; targetValue: number };
export type RealisasiMasuk = { salesCode: string; principle: string; realValue: number };

const kunci = (salesCode: string, principle: string) => `${salesCode}|${principle}`;
const cabangSah = (c: string | null | undefined) => (c ?? "").trim() || TANPA_CABANG;
const bulatkan = (n: number) => Math.round(n * 100) / 100;
// ponytail: sama dengan pct() lib/insentif-sales (persen 1 desimal), tetapi null — bukan 0 — saat target 0. pct() tidak diimpor
//   untuk persen karena 0 di laporan ini berarti "capaian nol", bukan "tanpa target".
const persenDari = (realisasi: number, target: number) => (target > 0 ? Math.round((realisasi / target) * 1000) / 10 : null);

/**
 * Agregasi murni. `cabangProgres` (kunci salesCode|principle → cabang) hanya dipakai untuk realisasi yang tidak punya baris target.
 * Urutan baris: cabang lalu principal (abjad Indonesia), supaya stabil dan bisa dipindai per cabang.
 */
export function rakitTarget(
    bulan: string,
    targets: readonly TargetMasuk[],
    realisasi: Iterable<RealisasiMasuk>,
    cabangProgres: ReadonlyMap<string, string> = new Map(),
): JawabanTarget {
    const kelompok = new Map<string, { cabang: string; principle: string; sales: Set<string>; target: number; realisasi: number }>();
    const ambil = (cabang: string, principle: string) => {
        const k = `${cabang}\u0000${principle}`;
        let g = kelompok.get(k);
        if (!g) kelompok.set(k, (g = { cabang, principle, sales: new Set(), target: 0, realisasi: 0 }));
        return g;
    };

    const cabangKunci = new Map<string, string>(); // kunci target (tanpa baris kantor) → cabangnya
    const cabangSales = new Map<string, string>(); // salesCode → cabang salah satu barisnya (cadangan untuk realisasi tanpa target)
    const kantor = new Set<string>();
    for (const t of targets) {
        const k = kunci(t.salesCode, t.principle);
        if (isOfficeRow(t.salesCode, t.salesName)) { kantor.add(k); continue; }
        const cabang = cabangSah(t.branch);
        cabangKunci.set(k, cabang);
        if (!cabangSales.has(t.salesCode)) cabangSales.set(t.salesCode, cabang);
        const g = ambil(cabang, t.principle);
        g.target += t.targetValue;
        if (t.targetValue > 0) g.sales.add(t.salesCode);
    }

    for (const r of realisasi) {
        const k = kunci(r.salesCode, r.principle);
        if (kantor.has(k) || isOfficeRow(r.salesCode, "")) continue;
        const cabang = cabangKunci.get(k) ?? (cabangProgres.has(k) ? cabangSah(cabangProgres.get(k)) : (cabangSales.get(r.salesCode) ?? TANPA_CABANG));
        ambil(cabang, r.principle).realisasi += r.realValue;
    }

    const baris: BarisTarget[] = [...kelompok.values()]
        .sort((a, b) => a.cabang.localeCompare(b.cabang, "id") || a.principle.localeCompare(b.principle, "id"))
        .map((g) => {
            const target = bulatkan(g.target);
            const real = bulatkan(g.realisasi);
            return { cabang: g.cabang, principle: g.principle, salesman: g.sales.size, target, realisasi: real, persen: persenDari(real, target) };
        });
    const target = bulatkan(baris.reduce((s, b) => s + b.target, 0));
    const real = bulatkan(baris.reduce((s, b) => s + b.realisasi, 0));
    return { bulan, baris, total: { target, realisasi: real, persen: persenDari(real, target) } };
}

/** Cabang progres harian per (salesman, principal) bulan itu, kode gabungan dilipat; cabang bernilai DPP terbesar menang. */
async function cabangDariProgres(month: number, year: number): Promise<Map<string, string>> {
    // ponytail: impor DB malas — rakitTarget (murni) bisa diuji tanpa memuat pool pg + Better Auth lewat lib/insentif-sales.
    const [{ and, eq, sql }, { db }, { salesDailyProgress }, { getMergeMap }] = await Promise.all([
        import("drizzle-orm"), import("@/lib/db"), import("@/db/schema"), import("@/lib/insentif-sales"),
    ]);
    const [rows, gabung] = await Promise.all([
        db.select({
            salesCode: salesDailyProgress.salesCode,
            principle: salesDailyProgress.principle,
            branch: salesDailyProgress.branch,
            nilai: sql<number>`SUM(${salesDailyProgress.achievedValueDpp})::double precision`,
        })
            .from(salesDailyProgress)
            .where(and(eq(salesDailyProgress.periodMonth, month), eq(salesDailyProgress.periodYear, year)))
            .groupBy(salesDailyProgress.salesCode, salesDailyProgress.principle, salesDailyProgress.branch),
        getMergeMap(month, year),
    ]);
    const unggul = new Map<string, { cabang: string; nilai: number }>();
    for (const r of rows) {
        const k = kunci(applyMergeMap(r.salesCode, gabung), r.principle);
        const nilai = r.nilai ?? 0;
        const lama = unggul.get(k);
        if (!lama || nilai > lama.nilai) unggul.set(k, { cabang: r.branch, nilai });
    }
    return new Map([...unggul].map(([k, v]) => [k, v.cabang]));
}

export async function muatTarget(bulan: string): Promise<JawabanTarget> {
    const { bulan: month, tahun: year } = rentangBulan(bulan);
    const { computeMtdByPrinciple, getTargetsForPeriod } = await import("@/lib/insentif-sales");
    const [targets, realisasi, cabangProgres] = await Promise.all([
        getTargetsForPeriod(month, year),
        computeMtdByPrinciple(month, year),
        cabangDariProgres(month, year),
    ]);
    return rakitTarget(bulan, targets, realisasi.values(), cabangProgres);
}
