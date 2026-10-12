/*
 * Tujuan: Self-check helper penyajian layar Rekapan Nota (Fiori S2): saringan pool, urutan wave, tanggal WITA,
 *         exception yang menahan konfirmasi. Rusak di sini = "Pilih semua" memilih yang tidak terlihat atau tanggal bergeser.
 * Caller: npm run test:rekapan
 * Dependensi: node:test. Tidak menyentuh DB maupun file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { jamWita, menahanKonfirmasi, saringPool, tanggalPanjang, tanggalPendek, urutanBerikutnya } from "@/lib/rekapan-nota/ui";

const POOL = [
    { no_nota: "INV/2610/KN01381", customer: "TK HARAPAN BARU", salesman: "Yusuf", area: "4", pareto: false },
    { no_nota: "INV/2610/KN01408", customer: "IDM DAENG TATA", salesman: "Sinta", area: "5", pareto: true },
    { no_nota: "INV/2610/KN01410", customer: null, salesman: null, area: null, pareto: null },
];

test("saringan pool: cari tanpa huruf besar-kecil, lalu DAN dengan salesman/area/pareto", () => {
    const base = { cari: "", salesman: "", area: "", pareto: false };
    assert.equal(saringPool(POOL, base).length, 3);
    assert.deepEqual(saringPool(POOL, { ...base, cari: "harapan" }).map((r) => r.no_nota), ["INV/2610/KN01381"]);
    assert.deepEqual(saringPool(POOL, { ...base, cari: "kn014" }).map((r) => r.no_nota), ["INV/2610/KN01408", "INV/2610/KN01410"]);
    assert.deepEqual(saringPool(POOL, { ...base, pareto: true }).map((r) => r.no_nota), ["INV/2610/KN01408"]);
    assert.deepEqual(saringPool(POOL, { ...base, salesman: "Sinta", area: "4" }), []);
    // Baris tanpa customer/salesman tidak melempar.
    assert.equal(saringPool(POOL, { ...base, cari: "zzz" }).length, 0);
});

test("urutan wave berikutnya: reguler = maks + 1, kanvas mulai 9; tidak terpengaruh tipe lain", () => {
    const wave = [{ tipe: "reguler", urutan: 1 }, { tipe: "reguler", urutan: 2 }, { tipe: "kanvas", urutan: 9 }];
    assert.equal(urutanBerikutnya(wave, "reguler"), 3);
    assert.equal(urutanBerikutnya(wave, "kanvas"), 10);
    assert.equal(urutanBerikutnya([], "reguler"), 1);
    assert.equal(urutanBerikutnya([], "kanvas"), 9);
});

test("tanggal YYYY-MM-DD tidak bergeser hari dan jam tampil WITA", () => {
    assert.equal(tanggalPendek("2026-10-06"), "06/10/2026");
    assert.match(tanggalPanjang("2026-10-06"), /^Selasa, 6 Okt 2026$/);
    assert.equal(tanggalPendek("bukan tanggal"), "bukan tanggal");
    // 01.40 UTC = 09.40 WITA.
    assert.equal(jamWita("2026-10-06T01:40:00Z"), "6 Okt 09.40");
    assert.equal(jamWita("rusak"), "");
});

test("hanya exception KONVERSI_* berstatus open yang menahan konfirmasi", () => {
    assert.equal(menahanKonfirmasi("KONVERSI_TIDAK_ADA", "open"), true);
    assert.equal(menahanKonfirmasi("KONVERSI_BEDA_DENGAN_EXPORT", "diabaikan"), false);
    assert.equal(menahanKonfirmasi("OUTLET_TANPA_AREA", "open"), false);
});
