/* Kunci perilaku parser support: header longgar, baris tak berkunci dibuang, nominal utuh. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { generateSupportTemplate, parseLocaleNumber, parseSupportExcel, parseTargetExcel } from "./insentif-sales-excel.ts";

// XLSX.write({type:"array"}) mengembalikan ArrayBuffer, meski tipenya di repo ini di-cast
// sebagai Uint8Array. Terima dua-duanya supaya test menguji parser, bukan cast itu.
function toArrayBuffer(data: Uint8Array | ArrayBuffer): ArrayBuffer {
    return data instanceof ArrayBuffer
        ? data
        : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
}

test("template support bolak-balik: yang diunduh terbaca utuh", () => {
    const buf = generateSupportTemplate("sales", [
        { key: "M-FS", label: "KN3_FAISAL SYAM", principle: "KINO INDONESIA. TBK, PT", supportAmount: 500000 },
        { key: "M-DW", label: "KN2_DINA WAHYUNI", principle: "KINO INDONESIA. TBK, PT", supportAmount: 0 },
    ]);
    assert.deepEqual(parseSupportExcel(toArrayBuffer(buf), "sales"), [
        { key: "M-FS", principle: "KINO INDONESIA. TBK, PT", supportAmount: 500000 },
        { key: "M-DW", principle: "KINO INDONESIA. TBK, PT", supportAmount: 0 },
    ]);
});

test("header berspasi/beda huruf tetap terbaca, baris tanpa kunci dibuang", () => {
    // Excel nyata menyimpan header terformat (" Support (Rp) ") — pencocokan string persis
    // akan membaca SELURUH kolom sebagai 0, yaitu mencabut semua support tanpa peringatan.
    const ws = XLSX.utils.aoa_to_sheet([
        [" nama spv ", "Nama", " PRINCIPAL", " Support (Rp) "],
        ["YARMAN", "-", "KINO INDONESIA. TBK, PT", "1.250.000"],
        ["", "-", "KINO INDONESIA. TBK, PT", 999],       // tanpa kunci -> dibuang
        ["SUMARTONO", "-", "", 999],                      // tanpa principal -> dibuang
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S");
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as Uint8Array;

    assert.deepEqual(parseSupportExcel(toArrayBuffer(buf), "spv"), [
        { key: "YARMAN", principle: "KINO INDONESIA. TBK, PT", supportAmount: 1250000 },
    ]);
});

test("angka teks berformat Indonesia", () => {
    // Kolom yang di Excel tersimpan sebagai TEKS. Versi lama mengembalikan 0 untuk semuanya.
    assert.equal(parseLocaleNumber("1.250.000"), 1250000);
    assert.equal(parseLocaleNumber("Rp 83.977.857"), 83977857);
    assert.equal(parseLocaleNumber("204,8"), 204.8);
    assert.equal(parseLocaleNumber("1.234,56"), 1234.56);
    assert.equal(parseLocaleNumber("1,234.56"), 1234.56); // gaya Inggris tetap benar
    assert.equal(parseLocaleNumber("1.250"), 1250);       // konvensi Indonesia: ribuan
    assert.equal(parseLocaleNumber("500000"), 500000);
    assert.equal(parseLocaleNumber("-250,5"), -250.5);
    assert.ok(Number.isNaN(parseLocaleNumber("abc")));
});

function sheetBuffer(rows: unknown[][]): ArrayBuffer {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "S");
    return toArrayBuffer(XLSX.write(wb, { bookType: "xlsx", type: "array" }) as Uint8Array);
}

test("sel terisi tapi bukan angka TIDAK menjadi 0 (AM-017)", () => {
    // 0 palsu pada support = pool insentif tidak terpotong = orang dibayar lebih. Guard pemanggil
    // (Number.isFinite di halaman) hanya bekerja bila parser meneruskan NaN.
    const rows = parseSupportExcel(sheetBuffer([
        ["Kode Salesman", "Nama", "Principal", "Support (Rp)"],
        ["M-A", "-", "KINO", "NOT-A-NUMBER"],
        ["M-B", "-", "KINO", "Rp 500.000,-"],
        ["M-C", "-", "KINO", ""],   // kosong = 0 (kebijakan blank yang sudah ada)
        ["M-D", "-", "KINO", "0"],  // nol sah
    ]), "sales");
    assert.ok(Number.isNaN(rows[0].supportAmount), `NOT-A-NUMBER -> ${rows[0].supportAmount}`);
    assert.ok(Number.isNaN(rows[1].supportAmount), `Rp 500.000,- -> ${rows[1].supportAmount}`);
    assert.equal(rows[2].supportAmount, 0);
    assert.equal(rows[3].supportAmount, 0);

    const [target] = parseTargetExcel(sheetBuffer([
        ["Kode Salesman", "Nama Salesman", "Principal", "Cabang", "Target Value (Rp)", "Target EC"],
        ["M-A", "A", "KINO", "BDG", "satu juta", 12],
    ]));
    assert.ok(Number.isNaN(target.targetValue as number), `target invalid -> ${target.targetValue}`);
    assert.equal(target.targetEc, 12);
});
