/* Kunci: tanggal Excel tidak boleh meleset satu hari. Regresi nyata, lihat excel-date.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { excelDateToIso } from "./excel-date";

test("23:59:35 hari sebelumnya (bentuk keluaran SheetJS) naik ke hari yang benar", () => {
    // Persis yang dikembalikan SheetJS untuk nota INV/2607/SZ00036 = 3 Juli 2026 di Excel.
    assert.equal(excelDateToIso(new Date(2026, 6, 2, 23, 59, 35)), "2026-07-03");
    // Pergantian bulan: 31 Juli 23:59:35 harus jadi 1 Agustus, bukan tetap 31 Juli.
    assert.equal(excelDateToIso(new Date(2026, 6, 31, 23, 59, 35)), "2026-08-01");
});

test("tengah malam tepat tidak bergeser", () => {
    assert.equal(excelDateToIso(new Date(2026, 6, 3, 0, 0, 0)), "2026-07-03");
    assert.equal(excelDateToIso(new Date(2026, 0, 1, 0, 0, 0)), "2026-01-01");
});

test("siang hari membulat ke harinya sendiri, bukan ke besok", () => {
    assert.equal(excelDateToIso(new Date(2026, 6, 3, 11, 30, 0)), "2026-07-03");
    // Tepat lewat tengah hari masih hari yang sama sampai 12:00; ini batas pembulatannya.
    assert.equal(excelDateToIso(new Date(2026, 6, 3, 11, 59, 59)), "2026-07-03");
});

test("masukan tak terbaca dilaporkan null, bukan ditebak", () => {
    assert.equal(excelDateToIso(""), null);
    assert.equal(excelDateToIso(null), null);
    assert.equal(excelDateToIso("bukan tanggal"), null);
});

test("jam kerja sungguhan tidak ikut dinaikkan ke hari berikutnya", () => {
    // Pembulatan ke hari terdekat akan menjawab "2026-07-04" untuk dua kasus pertama.
    assert.equal(excelDateToIso(new Date(2026, 6, 3, 13, 0, 0)), "2026-07-03");
    assert.equal(excelDateToIso(new Date(2026, 6, 3, 23, 0, 0)), "2026-07-03");
    assert.equal(excelDateToIso(new Date(2026, 6, 3, 23, 54, 0)), "2026-07-03");
});
