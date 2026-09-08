/*
 * Tujuan: Kalkulasi insentif salesman model konstanta-bobot untuk channel GT.
 *         Hanya menghitung NOMINAL INSENTIF (porsi distributor). Pencapaian/achievement 4-KPI
 *         tetap di lib/insentif-sales.ts (lookupTierFromDb) — modul ini TIDAK menggantikannya.
 * Caller: app/api/insentif-sales/dashboard untuk channel GT/TT.
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

import { DEFAULT_KONSTANTA, type Konstanta } from "./insentif-konstanta.ts";

// Angka-angka di bawah ini sekarang bisa diubah dari panel Admin (lib/insentif-konstanta).
// Konstanta yang diekspor tetap ada sebagai NILAI BAWAAN: pemanggil yang tidak mengoper `k`
// berperilaku persis seperti sebelum editor ada.
export const RP_1JT = DEFAULT_KONSTANTA.gt.pool1;
export const TARGET_AO_MIN = DEFAULT_KONSTANTA.gt.aoAmbang;
export const WEIGHT_AO = DEFAULT_KONSTANTA.gt.bobotAo;
export const WEIGHT_VALUE = DEFAULT_KONSTANTA.gt.bobotValue;

/** Konstanta pool untuk n principle (mix). n<2 → 0 (pakai exclusive); n>5 → cap pool 5. */
export function konstantaMix(n: number, k: Konstanta = DEFAULT_KONSTANTA): number {
    if (n < 2) return 0;
    const tabel: Record<number, number> = { 2: k.gt.mix2, 3: k.gt.mix3, 4: k.gt.mix4, 5: k.gt.mix5 };
    return tabel[n] ?? tabel[5];
}

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

/**
 * Bulatkan rasio ke 6 desimal (presisi 0,0001%) sebelum dibandingkan ke ambang.
 * Nilai uang disimpan sebagai double precision dan SUM() di Postgres tidak deterministik
 * terhadap urutan baris — tanpa pembulatan, rasio bisa jatuh di 0,9999999999 vs 1,0000000001
 * dan menghasilkan strata berbeda (beda Rp 1 juta untuk SM) yang BERUBAH antar refresh.
 * 1e-6 jauh di bawah ketelitian bisnis apa pun, jauh di atas galat float.
 */
export function roundRatio(r: number): number {
    return Math.round(r * 1e6) / 1e6;
}

/**
 * Pengali persentase pencapaian: <ambang→0, ambang–1.00→aktual, >1.00→cap 1.00.
 * `ambang` bawaannya 0,90 (aturan sejak awal) dan bisa diubah dari panel Admin.
 */
export function percentageMultiplier(
    realisasi: number,
    target: number,
    ambang: number = DEFAULT_KONSTANTA.gt.ambangBayar,
): number {
    if (!Number.isFinite(target) || target <= 0) return 0;
    if (!Number.isFinite(realisasi)) return 0;
    const r = roundRatio(realisasi / target);
    if (r < ambang) return 0;
    if (r > 1) return 1;
    return r;
}

export interface ExclusiveInput {
    status: StatusInsentif;
    target_value: number;
    /**
     * Ambang AO. Kosong = TARGET_AO_MIN (240), yaitu perilaku sejak awal. Diisi ketika
     * setelan `insentif_gt_ao_target` = "file", supaya AO dinilai terhadap target baris itu.
     * Parameter, bukan konstanta impor, agar aturannya bisa diubah tanpa menyentuh kalkulasi.
     */
    target_ao?: number;
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

/**
 * Penjualan bersih harus POSITIF sebelum komponen aktivitas (AO/EC/IA) berhak dibayar.
 * Dikonfirmasi user 2026-08-24: "tidak mungkin ada AO tanpa adanya penjualan bersih positif".
 *
 * Dua KPI dulu dihitung sepenuhnya independen: Value memakai realisasi (negatif → pengali 0,
 * benar), tapi AO memakai konstanta 240 sebagai penyebut dan TIDAK melihat Value sama sekali.
 * Akibatnya sales dengan realisasi bersih MINUS — retur murni tanpa penjualan, kasus nyata
 * MOTASA target Rp 700jt realisasi −Rp 21,4jt — tetap dibayar 70% dari pool (Rp 700.000)
 * selama AO ≥ 216 (audit temuan L2b).
 */
export function hasPositiveNetSales(realisasiValue: number): boolean {
    return Number.isFinite(realisasiValue) && realisasiValue > 0;
}

/** Insentif untuk 1 principle (eksklusif). */
export function computeExclusive(input: ExclusiveInput, k: Konstanta = DEFAULT_KONSTANTA): InsentifResult {
    if (!isSchemePrincipal(input.status)) return ZERO;
    // TIDAK ADA TARGET = TIDAK ADA INSENTIF (dikonfirmasi user 2026-08-29).
    // Sebelumnya komponen AO memakai penyebut 240 dan tidak melihat target Value sama sekali,
    // jadi baris yang targetnya belum diisi tetap berhak 70% pool (Rp 700.000). Itu membayar
    // target yang tidak ada. Baris seperti ini muncul di daftar peringatan /unmatched.
    if (!(input.target_value > 0)) return ZERO;
    // Penjualan bersih <= 0 → tidak ada komponen apa pun, termasuk AO.
    if (!hasPositiveNetSales(input.realisasi_value)) return ZERO;

    const support = effectiveSupport(input.status, input.nilai_support_principal);
    const K = Math.max(0, k.gt.pool1 - support); // porsi distributor
    if (K <= 0) return ZERO;

    const pAo = percentageMultiplier(input.realisasi_ao, input.target_ao ?? k.gt.aoAmbang, k.gt.ambangBayar);
    const pValue = percentageMultiplier(input.realisasi_value, input.target_value, k.gt.ambangBayar);

    const insentif_ao = k.gt.bobotAo * K * pAo;
    const insentif_value = k.gt.bobotValue * K * pValue;
    return { insentif_ao, insentif_value, total: insentif_ao + insentif_value };
}

export interface MixPrincipalInput {
    nama: string;
    status: StatusInsentif;
    target_value: number;
    /** Lihat ExclusiveInput.target_ao — kosong = ambang 240. */
    target_ao?: number;
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
export function computeMix(principals: MixPrincipalInput[], k: Konstanta = DEFAULT_KONSTANTA): MixResult {
    // Principal tanpa target TIDAK dihitung sebagai anggota grup mix (keputusan user 2026-08-29,
    // sejalan dengan computeExclusive). Dampaknya dua arah dan dua-duanya benar: principal itu
    // tidak dibayar, DAN ia tidak lagi menaikkan `n` sehingga konstanta pool anggota lain tidak
    // ikut membengkak karena baris yang targetnya lupa diisi.
    const valid = principals.filter((p) => isSchemePrincipal(p.status) && p.target_value > 0);
    const jumlah = valid.length;

    const total_support = valid.reduce((s, p) => s + effectiveSupport(p.status, p.nilai_support_principal), 0);

    // n=1 → pakai konstanta exclusive (Rp 1jt), BUKAN 0. Dikonfirmasi user 2026-08-24:
    // sales bertipe "mix" yang principle valid-nya tinggal 1 (sisanya berstatus "principle")
    // TETAP dapat insentif. Sebelumnya konstantaMix(1)=0 membuat insentifnya Rp 0 diam-diam,
    // sementara computeMtMix (MT) sudah punya fallback yang sama sejak awal.
    // >5 → cap 1,5jt (di dalam konstantaMix).
    const konstanta = jumlah === 1 ? k.gt.pool1 : konstantaMix(jumlah, k);
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
    const insentif_value = k.gt.bobotValue * K * percentageMultiplier(totalRealisasi, totalTarget, k.gt.ambangBayar);

    // AO: budget dibagi rata per principle valid.
    const budgetAo = (k.gt.bobotAo * K) / jumlah;

    const rincian: MixLineDetail[] = valid.map((p) => {
        // Principal dengan penjualan bersih <= 0 tidak dapat apa pun — baik AO maupun porsi
        // Value-nya. Alokasi Value memakai share target (bukan realisasi), jadi tanpa guard
        // ini principal yang realisasinya minus tetap kebagian potongan Value global.
        if (!hasPositiveNetSales(p.realisasi_value)) {
            return { nama: p.nama, insentif_ao: 0, insentif_value: 0, total: 0 };
        }
        const insentif_ao = budgetAo * percentageMultiplier(p.realisasi_ao, p.target_ao ?? k.gt.aoAmbang, k.gt.ambangBayar);
        // Value global dialokasikan proporsional ke target_value (rata bila total target 0).
        const share = totalTarget > 0 ? p.target_value / totalTarget : 1 / jumlah;
        const line_value = insentif_value * share;
        return { nama: p.nama, insentif_ao, insentif_value: line_value, total: insentif_ao + line_value };
    });
    const total_ao = rincian.reduce((s, r) => s + r.insentif_ao, 0);
    // Jumlah dari rincian, BUKAN insentif_value global: porsi Value principal yang realisasinya
    // <= 0 memang dinolkan di atas, jadi total yang memakai angka global akan melebihkan.
    // `insentif_value` tetap dilaporkan apa adanya sebagai angka gabungan sebelum alokasi.
    const total_value_dibayar = rincian.reduce((s, r) => s + r.insentif_value, 0);

    return {
        jumlah_valid: jumlah, konstanta, total_support, porsi_distributor,
        rincian, total_ao, insentif_value, total: total_ao + total_value_dibayar,
    };
}

/**
 * Normalisasi kolom "Channel". Dibaca dengan perbandingan literal ("GT"/"TT"/"MT") di seluruh
 * modul, sementara nilainya dulu masuk apa adanya dari Excel — `"Gt"` berarti tidak cocok
 * cabang mana pun sehingga SELURUH baris itu insentifnya Rp 0, kolom Pencapaian tetap terisi
 * normal (jadi tidak terlihat salah), dan barisnya hilang dari panel Input Support sehingga
 * Finance tidak bisa memperbaikinya dari layar (audit 2026-08-28, M4).
 */
export function normalizeChannel(raw: string): "GT" | "TT" | "MT" {
    const v = raw.trim().toUpperCase();
    if (v === "GT" || v === "TT" || v === "MT") return v;
    throw new Error(`Channel tidak dikenal: "${raw}". Pakai GT, TT, atau MT.`);
}

/** Normalisasi nilai kolom Excel "Status Insentif". Lempar error utk nilai tak dikenal (trust boundary). */
export function normalizeStatus(raw: string): StatusInsentif {
    const s = raw.trim().toLowerCase().replace(/\s+/g, "");
    if (s === "principle" || s === "principal") return "principle";
    if (s === "distributor") return "distributor";
    if (s === "distributor+principle" || s === "distributor+principal" || s === "distributorprinciple" || s === "distributor_principle")
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
