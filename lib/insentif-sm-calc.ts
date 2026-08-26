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

import { roundRatio, type StatusInsentif } from "./insentif-sales-calc.ts";

/**
 * Cocokkan sebagai KATA UTUH, bukan substring. Pemisah kata di data ini bermacam-macam
 * (spasi, underscore, tanda hubung, titik), jadi apa pun yang bukan huruf/angka dianggap
 * pemisah: "PAK HENDRIK", "HENDRIK S.", "M-FN_OFFICE", "FS_MT_OFFICE_HRK" semuanya terurai
 * dengan benar.
 *
 * Substring TIDAK dipakai karena terlalu longgar untuk konsekuensinya (audit temuan L2d):
 * "HENDRIKUS" akan lolos whitelist SM dan otomatis berhak sampai Rp 3,5 juta tanpa keputusan
 * siapa pun, dan salesman yang namanya kebetulan mengandung "OFFICE" akan dibuang dari
 * agregasi SM/SPV.
 */
function containsWord(haystack: string, word: string): boolean {
    return haystack.toUpperCase().split(/[^A-Z0-9]+/).includes(word);
}

/**
 * SM yang ikut skema insentif SM.
 * ponytail: whitelist literal, bukan tabel DB — baru 1 nama dan perubahannya butuh keputusan
 * user. Pindah ke DB kalau daftarnya mulai berubah per periode.
 */
export const SM_BERHAK_INSENTIF = ["HENDRIK"] as const;

export function isSmBerhak(smName: string): boolean {
    return SM_BERHAK_INSENTIF.some((s) => containsWord(smName, s));
}

/**
 * Baris _OFFICE (mis. "M-FN_OFFICE") bukan salesman — pos target kantor. Dicocokkan pada
 * kode MAUPUN nama karena penulisannya tidak konsisten di file target.
 */
export function isOfficeRow(salesCode: string, salesName: string): boolean {
    return containsWord(`${salesCode} ${salesName}`, "OFFICE");
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

/**
 * Strata flat berbasis rasio realisasi/target. Tidak dikali apa pun.
 * Rasio dibulatkan ke 6 desimal dulu — lihat roundRatio di lib/insentif-sales-calc.ts.
 * Tanpa itu, 0,9999999999 vs 1,0000000001 = beda Rp 1 juta dan bisa berubah antar refresh.
 */
export function rateSm(ratio: number): number {
    if (!Number.isFinite(ratio)) return 0;
    const r = roundRatio(ratio);
    if (r >= 1.1) return 3_500_000;
    if (r >= 1.0) return 2_500_000;
    if (r >= 0.9) return 1_500_000;
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
