/*
 * Tujuan: Validasi tanggal bayar insentif pilihan pengguna (owner 8 Okt 2026, S4c-2).
 * Caller: app/api/insentif-sales/payments (POST) dan payments/[id] (PATCH).
 * Dependensi: tidak ada.
 * Main Functions: parsePaymentDate — "YYYY-MM-DD" (tanggal WITA) → Date, atau pesan galat.
 * Side Effects: tidak ada.
 */

const WITA_MS = 8 * 60 * 60 * 1000;

export function todayWita(now: Date): string {
    return new Date(now.getTime() + WITA_MS).toISOString().slice(0, 10);
}

/**
 * Tanpa tanggal, atau tanggal = hari ini WITA → `now` (perilaku lama). Tanggal lain disimpan
 * pukul 12.00 WITA: jam tengah hari tetap jatuh di tanggal yang sama bila dibaca dalam WIB/WITA/UTC.
 * Ditolak: format/tanggal kalender salah, masa depan (WITA), lebih awal dari tanggal 1 periode.
 */
export function parsePaymentDate(
    input: unknown,
    period: { periodMonth: number; periodYear: number },
    now: Date,
): { date: Date } | { error: string } {
    if (input === undefined || input === null || input === "") return { date: now };
    // Date.parse menggulirkan 02-30 ke 03-02 dan memberi NaN untuk 02-32; keduanya ditolak.
    const ms = typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input) ? Date.parse(`${input}T00:00:00Z`) : NaN;
    if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== input) {
        return { error: "Tanggal bayar harus berformat YYYY-MM-DD dan tanggal yang ada." };
    }
    const hariIni = todayWita(now);
    if (input > hariIni) return { error: `Tanggal bayar ${input} di masa depan (hari ini ${hariIni} WITA).` };
    const awalPeriode = `${period.periodYear}-${String(period.periodMonth).padStart(2, "0")}-01`;
    if (input < awalPeriode) {
        return { error: `Tanggal bayar ${input} lebih awal dari awal periode insentif (${awalPeriode}).` };
    }
    return { date: input === hariIni ? now : new Date(`${input}T12:00:00+08:00`) };
}
