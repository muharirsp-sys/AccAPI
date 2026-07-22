/*
 * Tujuan: Kalkulasi insentif SPV — strata berbasis Value SAJA (bukan AO+Value seperti Sales).
 *         Rate per-principal ditentukan oleh jumlah principal valid yang dicover SPV.
 * Caller: app/api/insentif-sales/spv-dashboard (tetap pure dan tanpa I/O).
 * Dependensi: lib/insentif-sales-calc (reuse percentageMultiplier, isSchemePrincipal, StatusInsentif).
 * Main Functions: calculateInsentifSPV (group per principle + hitung), ratePerPrincipalSpv (tabel strata).
 * Side Effects: none (pure).
 *
 * Aturan (dikonfirmasi user):
 * - Value SPV per principal = SUM target & realisasi SEMUA baris sales bawahan untuk principal itu
 *   (lintas channel — GT/TT/MT, karena distinction channel hanya relevan utk insentif per-Sales).
 * - Principal dihitung valid (masuk count) jika MINIMAL 1 baris sales bawahan berstatus skema
 *   (distributor/distributor_principle) — bukan seluruhnya "principle" (full principle, spt Motasa/Heinz).
 * - Rate per principal (strata):
 *     n=1            → flat Rp 1.500.000 (kasus khusus, di luar garis)
 *     n>=2 (& n>6)   → Total(n) = 1.200.000 + 200.000×n, rate = Total(n)/n
 *   Terverifikasi cocok persis ke tabel given: n=2→800rb, 3→600rb, 4→500rb, 5→440rb, 6→400rb.
 *   n>6 ekstrapolasi otomatis dari formula yang sama (mendekati 200rb, tak pernah negatif).
 * - Insentif_n = rate × percentageMultiplier(realisasi, target) — threshold reuse dari Sales:
 *   <90%→0, 90-100%→aktual, >100%→cap 1.00.
 * - Total_Insentif_SPV = sum(Insentif_n). TIDAK ada komponen AO — murni Value.
 */

import { percentageMultiplier, isSchemePrincipal, type StatusInsentif } from "./insentif-sales-calc.ts";

export interface SpvSalesRow {
    principle: string;
    targetValue: number;
    realisasiValue: number;
    statusInsentif: StatusInsentif;
}

export interface SpvPrincipalDetail {
    principle: string;
    targetValue: number;
    realisasiValue: number;
    pctValue: number;
    rate: number;
    insentif: number;
}

export interface SpvInsentifResult {
    jumlahValid: number;
    ratePerPrincipal: number;
    rincian: SpvPrincipalDetail[];
    total: number;
}

/** Rate per principal berdasar jumlah principal valid. n=1 flat 1.5jt; n>=2 pakai Total(n)/n, ekstrapolasi otomatis untuk n>6. */
export function ratePerPrincipalSpv(n: number): number {
    if (n <= 0) return 0;
    if (n === 1) return 1_500_000;
    return 200_000 + 1_200_000 / n;
}

interface PrincipleAgg {
    targetValue: number;
    realisasiValue: number;
    hasScheme: boolean;
}

/** Group baris sales per principle: SUM target/realisasi, valid jika minimal 1 baris berstatus skema. */
function groupByPrinciple(rows: SpvSalesRow[]): Map<string, PrincipleAgg> {
    const map = new Map<string, PrincipleAgg>();
    for (const r of rows) {
        const g = map.get(r.principle) ?? { targetValue: 0, realisasiValue: 0, hasScheme: false };
        g.targetValue += r.targetValue;
        g.realisasiValue += r.realisasiValue;
        if (isSchemePrincipal(r.statusInsentif)) g.hasScheme = true;
        map.set(r.principle, g);
    }
    return map;
}

/** Insentif SPV — agregat per principal dari seluruh sales bawahan, murni berbasis Value. */
export function calculateInsentifSPV(rows: SpvSalesRow[]): SpvInsentifResult {
    const grouped = groupByPrinciple(rows);
    const valid = [...grouped.entries()].filter(([, g]) => g.hasScheme);
    const jumlahValid = valid.length;
    const rate = ratePerPrincipalSpv(jumlahValid);

    if (jumlahValid === 0 || rate <= 0) {
        return { jumlahValid: 0, ratePerPrincipal: 0, rincian: [], total: 0 };
    }

    const rincian: SpvPrincipalDetail[] = valid.map(([principle, g]) => {
        const pctValue = percentageMultiplier(g.realisasiValue, g.targetValue);
        const insentif = rate * pctValue;
        return { principle, targetValue: g.targetValue, realisasiValue: g.realisasiValue, pctValue, rate, insentif };
    });
    const total = rincian.reduce((s, r) => s + r.insentif, 0);

    return { jumlahValid, ratePerPrincipal: rate, rincian, total };
}
