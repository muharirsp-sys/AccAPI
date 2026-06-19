/*
 * Tujuan: Sumber data dummy + helper kalkulasi (Time Gone, color tagging, taksiran insentif strata)
 *         untuk modul add-on Insentif Sales. Frontend-only — belum tersambung backend/DB.
 * Caller: app/(dashboard)/insentif-sales/page.tsx dan komponen tampilan di dalamnya.
 * Dependensi: tidak ada (murni TS, dipakai di Client Component).
 * Main Functions: getWorkdayProgress, paceStatus, lookupTier, estimateIncentive.
 * Side Effects: Tidak ada I/O; semua data statis untuk demo UI.
 */

// ====== Domain types ======
export type KpiType = "value" | "ec" | "ao" | "ia";
export type ChannelType = "TT" | "MT";

export interface Salesman {
    code: string;
    name: string;
    principle: string;       // dari kolom PRINCIPAL
    branch: string;          // dari kolom JENISPRODUK (cabang pengampu)
    channel: ChannelType;
    spv: string;
    sm: string;
    // Target bulanan
    targetValue: number;
    targetEc: number;
    targetAo: number;
    targetIa: number;
    // Realisasi MTD (month-to-date)
    realValue: number;
    realEc: number;
    realAo: number;
    realIa: number;
    // SPLM = Sama Periode Lalu (realisasi value bulan sebelumnya, untuk comparative insight)
    splmValue: number;
}

// ====== Master data dummy ======
export const PRINCIPLES = ["NESTLE", "UNILEVER", "INDOFOOD"] as const;
export const BRANCHES = ["BANDUNG", "CIMAHI", "SUMEDANG"] as const;

export const SALESMEN: Salesman[] = [
    {
        code: "SLS-001", name: "Andi Pratama", principle: "NESTLE", branch: "BANDUNG", channel: "TT",
        spv: "Budi Santoso", sm: "Hendra Wijaya",
        targetValue: 250_000_000, targetEc: 320, targetAo: 180, targetIa: 540,
        realValue: 168_500_000, realEc: 198, realAo: 142, realIa: 421, splmValue: 142_300_000,
    },
    {
        code: "SLS-002", name: "Siti Rahmawati", principle: "NESTLE", branch: "BANDUNG", channel: "MT",
        spv: "Budi Santoso", sm: "Hendra Wijaya",
        targetValue: 210_000_000, targetEc: 280, targetAo: 160, targetIa: 480,
        realValue: 205_900_000, realEc: 271, realAo: 158, realIa: 502, splmValue: 188_400_000,
    },
    {
        code: "SLS-003", name: "Rudi Hartono", principle: "UNILEVER", branch: "CIMAHI", channel: "TT",
        spv: "Dewi Lestari", sm: "Hendra Wijaya",
        targetValue: 300_000_000, targetEc: 360, targetAo: 200, targetIa: 600,
        realValue: 132_700_000, realEc: 158, realAo: 121, realIa: 318, splmValue: 151_900_000,
    },
    {
        code: "SLS-004", name: "Maya Anggraini", principle: "UNILEVER", branch: "CIMAHI", channel: "MT",
        spv: "Dewi Lestari", sm: "Hendra Wijaya",
        targetValue: 180_000_000, targetEc: 240, targetAo: 140, targetIa: 420,
        realValue: 161_400_000, realEc: 219, realAo: 133, realIa: 408, splmValue: 144_600_000,
    },
    {
        code: "SLS-005", name: "Fajar Nugroho", principle: "INDOFOOD", branch: "SUMEDANG", channel: "TT",
        spv: "Eko Saputra", sm: "Hendra Wijaya",
        targetValue: 220_000_000, targetEc: 300, targetAo: 170, targetIa: 510,
        realValue: 142_800_000, realEc: 174, realAo: 139, realIa: 372, splmValue: 138_100_000,
    },
    {
        code: "SLS-006", name: "Lina Marlina", principle: "INDOFOOD", branch: "SUMEDANG", channel: "MT",
        spv: "Eko Saputra", sm: "Hendra Wijaya",
        targetValue: 195_000_000, targetEc: 260, targetAo: 150, targetIa: 450,
        realValue: 196_200_000, realEc: 258, realAo: 151, realIa: 471, splmValue: 170_500_000,
    },
];

// ====== Skema insentif strata (Konstanta Insentif → tabel incentive_tiers) ======
// Tiap KPI punya jenjang persentase capaian → nominal rupiah.
export interface IncentiveTier {
    minPct: number;   // inklusif
    maxPct: number;   // eksklusif (kecuali tier tertinggi = Infinity)
    amount: number;   // rupiah
}

export const INCENTIVE_TIERS: Record<KpiType, IncentiveTier[]> = {
    value: [
        { minPct: 80, maxPct: 90, amount: 250_000 },
        { minPct: 90, maxPct: 100, amount: 500_000 },
        { minPct: 100, maxPct: 110, amount: 850_000 },
        { minPct: 110, maxPct: Infinity, amount: 1_200_000 },
    ],
    ec: [
        { minPct: 80, maxPct: 100, amount: 150_000 },
        { minPct: 100, maxPct: Infinity, amount: 350_000 },
    ],
    ao: [
        { minPct: 80, maxPct: 100, amount: 200_000 },
        { minPct: 100, maxPct: Infinity, amount: 450_000 },
    ],
    ia: [
        { minPct: 80, maxPct: 100, amount: 175_000 },
        { minPct: 100, maxPct: Infinity, amount: 400_000 },
    ],
};

export const KPI_LABELS: Record<KpiType, string> = {
    value: "Value",
    ec: "Effective Call",
    ao: "Aktif Outlet",
    ia: "Item Super/Toko",
};

// ====== Helpers ======

/**
 * Time Gone: persentase hari kerja (Senin–Jumat) yang telah berlalu terhadap
 * total hari kerja pada bulan dari `ref`. Frontend-only, weekend dianggap libur.
 */
export function getWorkdayProgress(ref: Date): { passed: number; total: number; pct: number } {
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

/** Lookup nominal insentif strata untuk satu KPI berdasar % capaian. */
export function lookupTier(kpi: KpiType, achievementPct: number): number {
    const tiers = INCENTIVE_TIERS[kpi];
    for (const t of tiers) {
        if (achievementPct >= t.minPct && achievementPct < t.maxPct) return t.amount;
    }
    return 0;
}

export interface IncentiveBreakdown {
    value: number;
    ec: number;
    ao: number;
    ia: number;
    total: number;
}

/** Taksiran insentif per salesman (jumlah seluruh KPI). */
export function estimateIncentive(s: Salesman): IncentiveBreakdown {
    const v = lookupTier("value", pct(s.realValue, s.targetValue));
    const ec = lookupTier("ec", pct(s.realEc, s.targetEc));
    const ao = lookupTier("ao", pct(s.realAo, s.targetAo));
    const ia = lookupTier("ia", pct(s.realIa, s.targetIa));
    return { value: v, ec, ao, ia, total: v + ec + ao + ia };
}

export function formatRp(n: number): string {
    return "Rp " + n.toLocaleString("id-ID");
}

export function formatShortRp(n: number): string {
    if (n >= 1_000_000_000) return "Rp " + (n / 1_000_000_000).toFixed(1) + " M";
    if (n >= 1_000_000) return "Rp " + (n / 1_000_000).toFixed(1) + " Jt";
    if (n >= 1_000) return "Rp " + (n / 1_000).toFixed(0) + " rb";
    return "Rp " + n.toLocaleString("id-ID");
}

// ====== Finance: rekap pembayaran 12 bulan (dummy) ======
export interface MonthlyPayout {
    month: number;       // 1-12
    label: string;
    totalIncentive: number;
    status: "lunas" | "tunggakan" | "belum";
}

export const MONTH_LABELS = [
    "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

export const PAYOUT_HISTORY: MonthlyPayout[] = [
    { month: 1, label: "Januari", totalIncentive: 18_450_000, status: "lunas" },
    { month: 2, label: "Februari", totalIncentive: 16_900_000, status: "lunas" },
    { month: 3, label: "Maret", totalIncentive: 21_200_000, status: "lunas" },
    { month: 4, label: "April", totalIncentive: 19_750_000, status: "tunggakan" },
    { month: 5, label: "Mei", totalIncentive: 22_300_000, status: "tunggakan" },
    { month: 6, label: "Juni", totalIncentive: 0, status: "belum" },
    { month: 7, label: "Juli", totalIncentive: 0, status: "belum" },
    { month: 8, label: "Agustus", totalIncentive: 0, status: "belum" },
    { month: 9, label: "September", totalIncentive: 0, status: "belum" },
    { month: 10, label: "Oktober", totalIncentive: 0, status: "belum" },
    { month: 11, label: "November", totalIncentive: 0, status: "belum" },
    { month: 12, label: "Desember", totalIncentive: 0, status: "belum" },
];
