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
 * - Support principle mengurangi pool sebelum dibagi 4 KPI (proporsional, sama seperti GT).
 */

import {
    percentageMultiplier,
    isSchemePrincipal,
    konstantaMix,
    RP_1JT,
    type StatusInsentif,
} from "./insentif-sales-calc.ts";

/** Bobot nominal per KPI pada kontribusi 100%. Jumlah = RP_1JT. */
export const MT_BOBOT = { value: 350_000, ec: 150_000, ao: 150_000, ia: 350_000 } as const;

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

const ZERO: MtResult = { insentif_value: 0, insentif_ec: 0, insentif_ao: 0, insentif_ia: 0, total: 0 };

/** Support efektif — status "distributor" berarti distributor bayar penuh (support 0). */
function effectiveSupport(status: StatusInsentif, support: number | undefined): number {
    return status === "distributor" ? 0 : (support ?? 0);
}

/**
 * Hitung 4 KPI dari pool tertentu. `pool` = porsi distributor untuk baris ini;
 * bobot di-skala proporsional terhadap RP_1JT supaya rasio 35/15/15/35 tetap.
 */
function fromPool(pool: number, input: MtInput): MtResult {
    if (pool <= 0) return ZERO;
    const scale = pool / RP_1JT;
    const insentif_value = MT_BOBOT.value * scale * percentageMultiplier(input.realisasi_value, input.target_value);
    const insentif_ec = MT_BOBOT.ec * scale * percentageMultiplier(input.realisasi_ec, input.target_ec);
    const insentif_ao = MT_BOBOT.ao * scale * percentageMultiplier(input.realisasi_ao, input.target_ao);
    const iaPerOutlet = input.realisasi_ao > 0 ? input.realisasi_ia / input.realisasi_ao : 0;
    const insentif_ia = MT_BOBOT.ia * scale * percentageMultiplier(iaPerOutlet, input.target_ia);
    return {
        insentif_value, insentif_ec, insentif_ao, insentif_ia,
        total: insentif_value + insentif_ec + insentif_ao + insentif_ia,
    };
}

/** Insentif MT untuk 1 principle. Pool = 1jt − support. */
export function computeMt(input: MtInput): MtResult {
    if (!isSchemePrincipal(input.status)) return ZERO;
    return fromPool(Math.max(0, RP_1JT - effectiveSupport(input.status, input.nilai_support_principal)), input);
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
export function computeMtMix(principals: MtMixPrincipalInput[]): MtMixResult {
    const valid = principals.filter((p) => isSchemePrincipal(p.status));
    const jumlah = valid.length;
    const total_support = valid.reduce((s, p) => s + effectiveSupport(p.status, p.nilai_support_principal), 0);
    const konstanta = jumlah === 0 ? 0 : jumlah === 1 ? RP_1JT : konstantaMix(jumlah);
    const porsi_distributor = Math.max(0, konstanta - total_support);

    if (porsi_distributor <= 0) {
        return { jumlah_valid: jumlah, konstanta, total_support, porsi_distributor: 0, rincian: [], total: 0 };
    }

    const perLine = porsi_distributor / jumlah;
    const rincian = valid.map((p) => ({ nama: p.nama, ...fromPool(perLine, p) }));
    return {
        jumlah_valid: jumlah, konstanta, total_support, porsi_distributor,
        rincian, total: rincian.reduce((s, r) => s + r.total, 0),
    };
}
