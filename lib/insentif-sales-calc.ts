/*
 * Tujuan: Kalkulasi insentif salesman model konstanta-bobot untuk channel GT.
 *         Hanya menghitung NOMINAL INSENTIF (porsi distributor). Pencapaian/achievement 4-KPI
 *         tetap di lib/insentif-sales.ts (lookupTierFromDb) — modul ini TIDAK menggantikannya.
 * Caller: (belum di-wire) — rencana: app/api/insentif-sales/dashboard untuk row channel === "GT".
 * Dependensi: tidak ada (pure functions, tanpa DB / I/O).
 * Main Functions: computeExclusive (1 principle), computeMix (banyak principle), normalizeStatus/Tipe.
 * Side Effects: none.
 *
 * Aturan (spec, dikonfirmasi via contoh case):
 * - 2 KPI: AO bobot 70%, Value bobot 30%.
 * - Target AO konstan 240 (penyebut persentase AO).
 * - Pengali persentase: <0.90 → 0 ; 0.90–1.00 → aktual ; >1.00 → cap 1.00.
 * - Konstanta = porsi insentif penuh berdasar jumlah principle yang dipegang.
 * - Yang dibayar DISTRIBUTOR = konstanta − total support principle (floor 0; support ≥ konstanta → 0),
 *   lalu di-split 70/30 × pencapaian.
 *   Contoh: exclusive konstanta 1jt, support 700rb → distributor 300rb.
 *           mix 3 principle konstanta 1.2jt, support 700rb → distributor 500rb.
 * - Status Insentif menentukan principle ikut skema atau tidak:
 *     "distributor_principle" → ikut, support principle dikurangkan.
 *     "distributor"          → ikut, distributor bayar penuh (support = 0).
 *     "principle"            → TIDAK ikut (full principle) → tak dihitung & tak menambah count.
 */

export const RP_1JT = 1_000_000;
export const TARGET_AO_MIN = 240;
export const WEIGHT_AO = 0.7;
export const WEIGHT_VALUE = 0.3;

// Konstanta per jumlah principle yang ikut skema (mix). Spec mendefinisikan 2..5.
const KONSTANTA_MIX: Record<number, number> = {
    2: 1_000_000,
    3: 1_200_000,
    4: 1_400_000,
    5: 1_500_000,
};

export type StatusInsentif = "distributor_principle" | "distributor" | "principle";
export type TipeSales = "mix" | "exclusive";

/** True jika principle ikut skema insentif distributor (masuk hitungan count + dapat insentif). */
export function isSchemePrincipal(status: StatusInsentif): boolean {
    return status === "distributor_principle" || status === "distributor";
}

/** Support efektif yang dikurangkan dari konstanta. Status "distributor" → distributor bayar penuh (0). */
function effectiveSupport(status: StatusInsentif, support: number | undefined): number {
    if (status === "distributor") return 0;
    return support ?? 0;
}

/** Pengali persentase pencapaian: <0.90→0, 0.90–1.00→aktual, >1.00→cap 1.00. */
export function percentageMultiplier(realisasi: number, target: number): number {
    if (target <= 0) return 0;
    const r = realisasi / target;
    if (r < 0.9) return 0;
    if (r > 1) return 1;
    return r;
}

export interface ExclusiveInput {
    status: StatusInsentif;
    target_value: number;
    realisasi_value: number;
    realisasi_ao: number;
    nilai_support_principal?: number; // default 0
}

export interface InsentifResult {
    insentif_ao: number;
    insentif_value: number;
    total: number;
}

const ZERO: InsentifResult = { insentif_ao: 0, insentif_value: 0, total: 0 };

/** Insentif untuk 1 principle (eksklusif). */
export function computeExclusive(input: ExclusiveInput): InsentifResult {
    if (!isSchemePrincipal(input.status)) return ZERO;

    const support = effectiveSupport(input.status, input.nilai_support_principal);
    const K = Math.max(0, RP_1JT - support); // porsi distributor
    if (K <= 0) return ZERO;

    const pAo = percentageMultiplier(input.realisasi_ao, TARGET_AO_MIN);
    const pValue = percentageMultiplier(input.realisasi_value, input.target_value);

    const insentif_ao = WEIGHT_AO * K * pAo;
    const insentif_value = WEIGHT_VALUE * K * pValue;
    return { insentif_ao, insentif_value, total: insentif_ao + insentif_value };
}

export interface MixPrincipalInput {
    nama: string;
    status: StatusInsentif;
    target_value: number;
    realisasi_value: number;
    realisasi_ao: number;
    nilai_support_principal?: number;
}

export interface MixLineDetail {
    nama: string;
    insentif_ao: number;    // porsi AO principle ini
    insentif_value: number; // porsi Value global, dialokasikan proporsional ke target_value
    total: number;
}

export interface MixResult {
    jumlah_valid: number;
    konstanta: number;
    total_support: number;
    porsi_distributor: number; // konstanta − total_support (floor 0)
    rincian: MixLineDetail[];
    total_ao: number;
    insentif_value: number; // Value global (gabungan)
    total: number;
}

/** Insentif untuk banyak principle (mix). Count hanya principle yang ikut skema (status != "principle"). */
export function computeMix(principals: MixPrincipalInput[]): MixResult {
    const valid = principals.filter((p) => isSchemePrincipal(p.status));
    const jumlah = valid.length;

    const total_support = valid.reduce((s, p) => s + effectiveSupport(p.status, p.nilai_support_principal), 0);

    // ponytail: spec hanya 2..5. <2 → seharusnya exclusive; >5 → cap 1.5jt.
    const konstanta = jumlah < 2 ? 0 : (KONSTANTA_MIX[jumlah] ?? KONSTANTA_MIX[5]);
    const porsi_distributor = Math.max(0, konstanta - total_support);

    const empty = (): MixResult => ({
        jumlah_valid: jumlah, konstanta, total_support, porsi_distributor: 0,
        rincian: [], total_ao: 0, insentif_value: 0, total: 0,
    });
    if (konstanta <= 0 || porsi_distributor <= 0) return empty();

    const K = porsi_distributor;

    // Value: gabungan/global atas principle valid.
    const totalTarget = valid.reduce((s, p) => s + p.target_value, 0);
    const totalRealisasi = valid.reduce((s, p) => s + p.realisasi_value, 0);
    const insentif_value = WEIGHT_VALUE * K * percentageMultiplier(totalRealisasi, totalTarget);

    // AO: budget dibagi rata per principle valid.
    const budgetAo = (WEIGHT_AO * K) / jumlah;

    const rincian: MixLineDetail[] = valid.map((p) => {
        const insentif_ao = budgetAo * percentageMultiplier(p.realisasi_ao, TARGET_AO_MIN);
        // Value global dialokasikan proporsional ke target_value (rata bila total target 0).
        const share = totalTarget > 0 ? p.target_value / totalTarget : 1 / jumlah;
        const line_value = insentif_value * share;
        return { nama: p.nama, insentif_ao, insentif_value: line_value, total: insentif_ao + line_value };
    });
    const total_ao = rincian.reduce((s, r) => s + r.insentif_ao, 0);

    return {
        jumlah_valid: jumlah, konstanta, total_support, porsi_distributor,
        rincian, total_ao, insentif_value, total: total_ao + insentif_value,
    };
}

/** Normalisasi nilai kolom Excel "Status Insentif". Lempar error utk nilai tak dikenal (trust boundary). */
export function normalizeStatus(raw: string): StatusInsentif {
    const s = raw.trim().toLowerCase().replace(/\s+/g, "");
    if (s === "principle" || s === "principal") return "principle";
    if (s === "distributor") return "distributor";
    if (s === "distributor+principle" || s === "distributor+principal" || s === "distributorprinciple")
        return "distributor_principle";
    throw new Error(`Status Insentif tidak dikenal: "${raw}"`);
}

/** Normalisasi nilai kolom Excel "Tipe Sales". */
export function normalizeTipe(raw: string): TipeSales {
    const s = raw.trim().toLowerCase();
    if (s === "mix") return "mix";
    if (s === "exclusive" || s === "eksklusif") return "exclusive";
    throw new Error(`Tipe Sales tidak dikenal: "${raw}"`);
}
