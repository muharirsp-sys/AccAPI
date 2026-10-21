/*
 * Tujuan: Uji agregasi murni Monitoring Harian (hitungHarian): penjumlahan per hari, panjang 31 vs 30 hari, pemisahan per (pelanggan, salesman),
 *   gabungan kode salesman, dpp null (juga cabang cakupan non-global), saringan cakupan, saringan cabang, urutan, daftarTanggal.
 * Caller: `npx tsx --test lib/laporan-sales/harian.test.ts` (juga `npm test`).
 * Dependensi: node:test, ./harian (hitungHarian). Tanpa DB.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { daftarTanggal, hitungHarian, type FakturHarian, type ProfilSales } from "./harian";
import type { PetaOrang } from "../kasir/rekonsiliasi";

// id Accurate 1,2,3 = kode S-01, S-02, S-09; S-09 digabung ke S-01 pada 2026-10 saja.
const PETA: PetaOrang = {
    kodeSalesman: new Map([[1, "S-01"], [2, "S-02"], [3, "S-09"]]),
    gabunganPerBulan: new Map([["2026-10", new Map([["S-09", "S-01"]])]]),
};
const PROFIL = new Map<string, ProfilSales>([["S-01", { kode: "S-01", nama: "SALES A" }], ["S-02", { kode: "S-02", nama: "SALES B" }]]);
const NAMA_KODE = new Map([["S-09", "SALES I"]]);
const F = (o: Partial<FakturHarian> = {}): FakturHarian => ({ transDate: "05/10/2026", customerNo: "C-01", customerName: "TOKO A", salesmanId: 1, dpp: 1000, cabang: "CABANG A", ...o });
const hitung = (faktur: FakturHarian[], o: Partial<Parameters<typeof hitungHarian>[0]> = {}) =>
    hitungHarian({ bulan: "2026-10", faktur, peta: PETA, profil: PROFIL, namaKode: NAMA_KODE, global: true, cabangCakupan: new Set<string>(), ...o });

test("per hari dijumlah per tanggal, MTD = Σ, panjang = jumlah hari bulan (31), sen tanpa drift floating", () => {
    const j = hitung([F({ dpp: 0.1 }), F({ dpp: 0.2 }), F({ transDate: "31/10/2026", dpp: 500 }), F({ transDate: "01/10/2026", dpp: 250.5 }), F({ dpp: -100 })]);
    assert.equal(j.hari, 31);
    assert.equal(j.baris.length, 1);
    const [b] = j.baris;
    assert.equal(b.perHari.length, 31);
    assert.equal(b.perHari[4], -99.7); // 0,1 + 0,2 − 100 pada tanggal 5
    assert.equal(b.perHari[0], 250.5);
    assert.equal(b.perHari[30], 500);
    assert.equal(b.perHari.filter((x) => x === 0).length, 28);
    assert.equal(b.mtd, 650.8);
    assert.equal(hitung([F({ dpp: 0.1 }), F({ dpp: 0.2 })]).baris[0].mtd, 0.3);
    // 0,29 × 100 = 28,999999999999996 dan 0,57 × 100 = 56,99999999999999: tanpa pembulatan per faktur jumlahnya 0,8599999999999999.
    const drift = hitung([F({ dpp: 0.29 }), F({ dpp: 0.57 })]).baris[0];
    assert.equal(drift.perHari[4], 0.86);
    assert.equal(drift.mtd, 0.86);
});

test("bulan 30 hari: panjang 30, tanggal 30 = indeks 29, tanggal 31 (tak sah) dan faktur bulan lain dibuang", () => {
    const j = hitung([F({ transDate: "30/09/2026", dpp: 7 }), F({ transDate: "31/09/2026", dpp: 900 }), F({ transDate: "05/10/2026", dpp: 800 }),
        F({ transDate: "05/09/2025", dpp: 700 }), F({ transDate: null, dpp: 600 }), F({ transDate: "2026-09-05", dpp: 500 })], { bulan: "2026-09" });
    assert.equal(j.hari, 30);
    assert.equal(j.baris[0].perHari.length, 30);
    assert.equal(j.baris[0].perHari[29], 7);
    assert.equal(j.baris[0].mtd, 7);
    assert.equal(hitung([F({ transDate: "29/02/2028", dpp: 3 })], { bulan: "2028-02" }).baris[0].perHari[28], 3); // kabisat
});

test("satu baris per (pelanggan, salesman): pelanggan yang dilayani dua salesman terpisah, bukan digabung", () => {
    const j = hitung([F({ dpp: 100 }), F({ salesmanId: 2, dpp: 300 }), F({ salesmanId: 2, transDate: "06/10/2026", dpp: 50 }), F({ customerNo: "C-02", customerName: "TOKO B", dpp: 10 })]);
    assert.deepEqual(j.baris.map((b) => [b.custNo, b.salesCode, b.salesNama, b.mtd]), [["C-01", "S-02", "SALES B", 350], ["C-01", "S-01", "SALES A", 100], ["C-02", "S-01", "SALES A", 10]]);
});

test("gabungan kode bulan itu: S-09 -> S-01 satu baris; di bulan tanpa gabungan tetap S-09 dengan nama dari accurate_employee", () => {
    const j = hitung([F({ dpp: 100 }), F({ salesmanId: 3, dpp: 40 })]);
    assert.deepEqual(j.baris.map((b) => [b.salesCode, b.mtd]), [["S-01", 140]]);
    const lain = hitung([F({ transDate: "05/11/2026", salesmanId: 3, dpp: 40 })], { bulan: "2026-11" });
    assert.deepEqual(lain.baris.map((b) => [b.salesCode, b.salesNama]), [["S-09", "SALES I"]]);
});

test("dpp null tidak dijumlah dan dihitung terpisah; NaN diperlakukan sama; baris bernilai 0 tetap tampil", () => {
    const j = hitung([F({ dpp: 100 }), F({ dpp: null, salesmanId: null }), F({ dpp: Number.NaN }), F({ customerNo: "C-03", customerName: "TOKO C", dpp: 0 })]);
    assert.equal(j.fakturTanpaDpp, 2);
    assert.deepEqual(j.baris.map((b) => [b.custNo, b.mtd]), [["C-01", 100], ["C-03", 0]]);
    assert.ok(j.baris.every((b) => b.perHari.every(Number.isFinite)));
});

test("cakupan non-global: hanya salesman berprofil; tanpa salesman & salesman luar cakupan tidak tampil; global memuat baris tanpa salesman", () => {
    const faktur = [F({ dpp: 100 }), F({ salesmanId: 2, customerNo: "C-02", dpp: 200 }), F({ salesmanId: null, customerNo: "C-03", dpp: 300 }),
        F({ salesmanId: 3, customerNo: "C-04", transDate: "06/10/2026", dpp: 400 }), F({ salesmanId: 99, customerNo: "C-05", dpp: 500 })];
    const sempit = hitung(faktur, { global: false, profil: new Map([["S-02", PROFIL.get("S-02")!]]) });
    assert.deepEqual(sempit.baris.map((b) => [b.custNo, b.salesCode]), [["C-02", "S-02"]]);
    const luas = hitung(faktur, { global: false });
    assert.deepEqual(luas.baris.map((b) => [b.custNo, b.salesCode]).sort(), [["C-01", "S-01"], ["C-02", "S-02"], ["C-04", "S-01"]]);
    const global = hitung(faktur);
    assert.equal(global.baris.length, 5);
    const tanpa = global.baris.filter((b) => b.salesCode === null);
    assert.deepEqual(tanpa.map((b) => [b.custNo, b.salesNama, b.mtd]).sort(), [["C-03", null, 300], ["C-05", null, 500]]);
});

test("dpp null untuk cakupan non-global hanya dihitung bila cabangnya muncul di baris cakupan", () => {
    const faktur = [F({ dpp: 100 }), F({ dpp: null, salesmanId: null }), F({ dpp: null, salesmanId: null, cabang: "CABANG B" })];
    assert.equal(hitung(faktur, { global: false }).fakturTanpaDpp, 1);
    assert.equal(hitung(faktur).fakturTanpaDpp, 2);
});

test("non-global: SEMUA faktur cakupan belum terbaca -> tanpa baris tetapi fakturTanpaDpp > 0 (cabang salesman cakupan), cabang lain tidak dihitung", () => {
    const faktur = [F({ dpp: null, salesmanId: null }), F({ dpp: null, salesmanId: null, customerNo: "C-02" }), F({ dpp: null, salesmanId: null, cabang: "CABANG B" })];
    const j = hitung(faktur, { global: false, cabangCakupan: new Set(["CABANG A"]) });
    assert.deepEqual(j.baris, []);
    assert.equal(j.fakturTanpaDpp, 2);
    assert.equal(hitung(faktur, { global: false }).fakturTanpaDpp, 0); // tanpa cabang cakupan dan tanpa baris terbaca: tak ada dasar menghitung
    assert.equal(hitung(faktur, { global: false, cabangCakupan: new Set(["CABANG A"]), cabang: "CABANG B" }).fakturTanpaDpp, 0); // saringan cabang tetap berlaku
});

test("daftarTanggal: semua tanggal bulan dd/MM/yyyy berawalan nol (31, 30, 29 hari)", () => {
    const okt = daftarTanggal("2026-10");
    assert.equal(okt.length, 31);
    assert.deepEqual([okt[0], okt[8], okt[30]], ["01/10/2026", "09/10/2026", "31/10/2026"]);
    assert.equal(daftarTanggal("2026-09").length, 30);
    assert.equal(daftarTanggal("2028-02").at(-1), "29/02/2028");
    assert.equal(new Set(daftarTanggal("2026-02")).size, 28);
});

test("saringan cabang: baris + hitungan dpp null tersaring, pilihanCabang tidak menyusut; tanpa cabang = 'Tanpa cabang'", () => {
    const faktur = [F({ dpp: 100 }), F({ customerNo: "C-02", cabang: "CABANG B", dpp: 200 }), F({ customerNo: "C-03", cabang: "Tanpa cabang", dpp: 5 }),
        F({ dpp: null, salesmanId: null, cabang: "CABANG B" }), F({ dpp: null, salesmanId: null })];
    const j = hitung(faktur, { cabang: "CABANG B" });
    assert.deepEqual(j.baris.map((b) => b.custNo), ["C-02"]);
    assert.deepEqual(j.pilihanCabang, ["CABANG A", "CABANG B", "Tanpa cabang"]);
    assert.equal(j.fakturTanpaDpp, 1);
});

test("urutan: MTD turun, seri menurut nama pelanggan lalu kode salesman; tanpa faktur = kosong", () => {
    const j = hitung([F({ customerNo: "C-02", customerName: "TOKO B", dpp: 10 }), F({ dpp: 10 }), F({ customerNo: "C-03", customerName: "TOKO C", dpp: 99 })]);
    assert.deepEqual(j.baris.map((b) => b.custNama), ["TOKO C", "TOKO A", "TOKO B"]);
    assert.deepEqual(hitung([]), { bulan: "2026-10", hari: 31, pilihanCabang: [], baris: [], fakturTanpaDpp: 0 });
});
