/*
 * Tujuan: Uji agregasi murni Tidak Order — status yang dihitung kunjungan, pengelompokan alasan, kode tanpa padanan, persen (pembagi 0),
 *   saringan cakupan + cabang, urutan.
 * Caller: npx tsx --test lib/laporan-sales/tidak-order.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { persen, susunTidakOrder, type AlasanMaster, type BarisMentah, type ProfilSales } from "./tidak-order";

const b = (salesCode: string, status: string, kode: string | null, jumlah: number): BarisMentah => ({ salesCode, status, kode, jumlah });
const ALASAN: AlasanMaster[] = [
    { kode: "R01", label: "Stok masih cukup", kategori: "stok" },
    { kode: "R15", label: "Toko tutup", kategori: "kunjungan" },
];
const PROFIL: ProfilSales[] = [
    { salesCode: "S1", nama: "SALES A", cabang: "CABANG A" },
    { salesCode: "S2", nama: "SALES B", cabang: "CABANG B" },
    { salesCode: "S3", nama: "SALES C", cabang: "CABANG A" },
];
const susun = (baris: BarisMentah[], over: Partial<Parameters<typeof susunTidakOrder>[0]> = {}) =>
    susunTidakOrder({ baris, alasan: ALASAN, profil: PROFIL, cakupan: null, ...over });

test("kunjungan = ordered + active + not_order; not_visited dan priority TIDAK dihitung; tidakOrder = not_order saja", () => {
    const r = susun([b("S1", "ordered", null, 4), b("S1", "active", null, 1), b("S1", "not_order", "R01", 3), b("S1", "not_visited", null, 20), b("S2", "priority", null, 7)]);
    assert.equal(r.kunjungan, 8);
    assert.equal(r.tidakOrder, 3);
});

test("alasan hanya dari baris not_order (kode usang di baris ordered tidak dihitung); jumlah alasan = tidakOrder", () => {
    const r = susun([b("S1", "ordered", "R01", 5), b("S1", "not_order", "R01", 2), b("S2", "not_order", "R15", 1)]);
    assert.deepEqual(r.alasan.map((a) => [a.kode, a.jumlah]), [["R01", 2], ["R15", 1]]);
    assert.equal(r.alasan.reduce((s, a) => s + a.jumlah, 0), r.tidakOrder);
});

test("alasan: label + kategori dari master, kelompok sama digabung lintas salesman/status, urut jumlah turun lalu label", () => {
    const r = susun([b("S1", "not_order", "R01", 1), b("S2", "not_order", "R01", 2), b("S1", "not_order", "R15", 4), b("S3", "not_order", "RZZ", 3)]);
    assert.deepEqual(r.alasan[0], { kode: "R15", label: "Toko tutup", kategori: "kunjungan", jumlah: 4 });
    assert.deepEqual(r.alasan.map((a) => [a.kode, a.jumlah]), [["R15", 4], ["RZZ", 3], ["R01", 3]]); // seri 3 = 3 → label "RZZ" < "Stok masih cukup"
});

test("kode tanpa padanan di master -> label = kode, kategori kosong; null / kosong / spasi -> satu baris 'Tanpa alasan'", () => {
    const r = susun([b("S1", "not_order", "RX9", 2), b("S1", "not_order", null, 1), b("S2", "not_order", "", 1), b("S2", "not_order", "  ", 1)]);
    assert.deepEqual(r.alasan, [
        { kode: "", label: "Tanpa alasan", kategori: "", jumlah: 3 },
        { kode: "RX9", label: "RX9", kategori: "", jumlah: 2 },
    ]);
    assert.equal(susun([b("S1", "not_order", " R01 ", 1)]).alasan[0].label, "Stok masih cukup"); // dipangkas sebelum dicocokkan
});

test("perSalesman: hanya salesman bertidak-order, urut jumlah turun, nama dari profil (tanpa profil = kodenya)", () => {
    const r = susun([b("S1", "not_order", "R01", 1), b("S2", "not_order", "R01", 4), b("S2", "not_order", "R15", 1), b("S3", "ordered", null, 9), b("TANPA", "not_order", null, 2)]);
    assert.deepEqual(r.perSalesman, [
        { salesCode: "S2", salesNama: "SALES B", jumlah: 5 },
        { salesCode: "TANPA", salesNama: "TANPA", jumlah: 2 },
        { salesCode: "S1", salesNama: "SALES A", jumlah: 1 },
    ]);
});

test("cakupan non-global: hanya salesman dalam daftar; pilihanCabang tidak membocorkan cabang di luar cakupan", () => {
    const baris = [b("S1", "not_order", "R01", 2), b("S1", "ordered", null, 3), b("S2", "not_order", "R15", 9), b("S2", "ordered", null, 9)];
    const r = susun(baris, { cakupan: ["S1"] });
    assert.deepEqual([r.kunjungan, r.tidakOrder], [5, 2]);
    assert.deepEqual(r.perSalesman.map((s) => s.salesCode), ["S1"]);
    assert.deepEqual(r.pilihanCabang, ["CABANG A"]);
    assert.deepEqual(susun(baris, { cakupan: [] }), { kunjungan: 0, tidakOrder: 0, alasan: [], perSalesman: [], pilihanCabang: [] });
    assert.deepEqual(susun(baris).pilihanCabang, ["CABANG A", "CABANG B"]); // global melihat semua
});

test("saringan cabang = sales_profile.branch; salesman tanpa profil tidak lolos saringan cabang tapi lolos tanpa saringan", () => {
    const baris = [b("S1", "not_order", "R01", 1), b("S2", "not_order", "R01", 1), b("S3", "ordered", null, 2), b("TANPA", "not_order", "R01", 4)];
    const a = susun(baris, { cabang: "CABANG A" });
    assert.deepEqual([a.kunjungan, a.tidakOrder, a.perSalesman.map((s) => s.salesCode)], [3, 1, ["S1"]]);
    assert.equal(susun(baris, { cabang: "  CABANG A " }).tidakOrder, 1); // dipangkas
    assert.equal(susun(baris, { cabang: "CABANG ZZZ" }).kunjungan, 0);
    assert.equal(susun(baris).tidakOrder, 6);
    assert.deepEqual(a.pilihanCabang, ["CABANG A", "CABANG B"]); // pilihan tidak menyusut saat disaring
});

test("persen: pembagi 0 = null (bukan NaN/0), satu desimal, 0 dan 100", () => {
    assert.equal(persen(0, 0), null);
    assert.equal(persen(5, 0), null);
    assert.equal(persen(0, 5), 0);
    assert.equal(persen(1, 3), 33.3);
    assert.equal(persen(2, 3), 66.7);
    assert.equal(persen(7, 7), 100);
});

test("tanpa baris sama sekali: semua nol, daftar kosong (laporan bulan tanpa kunjungan)", () => {
    assert.deepEqual(susun([]), { kunjungan: 0, tidakOrder: 0, alasan: [], perSalesman: [], pilihanCabang: ["CABANG A", "CABANG B"] });
});
