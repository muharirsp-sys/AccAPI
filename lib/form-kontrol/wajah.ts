/*
 * Tujuan: Validasi wajah selfie check-in (owner 16 Nov 2026) — bagian MURNI: kemiripan kosinus dua sidik wajah SFace (128 angka, FastAPI
 *   /wajah/sidik) dan status kunjungan. Tidak pernah menahan kunjungan (owner: "lanjut, tandai SPV"); 'beda' / 'tanpa_wajah' = tanda SPV.
 * Caller: lib/form-kontrol/wajah-db.ts (periksaWajahCheckin), lib/form-kontrol/db.ts getSpvDashboard (benderaWajah), wajah.test.ts.
 * Dependensi: tidak ada.
 * Main Functions: kosinus, nilaiWajah, benderaWajah, AMBANG_WAJAH.
 * Side Effects: Tidak ada.
 */

/** Ambang kosinus SFace "orang yang sama" yang dianjurkan OpenCV (FaceRecognizerSF, cosine ≥ 0,363). */
export const AMBANG_WAJAH = 0.363;
export const STATUS_WAJAH = ["cocok", "beda", "tanpa_wajah", "acuan_baru", "tidak_terbaca"] as const;
export type StatusWajah = (typeof STATUS_WAJAH)[number];

/** Kemiripan kosinus; panjang beda / vektor nol / angka rusak = NaN. */
export function kosinus(a: readonly number[], b: readonly number[]): number {
    if (a.length === 0 || a.length !== b.length) return NaN;
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
    return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : NaN;
}

/**
 * Status check-in dari sidik selfie (`null` = tidak ada wajah) dan sidik acuan salesman (`null` = belum ada acuan -> selfie ini jadi acuan).
 * Skor dibulatkan 4 desimal; skor tak terhitung = tidak_terbaca.
 */
export function nilaiWajah(sidik: readonly number[] | null, acuan: readonly number[] | null): { status: StatusWajah; skor: number | null } {
    if (!sidik) return { status: "tanpa_wajah", skor: null };
    if (!acuan) return { status: "acuan_baru", skor: null };
    const s = kosinus(sidik, acuan);
    if (!Number.isFinite(s)) return { status: "tidak_terbaca", skor: null };
    return { status: s >= AMBANG_WAJAH ? "cocok" : "beda", skor: Math.round(s * 10_000) / 10_000 };
}

/** Tanda Dashboard SPV dari wajah_status (null = tanpa tanda). */
export const benderaWajah = (s: string | null | undefined) => (s === "beda" ? "wajah_beda" : s === "tanpa_wajah" ? "wajah_tanpa" : null);
