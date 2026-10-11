/*
 * Tujuan: SATU normalizer baku teks principal (S7-2, BL-64) — satu-satunya sumber nilai principal_alias.alias_norm.
 * Caller: lib/principal/resolver.ts, lib/principal/tulis.ts (API /api/principals), lib/principal/laporan.ts (laporan + benih).
 * Dependensi: tidak ada.
 * Main Functions: rapikanTeks, normalisasiPrincipal, bentukNormalSah.
 * Side Effects: tidak ada (murni).
 *
 * Aturan (urut): buang karakter tak terlihat (\p{Cf} + Default_Ignorable_Code_Point: spasi lebar nol, tanda hubung lunak,
 * penanda arah, BOM, penggabung grafem U+034F, variation selector, pengisi Hangul) -> NFKC (huruf lebar penuh, ligatur, spasi
 * khusus -> bentuk biasa) -> tanda baca tipografis OCR/Word disamakan (\u2018 \u2019 \u201A \u201B -> ',
 * \u201C \u201D \u201E \u201F -> ", tanda hubung/pisah/minus U+2010–2015, U+2212 -> -) -> SEMUA spasi Unicode (NBSP, tab, baris baru, spasi sempit,
 * spasi ideografis, ...) dan karakter kendali -> spasi biasa, beruntun jadi satu -> trim -> HURUF BESAR (lalu dirapikan sekali
 * lagi agar hasil = titik tetap: normalisasi(normalisasi(x)) === normalisasi(x); disapu untuk seluruh BMP di uji).
 * Tanda baca TIDAK dibuang (titik, koma, "PT", bintang OCR tetap): pencocokan longgar = tugas laporan, bukan normalizer.
 * Hasil selalu lolos CHECK principal_alias_norm_bentuk (huruf besar, tanpa spasi tepi, spasi tunggal) untuk huruf ASCII;
 * huruf non-ASCII yang upper() Postgres-nya berbeda ditolak CHECK (aman, tidak diam-diam tersimpan beda).
 * JANGAN diubah tanpa menormalkan ulang alias_norm yang sudah tersimpan (nilai lama akan berhenti cocok).
 */

const TAK_TERLIHAT = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const SPASI_ATAU_KENDALI = /[\s\p{Cc}]+/gu;
const KUTIP_TUNGGAL = /[\u2018\u2019\u201A\u201B]/g;
const KUTIP_GANDA = /[\u201C\u201D\u201E\u201F]/g;
const TANDA_HUBUNG = /[\u2010-\u2015\u2212]/g;

/** Bentuk tampilan: tak terlihat dibuang, tipografi disamakan, spasi Unicode/kendali -> satu spasi, trim; huruf TIDAK diubah.
 * Untuk name / alias_asli. */
export function rapikanTeks(nilai: unknown): string {
    return String(nilai ?? "").replace(TAK_TERLIHAT, "").normalize("NFKC")
        .replace(KUTIP_TUNGGAL, "'").replace(KUTIP_GANDA, "\"").replace(TANDA_HUBUNG, "-")
        .replace(SPASI_ATAU_KENDALI, " ").trim();
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
