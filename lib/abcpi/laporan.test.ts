/* Kunci: baris laporan ABCPI (template ABCPI.xlsx) dari faktur/retur Accurate — diskon bertingkat, EC, tanda retur, RSJ dibuang. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { akhirBulan, barisSales, barisStok, keCsv, KOLOM_SO, mingguExcel, rincianDiskon } from "./laporan.ts";

const item = { no: "26032190330030", name: "NU MTEA MATCHA LATTE 24BTL X 330ML", charField1: "ABC PRESIDENT INDONESIA, PT" };
const baris = (seq: number, q: Record<string, unknown>) => ({
    seq, item, quantity: 1, unitRatio: 24, unitPrice: 148198.2, grossAmount: 148198.2, itemDiscPercent: "", itemCashDiscount: 0,
    dppAmount: 148198.2, tax1Amount: 16301.8, salesmanName: "ABC5_JALANI", salesmanList: [{ number: "M-JAL" }], ...q,
});
const faktur = {
    number: "INV/2610/AB00347", transDate: "13/10/2026", dueDate: "23/10/2026", toAddress: "JL A, NO 1\nMAKASSAR",
    customer: { name: "ANDI ATIFA, TK {C-AND074}", customerNo: "C-AND074-AB" },
    detailItem: [
        baris(2, { itemDiscPercent: "1+1.25", itemCashDiscount: 3329.95, dppAmount: 144868.25, tax1Amount: 15935.51 }),
        baris(1, {}),
        baris(3, { unitPrice: 0, grossAmount: 0, totalPrice: 0, dppAmount: 0, tax1Amount: 0, quantity: 2, unitRatio: 1 }),
        baris(5, { totalPrice: 148198.2, dppAmount: 0, tax1Amount: 0 }), // faktur tanpa pajak: tetap F, DPP = totalPrice
        { seq: 4, item: { no: "99", name: "LAIN", charField1: "KINO" }, quantity: 1, unitPrice: 10, dppAmount: 10 },
    ],
};

test("diskon 1+1.25 dipecah bertingkat dan jumlahnya sama dengan itemCashDiscount", () => {
    const d = rincianDiskon(148198.2, "1+1.25", 3329.95);
    assert.equal(Math.round(d[0] * 100) / 100, 1481.98);
    assert.ok(Math.abs(d.reduce((a, b) => a + b, 0) - 3329.95) < 1e-9);
    assert.deepEqual(rincianDiskon(1000, "", 50), [50, 0, 0, 0, 0]);
    assert.deepEqual(rincianDiskon(1000, "5", 0), [0, 0, 0, 0, 0]);
});

test("pekan WEEKNUM(…;1) dan akhir bulan", () => {
    assert.equal(mingguExcel("2026-10-13"), 42); // sama dengan Pkn file SP_20261023_SALES.csv
    assert.equal(mingguExcel("2025-07-01"), 27); // contoh template
    assert.equal(akhirBulan("2026-10-31"), true);
    assert.equal(akhirBulan("2026-10-30"), false);
    assert.equal(akhirBulan("2028-02-29"), true);
});

test("faktur: urut seq, EC hanya baris pertama, bonus = B bernilai 0, barang principal lain dibuang", () => {
    const { baris: b, galat } = barisSales([faktur], []);
    assert.deepEqual(galat, []);
    assert.equal(b.length, 4);
    assert.deepEqual(b.map((r) => [r.Tipe, r.EC]), [["F", "1"], ["F", "0"], ["B", "0"], ["F", "0"]]);
    const [satu, dua, bonus, tanpaPajak] = b;
    assert.equal(tanpaPajak.DPP, 148198.2);
    assert.equal(tanpaPajak.NET, 148198.2);
    assert.equal(satu.PCode, "BT103206");
    assert.equal(satu.Qty, 24);
    assert.equal(satu.CustID, "C-AND074");
    assert.equal(satu.Alamat, "JL A. NO 1 MAKASSAR");
    assert.equal(satu.DueDate, "2026-10-23");
    assert.equal(satu.NoOrder, "INV/2610/AB00347"); // tanpa SO → nomor faktur (catatan template)
    assert.equal(dua.Disc_Int, 0);
    assert.ok(Math.abs(Number(dua.TotDisc) - 3329.95) < 1e-9);
    assert.ok(Number(dua.Disc2_ext) > 0);
    assert.equal(bonus.Qty, 2);
    assert.equal(bonus.NET, 0);
});

test("retur: nilai dan qty negatif, tanpa jatuh tempo, EC 0; RSJ dan faktur non-INV dibuang", () => {
    const retur = { ...faktur, number: "RJN/2610/AB00040", detailItem: [baris(1, { quantity: 8, unitRatio: 1, unitPrice: 6174.925, grossAmount: undefined, dppAmount: 49399.4, tax1Amount: 5433.93 })] };
    const { baris: b } = barisSales([{ ...faktur, number: "RJN/2610/AB00001" }], [retur, { ...retur, number: "RSJ/2610/00001" }]);
    assert.equal(b.length, 1);
    const [r] = b;
    assert.equal(r.Tipe, "R");
    assert.equal(r.EC, "0");
    assert.equal(r.DueDate, "");
    assert.equal(r.Qty, -8);
    assert.ok(Math.abs(Number(r.JumJ) + 49399.4) < 1e-6);
    assert.ok(Math.abs(Number(r.NET) + 54833.33) < 1e-6);
});

test("barang ABC tanpa kode principle = galat; stok tanpa kode dilewati dan dilaporkan", () => {
    const baru = { ...faktur, detailItem: [{ seq: 1, item: { no: "26999", name: "BARU", charField1: "ABC PRESIDENT INDONESIA, PT" }, quantity: 1, unitPrice: 1, dppAmount: 1 }] };
    assert.match(barisSales([baru], []).galat[0], /26999/);
    const s = barisStok("2026-10-26", [
        { no: "B", nama: "X", total: 100, bs: 30, peta: { kode: "FN1", isi: 40 } },
        { no: "A", nama: "Y", total: 5, bs: 0, peta: undefined },
        { no: "C", nama: "KAOS", total: 5, bs: 0, peta: null },
    ]);
    assert.deepEqual(s.baris.map((r) => [r.PcDist, r.Stock_Baik, r.Stock_BS]), [["B", 70, 30]]);
    assert.deepEqual(s.lewat, ["A (Y)"]);
});

test("CSV pipe: header template, CRLF, tanpa koma, angka maks 3 desimal, -0 jadi 0", () => {
    const csv = keCsv(KOLOM_SO, barisSales([faktur], []).baris);
    const [kepala, pertama] = csv.split("\r\n");
    assert.equal(kepala.split("|").length, 41);
    assert.ok(!csv.includes(","));
    assert.match(pertama, /^SP\|INV\/2610\/AB00347\|2026-10-13\|F\|/);
    assert.match(pertama, /\|6174\.925\|24\|/);
    assert.ok(csv.endsWith("\r\n"));
});
