/* Kunci perilaku parser support: header longgar, baris tak berkunci dibuang, nominal utuh. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { generateSupportTemplate, parseLocaleNumber, parseSupportExcel } from "./insentif-sales-excel.ts";

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
