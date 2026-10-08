/*
 * Tujuan: Helper tampilan Insentif Sales: Time Gone hari kerja, warna laju, persen, format rupiah, nama bulan.
 * Caller: app/(dashboard)/insentif-sales/*.tsx (Fiori S4c).
 * Dependensi: tidak ada (murni TS, dipakai di Client Component).
 * Main Functions: getWorkdayProgress, getPeriodWorkdayProgress, paceStatus, pct, itemSuper, formatRp, formatShortRp.
 * Side Effects: Tidak ada I/O.
 */

// ====== Helpers ======

/**
 * Time Gone: persentase hari kerja (Senin–Jumat) yang telah berlalu terhadap
 * total hari kerja pada bulan dari `ref`. Frontend-only, weekend dianggap libur.
 */
export interface WorkdayProgress { passed: number; total: number; pct: number }

export function getWorkdayProgress(ref: Date): WorkdayProgress {
    const year = ref.getFullYear();
    const month = ref.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    let total = 0;
    let passed = 0;
    for (let d = 1; d <= daysInMonth; d++) {
        const day = new Date(year, month, d).getDay(); // 0 = Minggu, 6 = Sabtu
        if (day === 0 || day === 6) continue;
        total++;
        if (d <= ref.getDate()) passed++;
    }
    const pctVal = total > 0 ? (passed / total) * 100 : 0;
    return { passed, total, pct: Math.round(pctVal) };
}

/** Progress hari kerja periode terpilih: bulan lalu 100%, bulan depan 0%, bulan ini aktual. */
export function getPeriodWorkdayProgress(year: number, month: number, today = new Date()): WorkdayProgress {
    const selectedKey = year * 12 + month;
    const currentKey = today.getFullYear() * 12 + today.getMonth() + 1;
    const fullMonth = getWorkdayProgress(new Date(year, month, 0));
    if (selectedKey < currentKey) return fullMonth;
    if (selectedKey > currentKey) return { passed: 0, total: fullMonth.total, pct: 0 };
    return getWorkdayProgress(today);
}

export type PaceLevel = "green" | "yellow" | "red";

/**
 * Color tagging dinamis: capaian dibandingkan Time Gone.
 * Merah <80%, Kuning 80–99%, Hijau >=100% (relatif terhadap pace yang diharapkan).
 */
export function paceStatus(achievementPct: number, timeGonePct: number): PaceLevel {
    const expected = timeGonePct > 0 ? timeGonePct : 1;
    const ratio = (achievementPct / expected) * 100;
    if (ratio >= 100) return "green";
    if (ratio >= 80) return "yellow";
    return "red";
}

export function pct(real: number, target: number): number {
    if (!target) return 0;
    return Math.round((real / target) * 1000) / 10; // 1 desimal
}

export function itemSuper(ia: number, ao: number): number {
    if (!ao) return 0;
    return Math.round((ia / ao) * 100) / 100;
}

export function formatRp(n: number): string {
    return "Rp " + n.toLocaleString("id-ID");
}

const satuDesimal = (n: number) => n.toLocaleString("id-ID", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function formatShortRp(n: number): string {
    if (n >= 1_000_000_000) return "Rp " + satuDesimal(n / 1_000_000_000) + " M";
    if (n >= 1_000_000) return "Rp " + satuDesimal(n / 1_000_000) + " Jt";
    if (n >= 1_000) return "Rp " + (n / 1_000).toFixed(0) + " rb";
    return "Rp " + n.toLocaleString("id-ID");
}

export const MONTH_LABELS = [
    "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];
