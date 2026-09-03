/*
 * Tujuan: Kalkulasi insentif salesman channel MT — model 4 KPI berbobot nominal tetap.
 *         Total penuh Rp 1.000.000 per salesman (Value 350rb, EC 150rb, OA 150rb, IA 350rb).
 * Caller: app/api/insentif-sales/dashboard untuk channel MT.
 * Dependensi: lib/insentif-sales-calc (reuse percentageMultiplier, isSchemePrincipal, KONSTANTA_MIX).
 * Main Functions: computeMt (1 principle), computeMtMix (banyak principle).
 * Side Effects: none (pure).
 *
 * Aturan (tabel MT dikonfirmasi user 2026-08-18):
 * - Bobot nominal: VALUE 350.000 | EC 150.000 | OA 150.000 | IA 350.000 → Target Kontribusi 100% = 1jt.
 * - Penyebut persentase diambil dari target BARIS ITU (targetValue/Ec/Ao/Ia), BUKAN konstanta 240 —
 *   240 khusus GT. Target OA MT di file target berkisar 34–70.
 * - IA dibandingkan sebagai ITEM AKTIF PER OUTLET (realisasi_ia / realisasi_ao), bukan total mentah.
 *   Alasan: kolom "Item Aktif" di file closing adalah flag per baris transaksi (total 175–2.499),
 *   sementara Target IA di file target berkisar 9–45 — yang sebanding adalah rasionya
 *   (mis. M-FN target 40, realisasi 2499/65 = 38,4 → 96%). Kalau total mentah dipakai,
 *   IA selalu tembus cap dan 350rb dibayar penuh tanpa syarat.
 * - Pengali persentase & aturan status/support identik GT (percentageMultiplier, effectiveSupport):
 *   <90% → 0 ; 90–100% → aktual ; >100% → cap 1.00.
 * - KECUALI IA: ambangnya 80% (dikonfirmasi user 2026-09-03), khusus MT. KPI lain & seluruh GT
 *   tetap 90%.
 * - Support principle mengurangi pool sebelum dibagi 4 KPI (proporsional, sama seperti GT).
 */

import {
    percentageMultiplier,
    roundRatio,
    isSchemePrincipal,
    konstantaMix,
    RP_1JT,
    hasPositiveNetSales,
    type StatusInsentif,
} from "./insentif-sales-calc.ts";
import { DEFAULT_KONSTANTA, type Konstanta } from "./insentif-konstanta.ts";

/** Bobot nominal BAWAAN per KPI pada kontribusi 100%. Bisa diubah dari panel Admin. */
export const MT_BOBOT = {
    value: DEFAULT_KONSTANTA.mt.bobotValue, ec: DEFAULT_KONSTANTA.mt.bobotEc,
    ao: DEFAULT_KONSTANTA.mt.bobotAo, ia: DEFAULT_KONSTANTA.mt.bobotIa,
} as const;

export interface MtInput {
    status: StatusInsentif;
    target_value: number;
    target_ec: number;
    target_ao: number;
    target_ia: number;
    realisasi_value: number;
    realisasi_ec: number;
    realisasi_ao: number;
    realisasi_ia: number; // total flag "Item Aktif" — dibagi realisasi_ao jadi per-outlet
    nilai_support_principal?: number; // default 0
}

export interface MtResult {
    insentif_value: number;
    insentif_ec: number;
    insentif_ao: number;
    insentif_ia: number;
    total: number;
}

/** Sama seperti percentageMultiplier tapi ambangnya khusus IA (bawaan 0,80). */
function iaMultiplier(realisasi: number, target: number, ambang: number): number {
    if (!Number.isFinite(target) || target <= 0) return 0;
    if (!Number.isFinite(realisasi)) return 0;
    const r = roundRatio(realisasi / target);
    if (r < ambang) return 0;
    if (r > 1) return 1;
    return r;
}

const ZERO: MtResult = { insentif_value: 0, insentif_ec: 0, insentif_ao: 0, insentif_ia: 0, total: 0 };

/** Support efektif — status "distributor" berarti distributor bayar penuh (support 0). */
function effectiveSupport(status: StatusInsentif, support: number | undefined): number {
    return status === "distributor" ? 0 : (support ?? 0);
}

/**
 * Hitung 4 KPI dari pool tertentu. `pool` = porsi distributor untuk baris ini;
 * bobot di-skala proporsional terhadap RP_1JT supaya rasio 35/15/15/35 tetap.
 */
function fromPool(pool: number, input: MtInput, k: Konstanta): MtResult {
    if (pool <= 0) return ZERO;
    // Penjualan bersih <= 0 → tidak ada komponen apa pun, termasuk EC/OA/IA. Dikonfirmasi
    // user 2026-08-24 untuk AO; logikanya sama untuk ketiga KPI aktivitas lain — semuanya
    // dihitung dari transaksi, jadi mustahil ada tanpa penjualan bersih positif.
    // Lihat hasPositiveNetSales di lib/insentif-sales-calc.ts (audit temuan L2b).
    if (!hasPositiveNetSales(input.realisasi_value)) return ZERO;
    // Penyebut skala = JUMLAH bobot MT (kontribusi 100%), bukan RP_1JT — supaya rasio antar
    // KPI tetap benar kalau bobotnya diubah dari panel Admin. Dengan bobot bawaan keduanya sama.
    const total_bobot = k.mt.bobotValue + k.mt.bobotEc + k.mt.bobotAo + k.mt.bobotIa;
    if (total_bobot <= 0) return ZERO;
    const scale = pool / total_bobot;
    const amb = k.gt.ambangBayar;
    const insentif_value = k.mt.bobotValue * scale * percentageMultiplier(input.realisasi_value, input.target_value, amb);
    const insentif_ec = k.mt.bobotEc * scale * percentageMultiplier(input.realisasi_ec, input.target_ec, amb);
    const insentif_ao = k.mt.bobotAo * scale * percentageMultiplier(input.realisasi_ao, input.target_ao, amb);
    const iaPerOutlet = input.realisasi_ao > 0 ? input.realisasi_ia / input.realisasi_ao : 0;
    const insentif_ia = k.mt.bobotIa * scale * iaMultiplier(iaPerOutlet, input.target_ia, k.mt.ambangIa);
    return {
        insentif_value, insentif_ec, insentif_ao, insentif_ia,
        total: insentif_value + insentif_ec + insentif_ao + insentif_ia,
    };
}

/** Insentif MT untuk 1 principle. Pool = 1jt − support. */
export function computeMt(input: MtInput, k: Konstanta = DEFAULT_KONSTANTA): MtResult {
    if (!isSchemePrincipal(input.status)) return ZERO;
    return fromPool(Math.max(0, k.gt.pool1 - effectiveSupport(input.status, input.nilai_support_principal)), input, k);
}

export interface MtMixLineDetail extends MtResult {
    nama: string;
}

export interface MtMixResult {
    jumlah_valid: number;
    konstanta: number;
    total_support: number;
    porsi_distributor: number;
    rincian: MtMixLineDetail[];
    total: number;
}

export interface MtMixPrincipalInput extends MtInput {
    nama: string;
}

/**
 * Insentif MT untuk salesman yang pegang banyak principle.
 * Konstanta pool mengikuti tabel GT (KONSTANTA_MIX 2..5, cap 1,5jt) — aturan mix belum
 * didefinisikan terpisah untuk MT, jadi memakai tabel yang sudah disetujui daripada mengarang.
 * Pool dibagi RATA per principle valid, lalu tiap baris dihitung 4 KPI dari porsinya.
 */
export function computeMtMix(principals: MtMixPrincipalInput[], k: Konstanta = DEFAULT_KONSTANTA): MtMixResult {
    const valid = principals.filter((p) => isSchemePrincipal(p.status));
    const jumlah = valid.length;
    const total_support = valid.reduce((s, p) => s + effectiveSupport(p.status, p.nilai_support_principal), 0);
    const konstanta = jumlah === 0 ? 0 : jumlah === 1 ? k.gt.pool1 : konstantaMix(jumlah, k);
    const porsi_distributor = Math.max(0, konstanta - total_support);

    if (porsi_distributor <= 0) {
        return { jumlah_valid: jumlah, konstanta, total_support, porsi_distributor: 0, rincian: [], total: 0 };
    }

    const perLine = porsi_distributor / jumlah;
    const rincian = valid.map((p) => ({ nama: p.nama, ...fromPool(perLine, p, k) }));
    return {
        jumlah_valid: jumlah, konstanta, total_support, porsi_distributor,
        rincian, total: rincian.reduce((s, r) => s + r.total, 0),
    };
}
