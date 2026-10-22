/*
 * Tujuan: Laporan Sales › Target vs Realisasi (padanan EskaLink "Target vs Realization Monthly" per branch): target insentif vs
 *   realisasi DPP MTD, dikelompokkan per (cabang, principal). Angkanya = angka dashboard Insentif Sales: sumber & pemasangan sama
 *   (target `getTargetsForPeriod`, realisasi `computeMtdByPrinciple` — sudah melipat kode gabungan bulan itu; kunci salesman × principal;
 *   baris kantor `isOfficeRow` bukan salesman → keluar). Realisasi HANYA dijumlah untuk kunci yang punya baris target (persis
 *   `targets.map(t => realOf(t))` di app/api/insentif-sales/dashboard/route.ts); kunci progres tanpa baris target tidak masuk baris/total,
 *   dilaporkan terpisah di `tanpaTarget` (padanan `progressFeed.unmatchedKeys` dashboard). Tidak ada rumus baru.
 * Caller: app/api/laporan-sales/target/route.ts (muatTarget); lib/laporan-sales/target.test.ts (rakitTarget).
 * Dependensi: lib/insentif-sales (target + realisasi, DB baca-saja; diimpor malas), lib/insentif-sm-calc (isOfficeRow), lib/laporan-sales/kontrak.
 * Main Functions: rakitTarget (agregasi murni, tanpa DB), muatTarget (baca DB lalu rakitTarget).
 * Side Effects: Hanya baca DB. Bulan tanpa target = `baris: []` (UI menjelaskan; bukan galat).
 *
 * Aturan:
 *   - target = Σ target_value; realisasi = Σ realisasi DPP MTD kunci bertarget; salesman = jumlah salesman BERTARGET (target_value > 0) di
 *     kelompok itu; persen = realisasi/target dalam persen, 1 desimal seperti `pct()`, null bila target 0. total = Σ seluruh baris.
 *   - Cabang = kolom `branch` baris target (kunci salesman × principal). Baris target bernilai 0 tetap menerima realisasi kuncinya (dashboard juga).
 *   - tanpaTarget = kunci progres yang tidak punya baris target sama sekali (kantor tidak dihitung): kombinasi = jumlah kunci, realisasi = Σ DPP-nya.
 *   - Cakupan: `insentif_sales.view_all` = seluruh perusahaan; tidak ada penyaringan per orang.
 */
import { isOfficeRow } from "@/lib/insentif-sm-calc";
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
 * Agregasi murni. Urutan baris: cabang lalu principal (abjad Indonesia), supaya stabil dan bisa dipindai per cabang.
 */
export function rakitTarget(bulan: string, targets: readonly TargetMasuk[], realisasi: Iterable<RealisasiMasuk>): JawabanTarget {
    const kelompok = new Map<string, { cabang: string; principle: string; sales: Set<string>; target: number; realisasi: number }>();
    const ambil = (cabang: string, principle: string) => {
        const k = `${cabang}\u0000${principle}`;
        let g = kelompok.get(k);
        if (!g) kelompok.set(k, (g = { cabang, principle, sales: new Set(), target: 0, realisasi: 0 }));
        return g;
    };

    const cabangKunci = new Map<string, string>(); // kunci bertarget (bukan kantor) → cabangnya
    const kantor = new Set<string>(); // kunci baris kantor: cocok dengan target (bukan "tanpa target") tetapi bukan salesman
    for (const t of targets) {
        const k = kunci(t.salesCode, t.principle);
        if (isOfficeRow(t.salesCode, t.salesName)) { kantor.add(k); continue; }
        const cabang = cabangSah(t.branch);
        cabangKunci.set(k, cabang);
        const g = ambil(cabang, t.principle);
        g.target += t.targetValue;
        if (t.targetValue > 0) g.sales.add(t.salesCode);
    }

    let tanpaKombinasi = 0;
    let tanpaRealisasi = 0;
    for (const r of realisasi) {
        const k = kunci(r.salesCode, r.principle);
        const cabang = cabangKunci.get(k);
        if (cabang !== undefined) ambil(cabang, r.principle).realisasi += r.realValue;
        else if (!kantor.has(k)) { tanpaKombinasi++; tanpaRealisasi += r.realValue; }
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
    return { bulan, baris, total: { target, realisasi: real, persen: persenDari(real, target) }, tanpaTarget: { kombinasi: tanpaKombinasi, realisasi: bulatkan(tanpaRealisasi) } };
}

export async function muatTarget(bulan: string): Promise<JawabanTarget> {
    const { bulan: month, tahun: year } = rentangBulan(bulan);
    // ponytail: impor malas — rakitTarget (murni) bisa diuji tanpa memuat pool pg + Better Auth lewat lib/insentif-sales.
    const { computeMtdByPrinciple, getTargetsForPeriod } = await import("@/lib/insentif-sales");
    const [targets, realisasi] = await Promise.all([getTargetsForPeriod(month, year), computeMtdByPrinciple(month, year)]);
    return rakitTarget(bulan, targets, realisasi.values());
}
