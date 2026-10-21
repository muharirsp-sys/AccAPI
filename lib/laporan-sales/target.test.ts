/*
 * Tujuan: Uji agregasi murni Target vs Realisasi (rakitTarget): pengelompokan, persen null saat target 0, realisasi tanpa target TIDAK dijumlah
 *   (masuk tanpaTarget — sama dengan dashboard Insentif), baris kantor, urutan, total = Σ baris, dan kesetaraan Σ dengan rumus dashboard
 *   (Σ per cabang = Σ per salesman = Σ dashboard dari input yang sama).
 * Caller: `npx tsx --test lib/laporan-sales/target.test.ts` (ikut `npm test`).
 * Dependensi: node:test, lib/laporan-sales/target (hanya rakitTarget; tidak menyentuh DB), lib/insentif-sm-calc (isOfficeRow untuk pembanding).
 * Side Effects: Tidak ada.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isOfficeRow } from "@/lib/insentif-sm-calc";
import { rakitTarget, TANPA_CABANG, type RealisasiMasuk, type TargetMasuk } from "./target";

const T = (salesCode: string, principle: string, branch: string, targetValue: number, salesName = `SALES ${salesCode}`): TargetMasuk => ({ salesCode, salesName, principle, branch, targetValue });
const R = (salesCode: string, principle: string, realValue: number): RealisasiMasuk => ({ salesCode, principle, realValue });
const KOSONG = { kombinasi: 0, realisasi: 0 };

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
    R("S4", "PRINCIPLE A", 5_000_000), // kuncinya punya baris target (0) → ikut cabang target, seperti dashboard
];

test("pengelompokan per (cabang, principal): Σ target, Σ realisasi, salesman bertarget, persen 1 desimal", () => {
    const { baris, tanpaTarget } = rakitTarget("2026-09", TARGET, REAL);
    assert.deepEqual(baris, [
        { cabang: "CABANG A", principle: "PRINCIPLE A", salesman: 2, target: 150_000_000, realisasi: 160_000_000, persen: 106.7 },
        { cabang: "CABANG A", principle: "PRINCIPLE B", salesman: 1, target: 40_000_000, realisasi: 10_000_000, persen: 25 },
        { cabang: "CABANG B", principle: "PRINCIPLE A", salesman: 1, target: 80_000_000, realisasi: 105_000_000, persen: 131.3 },
    ]);
    assert.deepEqual(tanpaTarget, KOSONG);
});

test("persen null saat target 0 — bukan 0%, bukan NaN/Infinity", () => {
    const j = rakitTarget("2026-09", [T("S4", "PRINCIPLE A", "CABANG A", 0)], [R("S4", "PRINCIPLE A", 5_000_000)]);
    assert.deepEqual(j.baris, [{ cabang: "CABANG A", principle: "PRINCIPLE A", salesman: 0, target: 0, realisasi: 5_000_000, persen: null }]);
    assert.equal(j.total.persen, null);
    // target ada tetapi realisasi 0 = capaian 0%, BUKAN null
    assert.equal(rakitTarget("2026-09", [T("S1", "PRINCIPLE A", "CABANG A", 10)], []).baris[0].persen, 0);
});

test("realisasi tanpa baris target TIDAK dijumlah (= dashboard): masuk tanpaTarget, tidak menaikkan baris/total", () => {
    const targets = [T("S1", "PRINCIPLE A", "CABANG A", 100)];
    // S9|C kode belum ada di file target; S1|D salesman bertarget tetapi principal ini tidak; S8|E tak ada petunjuk apa pun.
    const realisasi = [R("S1", "PRINCIPLE A", 50), R("S9", "PRINCIPLE C", 7), R("S1", "PRINCIPLE D", 3), R("S8", "PRINCIPLE E", 1)];
    const j = rakitTarget("2026-09", targets, realisasi);
    assert.deepEqual(j.baris, [{ cabang: "CABANG A", principle: "PRINCIPLE A", salesman: 1, target: 100, realisasi: 50, persen: 50 }]);
    assert.deepEqual(j.total, { target: 100, realisasi: 50, persen: 50 }); // bukan 61 / 61%
    assert.deepEqual(j.tanpaTarget, { kombinasi: 3, realisasi: 11 });
});

test("baris kantor (_OFFICE) bukan salesman: keluar dari target dan realisasinya, dan BUKAN 'tanpa target'", () => {
    const targets = [T("S1", "PRINCIPLE A", "CABANG A", 100), T("X_OFFICE", "PRINCIPLE A", "CABANG A", 999, "OFFICE CABANG A")];
    const realisasi = [R("S1", "PRINCIPLE A", 50), R("X_OFFICE", "PRINCIPLE A", 888)];
    const { baris, total, tanpaTarget } = rakitTarget("2026-09", targets, realisasi);
    assert.deepEqual(baris, [{ cabang: "CABANG A", principle: "PRINCIPLE A", salesman: 1, target: 100, realisasi: 50, persen: 50 }]);
    assert.deepEqual(total, { target: 100, realisasi: 50, persen: 50 });
    assert.deepEqual(tanpaTarget, KOSONG); // kuncinya punya baris target (kantor): cocok, bukan belum bertarget
});

test("cabang kosong/spasi = 'Tanpa cabang'; urutan cabang lalu principal, stabil terhadap urutan input", () => {
    const targets = [T("S1", "PRINCIPLE B", "CABANG B", 1), T("S2", "PRINCIPLE A", "  ", 1), T("S3", "PRINCIPLE A", "CABANG B", 1), T("S4", "PRINCIPLE A", "CABANG A", 1)];
    const urut = (x: TargetMasuk[]) => rakitTarget("2026-09", x, []).baris.map((b) => `${b.cabang}/${b.principle}`);
    assert.deepEqual(urut(targets), ["CABANG A/PRINCIPLE A", "CABANG B/PRINCIPLE A", "CABANG B/PRINCIPLE B", `${TANPA_CABANG}/PRINCIPLE A`]);
    assert.deepEqual(urut([...targets].reverse()), urut(targets));
});

test("total = Σ baris; bulan tanpa data = baris kosong, total 0, persen null, tanpaTarget kosong", () => {
    const { baris, total } = rakitTarget("2026-09", TARGET, REAL);
    assert.equal(total.target, baris.reduce((s, b) => s + b.target, 0));
    assert.equal(total.realisasi, baris.reduce((s, b) => s + b.realisasi, 0));
    assert.equal(total.persen, 101.9); // 275 jt / 270 jt (target 150+40+80; realisasi 160+10+105)
    assert.deepEqual(rakitTarget("2026-10", [], []), { bulan: "2026-10", baris: [], total: { target: 0, realisasi: 0, persen: null }, tanpaTarget: KOSONG });
});

test("Σ laporan = Σ rumus dashboard (per cabang = per salesman = dashboard) — termasuk salesman tanpa target, kantor, target 0, cabang kosong", () => {
    const targets = [
        ...TARGET,
        T("S5", "PRINCIPLE C", "", 25_000_000), // cabang kosong
        T("O1", "PRINCIPLE A", "CABANG A", 5_000_000, "OFFICE"), // baris kantor
    ];
    const realisasi = [
        ...REAL,
        R("S5", "PRINCIPLE C", 30_000_000),
        R("O1", "PRINCIPLE A", 4_000_000), // kunci kantor
        R("S7", "PRINCIPLE A", 30_000_000), // salesman tanpa target: HARUS ke tanpaTarget, bukan ke baris/total
        R("S1", "PRINCIPLE D", 6_000_000), // salesman bertarget, principal ini tidak
    ];
    const { baris, total, tanpaTarget } = rakitTarget("2026-09", targets, realisasi);

    // Replika rumus dashboard (app/api/insentif-sales/dashboard/route.ts): rows = target non-kantor × realOf(kunci); Σ kartu = Σ rows;
    // kunci progres di luar targetKeys (kantor ikut targetKeys) = progressFeed.unmatchedKeys.
    const realOf = new Map(realisasi.map((r) => [`${r.salesCode}|${r.principle}`, r.realValue]));
    const rows = targets.filter((t) => !isOfficeRow(t.salesCode, t.salesName)).map((t) => ({ salesCode: t.salesCode, target: t.targetValue, real: realOf.get(`${t.salesCode}|${t.principle}`) ?? 0 }));
    const targetKeys = new Set(targets.map((t) => `${t.salesCode}|${t.principle}`));
    const tanpa = realisasi.filter((r) => !targetKeys.has(`${r.salesCode}|${r.principle}`));

    const jumlah = (xs: Iterable<{ target: number; realisasi: number }>) => [...xs].reduce((a, x) => ({ target: a.target + x.target, realisasi: a.realisasi + x.realisasi }), { target: 0, realisasi: 0 });
    const dashboard = jumlah(rows.map((r) => ({ target: r.target, realisasi: r.real })));
    assert.deepEqual({ target: total.target, realisasi: total.realisasi }, dashboard);
    assert.deepEqual(jumlah(baris), dashboard);
    assert.deepEqual(tanpaTarget, { kombinasi: tanpa.length, realisasi: tanpa.reduce((s, r) => s + r.realValue, 0) });
    assert.deepEqual(tanpaTarget, { kombinasi: 2, realisasi: 36_000_000 });

    // per salesman (rows dashboard dikelompokkan per kode) juga sama dengan Σ baris per cabang
    const perSales = new Map<string, { target: number; realisasi: number }>();
    for (const r of rows) perSales.set(r.salesCode, jumlah([perSales.get(r.salesCode) ?? { target: 0, realisasi: 0 }, { target: r.target, realisasi: r.real }]));
    assert.deepEqual(jumlah(perSales.values()), jumlah(baris));
});
