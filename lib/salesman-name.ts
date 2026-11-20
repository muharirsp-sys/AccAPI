/*
 * Tujuan: Satu pintu membaca nama salesman Accurate dalam dua format.
 *   Lama (s.d. 20 Nov 2026): "KODE_NAMA"   — "M2_5_MT_RISDA HARIS", "RB3_IRMAWATI", "EN_OFFICE".
 *   Baru (owner 20 Nov 2026): "NAMA_ KODE" — "RISDA HARIS_ M2_5 MT", "IRMAWATI_ RB3", "OFFICE_ EN".
 *   keKodeNama mengubah format baru ke format lama, jadi semua aturan yang membaca kode dari depan nama
 *   (prefiks rute, penanda _MT, OFFICE, SPV_) tetap memberi hasil yang sama setelah nama diganti di Accurate.
 * Caller: lib/sales-code-merge, lib/form-kontrol/jks-webll (tebakPeta), lib/form-kontrol/item-super (tebakPetaItemSuper).
 * Dependensi: tidak ada (pure). Padanan Python: python_backend/laporan_harian_pq.salesman_kode_nama.
 * Side Effects: none.
 */

/**
 * "NAMA_ KODE": nama orang, garis bawah, minimal satu spasi, lalu kode rute (huruf diikuti huruf/angka; bagian kode
 * dipisah "_" atau spasi, mis. "M2_5 MT"). Format lama tidak pernah memuat "_ " (garis bawah lalu spasi).
 */
const NAMA_KODE = /^(.*\S)_\s+([A-Z][A-Z0-9]*(?:[_ ][A-Z0-9]+)*)$/;

/**
 * Nama salesman dalam format KODE_NAMA (huruf besar, spasi dirapatkan). Format lama dikembalikan apa adanya.
 * "RISDA HARIS_ M2_5 MT" → "M2_5_MT_RISDA HARIS" | "OFFICE_ FS_MT" → "FS_MT_OFFICE" | "RB3_IRMAWATI" → "RB3_IRMAWATI".
 */
export function keKodeNama(salesName: string | null | undefined): string {
    const s = String(salesName ?? "").trim().toUpperCase().replace(/\s+/g, " ");
    const m = s.match(NAMA_KODE);
    return m ? `${m[2].replace(/ /g, "_")}_${m[1]}` : s;
}
