/* Kunci: nomor faktur yang masuk seri cabang lain tidak bisa ditarik kembali dari pembukuan.
   Data uji diambil apa adanya dari probe live DB CV Surya Perkasa 2026-09-09. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchBranchAutoNumbers } from "./branch-auto-number.ts";

const branches = [
    { id: 50, name: "Kantor Pusat" },
    { id: 150, name: "MIX FOOD" },
    { id: 250, name: "MIX NON FOOD" },
    { id: 350, name: "FORISA" },
    { id: 850, name: "FORISA - MT" },
    { id: 1350, name: "GODREJ" },
    { id: 1450, name: "MSM" },
];

const autoNumbers = [
    { id: 56, name: "Faktur Penjualan MF", transactionType: "SI" },
    { id: 250, name: "Faktur Penjualan MNF", transactionType: "SI" },
    { id: 150, name: "Faktur Penjualan FR", transactionType: "SI" },
    { id: 1150, name: "Faktur Penjualan FR - MT", transactionType: "SI" },
    { id: 1850, name: "Faktur Penjualan Godrej", transactionType: "SI" },
    { id: 2050, name: "Faktur Penjualan MSM", transactionType: "SI" },
    // Bertipe SI tapi PEMBELIAN — ada sungguhan di database ini.
    { id: 2000, name: "Faktur Pembelian MSM", transactionType: "SI" },
    { id: 350, name: "Bank Maybank No.Acc 2115003838", transactionType: "BVC" },
];

const byBranch = (id: number) => matchBranchAutoNumbers(branches, autoNumbers).find((row) => row.branchId === id)!;

test("nama cabang cocok apa adanya, beda huruf besar-kecil tidak masalah", () => {
    assert.equal(byBranch(1350).autoNumberId, 1850);
    assert.equal(byBranch(1450).autoNumberId, 2050);
});

test("singkatan seri dipetakan eksplisit, dan MF tidak tertukar dengan MNF", () => {
    assert.equal(byBranch(150).autoNumberId, 56);
    assert.equal(byBranch(250).autoNumberId, 250);
    assert.equal(byBranch(350).autoNumberId, 150);
    assert.equal(byBranch(850).autoNumberId, 1150);
});

test("seri pembelian bertipe SI tidak boleh terpakai untuk faktur penjualan", () => {
    // MSM punya dua seri bertipe SI; yang benar hanya "Faktur Penjualan MSM".
    assert.notEqual(byBranch(1450).autoNumberId, 2000);
});

test("cabang tanpa seri dibiarkan kosong, bukan diberi seri terdekat", () => {
    assert.equal(byBranch(50).autoNumberId, null);
    assert.equal(byBranch(50).autoNumberName, "");
});
