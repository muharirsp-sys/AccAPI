/*
 * Tujuan: SATU normalizer baku teks principal (S7-2, BL-64) — satu-satunya sumber nilai principal_alias.alias_norm.
 * Caller: lib/principal/resolver.ts, lib/principal/tulis.ts (API /api/principals), lib/principal/laporan.ts (laporan + benih).
 * Dependensi: tidak ada.
 * Main Functions: rapikanTeks, normalisasiPrincipal, bentukNormalSah.
 * Side Effects: tidak ada (murni).
 *
 * Aturan (urut): buang karakter format tak terlihat (\p{Cf}: spasi lebar nol, tanda hubung lunak, penanda arah, BOM) ->
 * NFKC (huruf lebar penuh, ligatur, spasi khusus -> bentuk biasa) -> SEMUA spasi Unicode (NBSP, tab, baris baru, spasi
 * sempit, spasi ideografis, ...) dan karakter kendali -> spasi biasa, beruntun jadi satu -> trim -> HURUF BESAR (lalu
 * dirapikan sekali lagi agar hasil = titik tetap: normalisasi(normalisasi(x)) === normalisasi(x)).
 * Tanda baca TIDAK dibuang (titik, koma, "PT", bintang OCR tetap): pencocokan longgar = tugas laporan, bukan normalizer.
 * Hasil selalu lolos CHECK principal_alias_norm_bentuk (huruf besar, tanpa spasi tepi, spasi tunggal) untuk huruf ASCII;
 * huruf non-ASCII yang upper() Postgres-nya berbeda ditolak CHECK (aman, tidak diam-diam tersimpan beda).
 * JANGAN diubah tanpa menormalkan ulang alias_norm yang sudah tersimpan (nilai lama akan berhenti cocok).
 */

const FORMAT_TAK_TERLIHAT = /\p{Cf}/gu;
const SPASI_ATAU_KENDALI = /[\s\p{Cc}]+/gu;

/** Bentuk tampilan: spasi Unicode/kendali -> satu spasi, trim, huruf TIDAK diubah. Untuk name / alias_asli. */
export function rapikanTeks(nilai: unknown): string {
    return String(nilai ?? "").replace(FORMAT_TAK_TERLIHAT, "").normalize("NFKC").replace(SPASI_ATAU_KENDALI, " ").trim();
}

/** Bentuk normal baku (alias_norm). "" = tidak ada isi (pemanggil wajib menolak). */
export function normalisasiPrincipal(nilai: unknown): string {
    // Rapikan kedua: huruf besar bisa menghasilkan urutan terurai (huruf + diakritik) yang NFKC susun ulang.
    return rapikanTeks(rapikanTeks(nilai).toUpperCase());
}

/** Cermin CHECK S7-0 + titik tetap normalizer: true bila `s` boleh langsung disimpan sebagai alias_norm. */
export function bentukNormalSah(s: string): boolean {
    return s !== "" && s === normalisasiPrincipal(s) && /^\S+( \S+)*$/.test(s);
}
