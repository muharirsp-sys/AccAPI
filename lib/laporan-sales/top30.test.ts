/*
 * Tujuan: Uji fungsi murni Top 30 (batas bulan, konversi satuan ke KRT, agregasi, peringkat: urut nilai vs qty, batas 30, seri stabil,
 *   pembulatan, teks SQL). Konversi satuan dari master barang diuji dengan peta rasio buatan tangan (tanpa Postgres).
 * Caller: `npx tsx --test lib/laporan-sales/top30.test.ts` (juga ikut `npm test`).
 * Dependensi: lib/laporan-sales/top30 (tanpa menyentuh DB).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BATAS, agregasi, batasBulan, konversi, peringkat, sqlTop30, type Detail, type Mentah, type Rasio } from "./top30";

const m = (kode: string, nilai: number, qty: number, over: Partial<Mentah> = {}): Mentah =>
    ({ kode, nama: `PRODUK ${kode}`, nilai, qty, faktur: 1, satuan: ["KRT"], setaraKrt: true, ...over });
const d = (cust: string, kode: string, sat: string, qty: number, nilai = 1): Detail => ({ cust, kode, sat, qty, nilai });
// PCS dasar; KRT = 24 PCS; PAK = 6 PCS. BOX-ONLY tanpa KRT: PCS dasar, BOX = 12 PCS.
const RASIO: Rasio = new Map([
    ["A", { PCS: 1, PAK: 6, KRT: 24 }],
    ["B", { PCS: 1, BOX: 12 }],
    ["C", { KRT: 10, PCS: 1 }],
]);

test("batasBulan: batas atas = awal bulan berikut, Desember lompat tahun, Februari tidak bergantung jumlah hari", () => {
    assert.deepEqual(batasBulan("2026-09"), ["2026-09-01", "2026-10-01"]);
    assert.deepEqual(batasBulan("2026-12"), ["2026-12-01", "2027-01-01"]);
    assert.deepEqual(batasBulan("2024-02"), ["2024-02-01", "2024-03-01"]);
});

test("konversi: ke KRT lewat satuan dasar (langsung dan berantai), huruf besar/kecil + spasi diabaikan", () => {
    assert.deepEqual(konversi(48, "PCS", RASIO.get("A")), { satuan: "KRT", qty: 2, krt: true });
    assert.deepEqual(konversi(3, "KRT", RASIO.get("A")), { satuan: "KRT", qty: 3, krt: true });
    assert.deepEqual(konversi(12, "PAK", RASIO.get("A")), { satuan: "KRT", qty: 3, krt: true }); // 12 PAK = 72 PCS = 3 KRT
    assert.deepEqual(konversi(12, " krt ", RASIO.get("A")), { satuan: "KRT", qty: 12, krt: true });
    assert.equal(konversi(5, "PCS", RASIO.get("C")).qty, 0.5); // KRT = 10 PCS
});

test("konversi: tanpa satuan KRT → satuan dasar dan DITANDAI (krt false)", () => {
    assert.deepEqual(konversi(2, "BOX", RASIO.get("B")), { satuan: "PCS", qty: 24, krt: false });
    assert.deepEqual(konversi(7, "PCS", RASIO.get("B")), { satuan: "PCS", qty: 7, krt: false });
});

test("konversi: tak dikenal (barang tak ada, satuan tak ada, rasio kosong/nol, tanpa satuan dasar) = apa adanya, tidak pernah ditebak", () => {
    assert.deepEqual(konversi(9, "SCH", undefined), { satuan: "SCH", qty: 9, krt: false }); // barang tak ada di master
    assert.deepEqual(konversi(9, "SCH", RASIO.get("A")), { satuan: "SCH", qty: 9, krt: false }); // satuan tak ada di barang itu
    assert.deepEqual(konversi(9, "KRT", {}), { satuan: "KRT", qty: 9, krt: false }); // rasioSatuan membuang rasio null/nol → peta kosong
    assert.deepEqual(konversi(4, "BOX", { BOX: 12 }), { satuan: "BOX", qty: 4, krt: false }); // tanpa KRT dan tanpa satuan dasar (isi 1)
    assert.deepEqual(konversi(3, "", RASIO.get("A")), { satuan: "(kosong)", qty: 3, krt: false });
});

test("agregasi: produk menjumlah satuan berbeda di KRT; pelanggan lintas barang bersatuan beda = tidak setara (campur)", () => {
    const detail = [d("T1", "A", "PCS", 48, 100), d("T1", "A", "KRT", 1, 50), d("T2", "A", "KRT", 4, 10), d("T1", "B", "BOX", 1, 5)];
    const info = new Map([["A", { nama: "PRODUK A", faktur: 3 }], ["B", { nama: "PRODUK B", faktur: 1 }], ["T1", { nama: "TOKO A", faktur: 2 }]]);
    const produk = agregasi(detail, RASIO, "kode", info);
    const a = produk.find((x) => x.kode === "A")!;
    assert.deepEqual([a.nama, a.nilai, a.qty, a.faktur, a.satuan, a.setaraKrt], ["PRODUK A", 160, 7, 3, ["KRT"], true]); // 2 + 1 + 4 KRT
    const b = produk.find((x) => x.kode === "B")!;
    assert.deepEqual([b.qty, b.satuan, b.setaraKrt], [12, ["PCS"], false]); // 1 BOX = 12 PCS, bukan KRT
    const pel = agregasi(detail, RASIO, "cust", info);
    const t1 = pel.find((x) => x.kode === "T1")!;
    assert.deepEqual([t1.nilai, t1.satuan, t1.setaraKrt, t1.qty], [155, ["KRT", "PCS"], false, 48 + 1 + 1]); // qty = Σ mentah, UI menulis "campur"
    assert.equal(t1.nama, "TOKO A");
    const t2 = pel.find((x) => x.kode === "T2")!;
    assert.deepEqual([t2.qty, t2.satuan, t2.setaraKrt, t2.nama, t2.faktur], [4, ["KRT"], true, "T2", 0]); // nama/faktur cadangan = kode / 0
});

test("urut nilai vs qty menghasilkan urutan berbeda dari data yang sama", () => {
    const data = [m("A", 100, 5), m("B", 300, 1), m("C", 200, 9)];
    assert.deepEqual(peringkat(data, "nilai").map((b) => b.kode), ["B", "C", "A"]);
    assert.deepEqual(peringkat(data, "qty").map((b) => b.kode), ["C", "A", "B"]);
});

test("urut Qty hanya memuat baris setara KRT; urut Nilai memuat semuanya", () => {
    const data = [m("A", 100, 5), m("X", 900, 99999, { satuan: ["PCS"], setaraKrt: false }), m("C", 200, 9)];
    assert.deepEqual(peringkat(data, "qty").map((b) => b.kode), ["C", "A"]); // X (99.999 PCS) tidak sebanding dengan KRT
    assert.deepEqual(peringkat(data, "nilai").map((b) => b.kode), ["X", "C", "A"]);
    assert.equal(peringkat(data, "nilai")[0].setaraKrt, false);
});

test("peringkat 1..N berurutan dan dibatasi 30 teratas", () => {
    const data = Array.from({ length: 35 }, (_, i) => m(`K${String(i).padStart(2, "0")}`, i + 1, 1));
    const hasil = peringkat(data, "nilai");
    assert.equal(BATAS, 30);
    assert.equal(hasil.length, 30);
    assert.deepEqual(hasil.map((b) => b.peringkat), Array.from({ length: 30 }, (_, i) => i + 1));
    assert.equal(hasil[0].kode, "K34"); // nilai terbesar 35
    assert.equal(hasil[29].kode, "K05"); // 30 teratas = nilai 35..6; nilai 5..1 terbuang
    assert.equal(peringkat(data, "nilai", 3).length, 3);
    assert.deepEqual(peringkat([], "nilai"), []);
});

test("seri nilai: metrik satunya, lalu KODE (nama sengaja berlawanan urutan), lalu nama — hasil sama untuk urutan masukan apa pun", () => {
    // nama berurutan TERBALIK dari kode: bila seri kode dibuang, seri nama memutuskan lain ⇒ uji merah.
    const data = [m("C", 100, 5, { nama: "AAA" }), m("A", 100, 5, { nama: "ZZZ" }), m("B", 100, 9, { nama: "MMM" }), m("D", 100, 1, { nama: "BBB" })];
    const harapan = ["B", "A", "C", "D"]; // qty 9 dulu; qty sama (A, C) → kode naik (bukan nama); D qty terkecil
    assert.deepEqual(peringkat(data, "nilai").map((b) => b.kode), harapan);
    assert.deepEqual(peringkat([...data].reverse(), "nilai").map((b) => b.kode), harapan);
    // urut qty, seri qty → nilai menentukan; seri nilai juga → kode
    const qty = [m("X", 50, 7), m("Z", 90, 7), m("Y", 90, 7, { nama: "AAA" })];
    assert.deepEqual(peringkat(qty, "qty").map((b) => b.kode), ["Y", "Z", "X"]);
    // seri penuh (kode sama) → nama
    assert.deepEqual(peringkat([m("K", 1, 1, { nama: "B" }), m("K", 1, 1, { nama: "A" })], "nilai").map((b) => b.nama), ["A", "B"]);
    // masukan tidak diubah
    assert.deepEqual(data.map((b) => b.kode), ["C", "A", "B", "D"]);
});

test("pembulatan terjadi SESUDAH urut: dua nilai yang sama setelah dibulatkan tetap terurut menurut nilai asli", () => {
    const hasil = peringkat([m("A", 100.2, 1), m("B", 100.4, 1)], "nilai");
    assert.deepEqual(hasil.map((b) => [b.kode, b.nilai]), [["B", 100], ["A", 100]]);
    assert.equal(peringkat([m("A", 1568088288.312433, 0.1 + 0.2)], "nilai")[0].nilai, 1568088288);
    assert.equal(peringkat([m("A", 1, 0.1 + 0.2)], "nilai")[0].qty, 0.3); // 0.30000000000000004 → 0.3
});

test("sqlTop30: saringan principal memakai +im.principal di ketiga kueri (jangan dirapikan: indeks principal menyapu setahun), tanpa principal tak ada saringannya", () => {
    const dengan = sqlTop30("HEINZ");
    for (const k of ["detail", "produk", "pelanggan"] as const) {
        assert.match(dengan[k], /AND \+im\.principal = \?/);
        assert.doesNotMatch(dengan[k], /[^+]im\.principal/);
        assert.match(dengan[k], /shi\.tanggal >= \? AND shi\.tanggal < \?/);
        assert.match(dengan[k], /shi\.referensi LIKE 'INV\/%'/);
        assert.doesNotMatch(sqlTop30(null)[k], /principal/);
    }
    assert.match(dengan.produk, /GROUP BY shi\.kode_objek$/); // produk per kode_objek saja
    assert.match(dengan.produk, /MAX\(shi\.nama_produk\)/);
});
