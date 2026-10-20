/*
 * Tujuan: Uji agregasi murni Target vs Realisasi (rakitTarget): pengelompokan, persen null saat target 0, realisasi tanpa target, baris kantor,
 *   urutan, total = Σ baris, dan Σ per cabang = Σ per salesman dari input yang sama.
 * Caller: `npx tsx --test lib/laporan-sales/target.test.ts` (ikut `npm test`).
 * Dependensi: node:test, lib/laporan-sales/target (hanya rakitTarget; tidak menyentuh DB).
 * Side Effects: Tidak ada.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { rakitTarget, TANPA_CABANG, type RealisasiMasuk, type TargetMasuk } from "./target";

const T = (salesCode: string, principle: string, branch: string, targetValue: number, salesName = `SALES ${salesCode}`): TargetMasuk => ({ salesCode, salesName, principle, branch, targetValue });
const R = (salesCode: string, principle: string, realValue: number): RealisasiMasuk => ({ salesCode, principle, realValue });

const TARGET = [
    T("S1", "PRINCIPLE A", "CABANG A", 100_000_000),
    T("S2", "PRINCIPLE A", "CABANG A", 50_000_000),
    T("S1", "PRINCIPLE B", "CABANG A", 40_000_000),
    T("S3", "PRINCIPLE A", "CABANG B", 80_000_000),
    T("S4", "PRINCIPLE A", "CABANG B", 0), // baris target 0: bukan salesman bertarget
];
const REAL = [
    R("S1", "PRINCIPLE A", 90_000_000),
    R("S2", "PRINCIPLE A", 70_000_000),
    R("S1", "PRINCIPLE B", 10_000_000),
    R("S3", "PRINCIPLE A", 100_000_000),
    R("S4", "PRINCIPLE A", 5_000_000), // kuncinya punya baris target (0) → ikut cabang target, bukan "tanpa target"
];

test("pengelompokan per (cabang, principal): Σ target, Σ realisasi, salesman bertarget, persen 1 desimal", () => {
    const { baris } = rakitTarget("2026-09", TARGET, REAL);
    assert.deepEqual(baris, [
        { cabang: "CABANG A", principle: "PRINCIPLE A", salesman: 2, target: 150_000_000, realisasi: 160_000_000, persen: 106.7 },
        { cabang: "CABANG A", principle: "PRINCIPLE B", salesman: 1, target: 40_000_000, realisasi: 10_000_000, persen: 25 },
        { cabang: "CABANG B", principle: "PRINCIPLE A", salesman: 1, target: 80_000_000, realisasi: 105_000_000, persen: 131.3 },
    ]);
});

test("persen null saat target 0 — bukan 0%, bukan NaN/Infinity", () => {
    const j = rakitTarget("2026-09", [T("S4", "PRINCIPLE A", "CABANG A", 0)], [R("S4", "PRINCIPLE A", 5_000_000)]);
    assert.deepEqual(j.baris, [{ cabang: "CABANG A", principle: "PRINCIPLE A", salesman: 0, target: 0, realisasi: 5_000_000, persen: null }]);
    assert.equal(j.total.persen, null);
    // target ada tetapi realisasi 0 = capaian 0%, BUKAN null
    assert.equal(rakitTarget("2026-09", [T("S1", "PRINCIPLE A", "CABANG A", 10)], []).baris[0].persen, 0);
});

test("realisasi tanpa target tetap tampil: cabang dari progres, lalu dari salesman yang sama, lalu 'Tanpa cabang'", () => {
    const targets = [T("S1", "PRINCIPLE A", "CABANG A", 100)];
    const realisasi = [R("S1", "PRINCIPLE A", 100), R("S9", "PRINCIPLE C", 7), R("S1", "PRINCIPLE D", 3), R("S8", "PRINCIPLE E", 1)];
    const { baris, total } = rakitTarget("2026-09", targets, realisasi, new Map([["S9|PRINCIPLE C", "CABANG C"]]));
    assert.deepEqual(baris.map((b) => [b.cabang, b.principle, b.target, b.realisasi, b.persen]), [
        ["CABANG A", "PRINCIPLE A", 100, 100, 100],
        ["CABANG A", "PRINCIPLE D", 0, 3, null], // S1 punya target di CABANG A (principal lain)
        ["CABANG C", "PRINCIPLE C", 0, 7, null], // dari progres harian
        [TANPA_CABANG, "PRINCIPLE E", 0, 1, null], // tidak ada petunjuk cabang
    ]);
    assert.equal(total.realisasi, 111); // tidak ada yang hilang diam-diam
});

test("baris kantor (_OFFICE) bukan salesman: keluar dari target DAN realisasinya", () => {
    const targets = [T("S1", "PRINCIPLE A", "CABANG A", 100), T("X_OFFICE", "PRINCIPLE A", "CABANG A", 999, "OFFICE CABANG A")];
    const realisasi = [R("S1", "PRINCIPLE A", 50), R("X_OFFICE", "PRINCIPLE A", 888), R("Y_OFFICE", "PRINCIPLE B", 777)];
    const { baris, total } = rakitTarget("2026-09", targets, realisasi);
    assert.deepEqual(baris, [{ cabang: "CABANG A", principle: "PRINCIPLE A", salesman: 1, target: 100, realisasi: 50, persen: 50 }]);
    assert.deepEqual(total, { target: 100, realisasi: 50, persen: 50 });
});

test("cabang kosong/spasi = 'Tanpa cabang'; urutan cabang lalu principal, stabil terhadap urutan input", () => {
    const targets = [T("S1", "PRINCIPLE B", "CABANG B", 1), T("S2", "PRINCIPLE A", "  ", 1), T("S3", "PRINCIPLE A", "CABANG B", 1), T("S4", "PRINCIPLE A", "CABANG A", 1)];
    const urut = (x: TargetMasuk[]) => rakitTarget("2026-09", x, []).baris.map((b) => `${b.cabang}/${b.principle}`);
    assert.deepEqual(urut(targets), ["CABANG A/PRINCIPLE A", "CABANG B/PRINCIPLE A", "CABANG B/PRINCIPLE B", `${TANPA_CABANG}/PRINCIPLE A`]);
    assert.deepEqual(urut([...targets].reverse()), urut(targets));
});

test("total = Σ baris; bulan tanpa data = baris kosong, total 0 dan persen null", () => {
    const { baris, total } = rakitTarget("2026-09", TARGET, REAL);
    assert.equal(total.target, baris.reduce((s, b) => s + b.target, 0));
    assert.equal(total.realisasi, baris.reduce((s, b) => s + b.realisasi, 0));
    assert.equal(total.persen, 101.9); // 275 jt / 270 jt (target 150+40+80; realisasi 160+10+105)
    assert.deepEqual(rakitTarget("2026-10", [], []), { bulan: "2026-10", baris: [], total: { target: 0, realisasi: 0, persen: null } });
});

test("Σ per cabang = Σ per salesman dari input yang sama (termasuk realisasi tanpa target, baris kantor, cabang kosong)", () => {
    const targets = [...TARGET, T("S5", "PRINCIPLE C", "", 25_000_000), T("O1", "PRINCIPLE A", "CABANG A", 5_000_000, "OFFICE")];
    const realisasi = [...REAL, R("S5", "PRINCIPLE C", 30_000_000), R("S7", "PRINCIPLE A", 2_000_000), R("O1", "PRINCIPLE A", 4_000_000)];
    const { baris, total } = rakitTarget("2026-09", targets, realisasi);

    // Jalur kedua yang bebas dari pengelompokan cabang: jumlah per salesman langsung dari input (tanpa baris kantor).
    const perSales = new Map<string, { target: number; realisasi: number }>();
    const tambah = (kode: string, k: "target" | "realisasi", n: number) => perSales.set(kode, { target: 0, realisasi: 0, ...perSales.get(kode), [k]: (perSales.get(kode)?.[k] ?? 0) + n });
    for (const t of targets) if (!/OFFICE/.test(t.salesName)) tambah(t.salesCode, "target", t.targetValue);
    for (const r of realisasi) if (r.salesCode !== "O1") tambah(r.salesCode, "realisasi", r.realValue);

    const jumlah = (xs: Iterable<{ target: number; realisasi: number }>) => [...xs].reduce((a, x) => ({ target: a.target + x.target, realisasi: a.realisasi + x.realisasi }), { target: 0, realisasi: 0 });
    assert.deepEqual(jumlah(baris), jumlah(perSales.values()));
    assert.deepEqual({ target: total.target, realisasi: total.realisasi }, jumlah(perSales.values()));
    // per cabang juga konsisten dengan total
    const perCabang = new Map<string, number>();
    for (const b of baris) perCabang.set(b.cabang, (perCabang.get(b.cabang) ?? 0) + b.realisasi);
    assert.equal([...perCabang.values()].reduce((s, n) => s + n, 0), total.realisasi);
});
