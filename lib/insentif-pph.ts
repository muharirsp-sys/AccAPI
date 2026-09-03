/*
 * Tujuan: Potongan PPh atas insentif — satu tempat untuk tarifnya dan pembulatannya.
 * Caller: app/(dashboard)/insentif-sales/page.tsx (tabel Sales/SPV/SM & Verifikasi Finance).
 * Dependensi: tidak ada.
 * Main Functions: pphInsentif, nettoInsentif.
 * Side Effects: tidak ada — fungsi murni.
 *
 * Yang TERSIMPAN di database tetap BRUTO (lihat kolom amount di pembayaran insentif):
 * netto diturunkan saat ditampilkan. Kalau tarifnya berubah, riwayat pembayaran lama tidak
 * ikut bergeser dan pemeriksaan drift Finance tetap membandingkan bruto lawan bruto.
 */

import { DEFAULT_KONSTANTA } from "./insentif-konstanta.ts";

/**
 * Tarif PPh BAWAAN atas insentif sales. Diberlakukan sejak 2026-08-31 atas permintaan user.
 * Bisa diubah dari panel Admin — pemanggil mengoper `rate` (lib/insentif-konstanta).
 */
export const PPH_RATE = DEFAULT_KONSTANTA.pph.rate;

/** Potongan PPh, dibulatkan ke rupiah terdekat — pembayaran tidak mengenal sen. */
export function pphInsentif(bruto: number, rate: number = PPH_RATE): number {
    if (!Number.isFinite(bruto) || bruto <= 0) return 0;
    if (!Number.isFinite(rate) || rate <= 0) return 0;
    return Math.round(bruto * rate);
}

/** Yang benar-benar dibayar ke penerima. netto + pph selalu = bruto, tanpa sisa pembulatan. */
export function nettoInsentif(bruto: number, rate: number = PPH_RATE): number {
    if (!Number.isFinite(bruto) || bruto <= 0) return 0;
    return bruto - pphInsentif(bruto, rate);
}
