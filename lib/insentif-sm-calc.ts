/*
 * Tujuan: Kalkulasi insentif SM — strata FLAT berbasis Value SAJA (tidak ada AO/EC/IA,
 *         tidak ada pro-rata pengali seperti Sales/SPV). Satu pembayaran per SM per periode.
 * Caller: app/api/insentif-sales/sm-dashboard (tetap pure dan tanpa I/O).
 * Dependensi: lib/insentif-sales-calc (StatusInsentif saja — tipe).
 * Main Functions: calculateInsentifSM (agregat value + tentukan strata), rateSm (tabel strata),
 *   isSmBerhak (whitelist SM yang ikut skema), isOfficeRow (buang baris _OFFICE).
 * Side Effects: none (pure).
 *
 * Aturan (dikonfirmasi user 2026-08-24):
 * - Hanya Value. Target & realisasi = SUM seluruh baris sales di bawah SM (lintas SPV,
 *   lintas principal, lintas channel). Persentase dihitung dari total, bukan per principal —
 *   karena strata-nya nominal flat, bukan rate per principal seperti SPV.
 * - Strata (flat, TIDAK dikali persentase):
 *     < 90%              → Rp 0
 *     90% – 99,99%       → Rp 1.500.000
 *     100% – 109,99%     → Rp 2.500.000
 *     >= 110%            → Rp 3.500.000
 *   Catatan: user menulis batas "90-99%" lalu "100-109,99%". Celah 99%..100% diisi ke strata
 *   1,5jt (batas atas dibaca sebagai 99,99%, sejajar dengan cara strata kedua ditulis).
 * - Hanya SM tertentu yang ikut skema. Per user: HENDRIK ikut, ADNAN TIDAK. SM di luar
 *   daftar → tidak muncul / total 0.
 * - SEMUA principal dihitung, TERMASUK yang berstatus "principle" (ENERGIZER) — beda dari
 *   skema Sales & SPV yang membuang baris itu. Dikonfirmasi user 2026-08-24: untuk SM yang
 *   dinilai adalah Value total wilayahnya, bukan porsi yang dibayar distributor.
 * - Baris _OFFICE DIBUANG. Itu bukan salesman tapi bawa target besar (16 baris di file target
 *   Juli 2026), jadi kalau ikut dijumlahkan pencapaian SM ikut terdistorsi.
 */

import type { StatusInsentif } from "./insentif-sales-calc.ts";

/**
 * SM yang ikut skema insentif SM. Dicocokkan sebagai substring pada nama ter-normalisasi,
 * supaya "PAK HENDRIK" / "HENDRIK S." tetap kena.
 * ponytail: whitelist literal, bukan tabel DB — baru 1 nama dan perubahannya butuh keputusan
 * user. Pindah ke DB kalau daftarnya mulai berubah per periode.
 */
export const SM_BERHAK_INSENTIF = ["HENDRIK"] as const;

export function isSmBerhak(smName: string): boolean {
    const n = smName.trim().toUpperCase();
    return SM_BERHAK_INSENTIF.some((s) => n.includes(s));
}

/**
 * Baris _OFFICE (mis. "M-FN_OFFICE") bukan salesman — pos target kantor. Dicocokkan pada
 * kode MAUPUN nama karena penulisannya tidak konsisten di file target.
 */
export function isOfficeRow(salesCode: string, salesName: string): boolean {
    return `${salesCode} ${salesName}`.toUpperCase().includes("OFFICE");
}

export interface SmSalesRow {
    salesCode: string;
    salesName: string;
    targetValue: number;
    realisasiValue: number;
    /** Disimpan untuk kelengkapan/pelaporan — SM menghitung semua status, termasuk "principle". */
    statusInsentif: StatusInsentif;
}

export interface SmInsentifResult {
    /** Baris sales yang benar-benar ikut dijumlahkan (setelah _OFFICE dibuang). */
    jumlahBaris: number;
    targetValue: number;
    realisasiValue: number;
    /** Rasio realisasi/target (0 kalau target <= 0). Bukan pengali — hanya penentu strata. */
    pctValue: number;
    berhak: boolean;
    total: number;
}

/** Strata flat berbasis rasio realisasi/target. Tidak dikali apa pun. */
export function rateSm(ratio: number): number {
    if (ratio >= 1.1) return 3_500_000;
    if (ratio >= 1.0) return 2_500_000;
    if (ratio >= 0.9) return 1_500_000;
    return 0;
}

export function calculateInsentifSM(smName: string, rows: SmSalesRow[]): SmInsentifResult {
    const berhak = isSmBerhak(smName);
    let targetValue = 0;
    let realisasiValue = 0;
    let jumlahBaris = 0;
    for (const r of rows) {
        if (isOfficeRow(r.salesCode, r.salesName)) continue;
        jumlahBaris++;
        targetValue += r.targetValue;
        realisasiValue += r.realisasiValue;
    }
    const pctValue = targetValue > 0 ? realisasiValue / targetValue : 0;
    return { jumlahBaris, targetValue, realisasiValue, pctValue, berhak, total: berhak ? rateSm(pctValue) : 0 };
}
