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

/** Tarif PPh atas insentif sales. Diberlakukan sejak 2026-08-31 atas permintaan user. */
export const PPH_RATE = 0.025;

/** Potongan PPh, dibulatkan ke rupiah terdekat — pembayaran tidak mengenal sen. */
export function pphInsentif(bruto: number): number {
    if (!Number.isFinite(bruto) || bruto <= 0) return 0;
    return Math.round(bruto * PPH_RATE);
}

/** Yang benar-benar dibayar ke penerima. netto + pph selalu = bruto, tanpa sisa pembulatan. */
export function nettoInsentif(bruto: number): number {
    if (!Number.isFinite(bruto) || bruto <= 0) return 0;
    return bruto - pphInsentif(bruto);
}
