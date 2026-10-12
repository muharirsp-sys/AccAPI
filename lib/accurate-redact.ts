/**
 * Tujuan: Sensor token di teks jawaban Accurate sebelum masuk log, jawaban cron, atau pesan tersimpan.
 *   Accurate menggemakan token di badan galat — 11 Okt 2026 badan 401 webhook-renew.do
 *   `"Invalid access token: <uuid>"` masuk log container. Token Accurate berbentuk UUID; sisa teks
 *   (kode galat) tetap terbaca dan JSON tetap sah. Tanpa dependensi supaya modul murni boleh memakainya.
 * Caller: cron webhook-renew, proxy, lib/sync, lib/accurate-invoice-write.
 */
export function redactAccurateSecrets(text: string) {
    return text
        .replace(/(token\s*:\s*)[^\s"'\\,}]+/gi, "$1[REDACTED]")
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[REDACTED]");
}
