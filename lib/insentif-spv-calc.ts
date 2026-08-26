/*
 * Tujuan: Kalkulasi insentif SPV — strata berbasis Value SAJA (bukan AO+Value seperti Sales).
 *         Rate per-principal ditentukan oleh jumlah principal valid yang dicover SPV.
 * Caller: app/api/insentif-sales/spv-dashboard (tetap pure dan tanpa I/O).
 * Dependensi: lib/insentif-sales-calc (reuse percentageMultiplier, isSchemePrincipal, StatusInsentif).
 * Main Functions: calculateInsentifSPV (group per principle + hitung), ratePerPrincipalSpv (tabel strata).
 * Side Effects: none (pure).
 *
 * Aturan (dikonfirmasi user):
 * - Value SPV per principal = SUM target & realisasi SEMUA baris sales bawahan untuk principal itu
 *   (lintas channel — GT/TT/MT, karena distinction channel hanya relevan utk insentif per-Sales).
 * - Principal dihitung valid (masuk count) jika MINIMAL 1 baris sales bawahan berstatus skema
 *   (distributor/distributor_principle) — bukan seluruhnya "principle" (full principle, spt Motasa/Heinz).
 * - Rate per principal (strata):
 *     n=1            → flat Rp 1.500.000 (kasus khusus, di luar garis)
 *     n=2..6         → Total(n) = 1.200.000 + 200.000×n, rate = Total(n)/n
 *     n>6            → rate DITAHAN di 400.000 (nilai n=6), tidak turun lagi.
 *                      Dikonfirmasi user 2026-08-21 utk kasus SPV ANI yang pegang 10 principal.
 *                      Konsekuensi: total SPV naik terus seiring jumlah principal (n=10 → 4jt),
 *                      berbeda dari formula yang kalau diekstrapolasi memberi 3,2jt.
 *   Terverifikasi cocok persis ke tabel given: n=2→800rb, 3→600rb, 4→500rb, 5→440rb, 6→400rb.
 *   n>6 ekstrapolasi otomatis dari formula yang sama (mendekati 200rb, tak pernah negatif).
 * - Insentif_n = rate × spvMultiplier(realisasi, target): <100% → 0, ≥100% → rate PENUH.
 *   Ambang dinilai PER PRINCIPAL, bukan dari total wilayah SPV (dikonfirmasi user 2026-08-26).
 *   Beda dari Sales/SM yang memakai percentageMultiplier (90-100% dibayar proporsional).
 * - Total_Insentif_SPV = sum(Insentif_n). TIDAK ada komponen AO — murni Value.
 *
 * Support principle utk SPV (dikonfirmasi user 2026-08-19):
 * - Principal yang support-nya LEBIH DARI rate → keluar dari hitungan jumlah principal,
 *   persis seperti status "principle" di skema GT. Contoh: SPV pegang 3 principal → rate 600rb;
 *   satu principal support > 600rb → dianggap pegang 2 principal saja → rate naik jadi 800rb.
 *   Kasus nyata: MARTEN, MOTASA support 4,17jt → keluar, n 3→2.
 * - Support TEPAT SAMA dengan rate tidak mengeluarkan principal (kriteria "lebih dari", bukan
 *   "minimal"): ia tetap dihitung dan distributor bayar 0 untuknya.
 * - Support SEBAGIAN (< rate) → principal tetap dihitung, distributor bayar sisanya (rate − support),
 *   mengikuti pola GT. Contoh: YARMAN 1 principal (KINO) support 300rb, rate n=1 = 1,5jt →
 *   distributor bayar 1,2jt.
 * - Karena rate bergantung pada n dan n bergantung pada siapa yang tertutup penuh, pengecualian
 *   diulang sampai titik tetap: berhenti saat tidak ada lagi principal yang tertutup penuh pada
 *   rate final. Iterasi selalu menyusut, jadi pasti berhenti.
 * - Angka support SPV tidak bisa diturunkan dari support sales — rasionya beda per principal
 *   (KINO 10%, MOTASA 50% dari total support sales-nya), jadi disimpan eksplisit di spv_support.
 */

import { roundRatio, isSchemePrincipal, type StatusInsentif } from "./insentif-sales-calc.ts";

/**
 * Pengali SPV: semua atau tidak sama sekali pada ambang 100% (dikonfirmasi user 2026-08-26).
 * SENGAJA tidak memakai percentageMultiplier milik Sales/MT: di sana 90-100% dibayar
 * proporsional, dan menumpang di fungsi yang sama berarti mengubah aturan SPV ikut mengubah
 * nominal Sales. Rasio dibulatkan lebih dulu (roundRatio) supaya 0,9999999999 hasil SUM
 * double precision tidak menjatuhkan seluruh rate ke nol dan berubah antar refresh.
 */
export function spvMultiplier(realisasi: number, target: number): number {
    if (!Number.isFinite(target) || target <= 0) return 0;
    if (!Number.isFinite(realisasi)) return 0;
    return roundRatio(realisasi / target) >= 1 ? 1 : 0;
}

export interface SpvSalesRow {
    principle: string;
    targetValue: number;
    realisasiValue: number;
    statusInsentif: StatusInsentif;
}

export interface SpvPrincipalDetail {
    principle: string;
    targetValue: number;
    realisasiValue: number;
    pctValue: number;
    rate: number;
    support: number;      // support principle utk SPV pada principal ini
    porsiDistributor: number; // rate − support (floor 0)
    insentif: number;
}

export interface SpvInsentifResult {
    jumlahValid: number;
    ratePerPrincipal: number;
    rincian: SpvPrincipalDetail[];
    /** Principal yang keluar dari hitungan karena support principle menutup penuh rate. */
    dikecualikan: string[];
    total: number;
}

/**
 * Rate per principal berdasar jumlah principal valid.
 * n=1 flat 1,5jt; n=2..6 pakai Total(n)/n; n>6 ditahan di 400rb (nilai n=6) — tidak turun lagi.
 * Math.max menangani penahanan itu sekaligus: formula 200rb + 1,2jt/n turun di bawah 400rb
 * tepat setelah n=6, jadi tidak perlu cabang khusus.
 */
export function ratePerPrincipalSpv(n: number): number {
    if (n <= 0) return 0;
    if (n === 1) return 1_500_000;
    return Math.max(400_000, 200_000 + 1_200_000 / n);
}

interface PrincipleAgg {
    targetValue: number;
    realisasiValue: number;
    hasScheme: boolean;
}

/** Group baris sales per principle: SUM target/realisasi, valid jika minimal 1 baris berstatus skema. */
function groupByPrinciple(rows: SpvSalesRow[]): Map<string, PrincipleAgg> {
    const map = new Map<string, PrincipleAgg>();
    for (const r of rows) {
        const g = map.get(r.principle) ?? { targetValue: 0, realisasiValue: 0, hasScheme: false };
        g.targetValue += r.targetValue;
        g.realisasiValue += r.realisasiValue;
        if (isSchemePrincipal(r.statusInsentif)) g.hasScheme = true;
        map.set(r.principle, g);
    }
    return map;
}

/**
 * Cari himpunan principal yang benar-benar dibayar distributor, sekaligus rate-nya.
 * Buang SEMUA principal yang support-nya melebihi rate saat ini (serentak), lalu hitung ulang rate.
 * Satu lintasan sebenarnya cukup: rate(n) = 200rb + 1,2jt/n NAIK ketika n turun, jadi principal
 * yang tadinya di bawah rate lama pasti masih di bawah rate baru yang lebih tinggi — tidak akan
 * ada pengecualian gelombang kedua. Loop dipertahankan supaya sifat itu tidak perlu dipercaya
 * begitu saja kalau tabel rate suatu saat diubah. Batas 20 sebagai jaring aman.
 */
function resolveValidSet(
    candidates: string[],
    supportOf: (principle: string) => number,
): { valid: string[]; rate: number; dikecualikan: string[] } {
    let valid = [...candidates];
    const dikecualikan: string[] = [];
    let rate = ratePerPrincipalSpv(valid.length);

    for (let i = 0; i < 20; i++) {
        rate = ratePerPrincipalSpv(valid.length);
        if (valid.length === 0) break;
        // "lebih dari" (bukan >=): support tepat sama dengan rate TIDAK mengeluarkan principal —
        // ia tetap dihitung, distributor cuma bayar 0 untuknya (rate − support = 0).
        const covered = valid.filter((p) => supportOf(p) > rate);
        if (covered.length === 0) break;
        dikecualikan.push(...covered);
        valid = valid.filter((p) => !covered.includes(p));
    }
    return { valid, rate: ratePerPrincipalSpv(valid.length), dikecualikan };
}

/**
 * Insentif SPV — agregat per principal dari seluruh sales bawahan, murni berbasis Value.
 * `supportByPrinciple` = support principle utk SPV ini per principal (opsional, default 0).
 */
export function calculateInsentifSPV(
    rows: SpvSalesRow[],
    supportByPrinciple?: Map<string, number>,
): SpvInsentifResult {
    const grouped = groupByPrinciple(rows);
    const supportOf = (p: string) => supportByPrinciple?.get(p) ?? 0;
    const schemePrincipals = [...grouped.entries()].filter(([, g]) => g.hasScheme).map(([p]) => p);

    const { valid, rate, dikecualikan } = resolveValidSet(schemePrincipals, supportOf);
    const jumlahValid = valid.length;

    if (jumlahValid === 0 || rate <= 0) {
        return { jumlahValid: 0, ratePerPrincipal: 0, rincian: [], dikecualikan, total: 0 };
    }

    const rincian: SpvPrincipalDetail[] = valid.map((principle) => {
        const g = grouped.get(principle)!;
        const pctValue = spvMultiplier(g.realisasiValue, g.targetValue);
        const support = supportOf(principle);
        const porsiDistributor = Math.max(0, rate - support);
        return {
            principle,
            targetValue: g.targetValue,
            realisasiValue: g.realisasiValue,
            pctValue,
            rate,
            support,
            porsiDistributor,
            insentif: porsiDistributor * pctValue,
        };
    });
    const total = rincian.reduce((s, r) => s + r.insentif, 0);

    return { jumlahValid, ratePerPrincipal: rate, rincian, dikecualikan, total };
}
