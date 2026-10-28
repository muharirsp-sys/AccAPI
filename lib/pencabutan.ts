/*
 * Tujuan: Satu batas alasan pencabutan (audit desain 001 No 6 dan 18; tinjauan K3 R-2) untuk server dan dialog: Cabut penjelasan
 *   Verifikasi balik, Terima sales (note), dan Cabut konfirmasi order ganda. Di luar batas = 400 dengan pesan, tidak dipotong diam-diam.
 * Caller: app/api/invoice-verify/route.ts, app/api/principal-order/dupe-ack/route.ts, antrean-faktur/VerifikasiBalik.tsx,
 *   principal-order/LangkahBatch.tsx.
 * Dependensi: tidak ada (aman untuk bundel klien).
 * Main Functions: ALASAN_CABUT_MIN, ALASAN_CABUT_MAKS, galatPanjangAlasan.
 * Side Effects: tidak ada.
 */

export const ALASAN_CABUT_MIN = 10;
export const ALASAN_CABUT_MAKS = 500;

/** Pesan bila alasan (sesudah trim, panjang JS = hitungan dialog) melewati batas; "" = sah. */
export const galatPanjangAlasan = (alasan: string, apa = "Alasan") =>
    alasan.length > ALASAN_CABUT_MAKS ? `${apa} maksimal ${ALASAN_CABUT_MAKS} karakter (sekarang ${alasan.length}).` : "";
