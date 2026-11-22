/**
 * Tujuan: Membedakan dua jenis HTTP 401 Accurate (docs/prd/ACCURATE_API_REFERENCE.md §1). Access token mati
 *   (`{"error":"invalid_token"}`) tidak punya refresh_token: wajib masuk ulang manual. X-Session-ID habis
 *   (`{"s":false,"d":["Data Session Key tidak tepat"]}`) cukup dibuka ulang (open-db.do). Insiden 22 Nov 2026: token mati,
 *   cron/webhook/stok/faktur hanya menjawab "HTTP 401" dan /sesi-accurate tetap "Database aktif".
 * Caller: lib/sync (fetchAccurate), lib/accurate-baca, lib/accurate-forward, lib/accurate-session.
 * Dependensi: tidak ada (modul murni).
 * Main Functions: tokenMati, galat401, TokenAccurateMati, SesiAccurateHabis, PESAN_TOKEN_MATI, PESAN_SESI_HABIS.
 * Side Effects: Tidak ada. Badan 401 TIDAK PERNAH masuk pesan: Accurate menggemakan access token di sana (lib/accurate-redact).
 */
export const PESAN_TOKEN_MATI = "Token Accurate kedaluwarsa. Masuk ulang Accurate di /sesi-accurate.";
export const PESAN_SESI_HABIS = "Sesi database Accurate habis. Buka ulang database di /sesi-accurate.";

/** Badan 401 yang membuktikan access token mati. Bentuk kedua = badan 401 webhook-renew.do (11 Okt 2026). */
export const tokenMati = (badan: string) => /invalid_token|invalid access token/i.test(badan);

export class TokenAccurateMati extends Error {
    constructor() { super(PESAN_TOKEN_MATI); this.name = "TokenAccurateMati"; }
}
export class SesiAccurateHabis extends Error {
    constructor() { super(PESAN_SESI_HABIS); this.name = "SesiAccurateHabis"; }
}

/** 401 Accurate -> galat berpesan tetap; selain token mati dianggap sesi habis. Badannya hanya dibaca, tidak dibawa. */
export const galat401 = (badan: string) => (tokenMati(badan) ? new TokenAccurateMati() : new SesiAccurateHabis());
