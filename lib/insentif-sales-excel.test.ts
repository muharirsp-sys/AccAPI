/* Kunci perilaku parser support: header longgar, baris tak berkunci dibuang, nominal utuh. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { angkaSel, generateSupportTemplate, parseLocaleNumber, parseSupportExcel, parseTargetExcel } from "./insentif-sales-excel.ts";

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
        ["M-E", "-", "KINO", "   "], // spasi saja = kosong, bukan invalid (review AM-017)
        ["M-F", "-", "KINO", " - "], // "-" = tanda nol akuntansi = 0 (owner 9 Okt, sama dengan Python)
    ]), "sales");
    assert.ok(Number.isNaN(rows[0].supportAmount), `NOT-A-NUMBER -> ${rows[0].supportAmount}`);
    // Satu aturan dengan parse_number_strict Python (owner 9 Okt): ",-" = rupiah tanpa sen, bukan invalid.
    assert.equal(rows[1].supportAmount, 500000, `Rp 500.000,- -> ${rows[1].supportAmount}`);
    assert.equal(rows[2].supportAmount, 0);
    assert.equal(rows[3].supportAmount, 0);
    assert.equal(rows[4].supportAmount, 0, `spasi -> ${rows[4].supportAmount}`);
    assert.equal(rows[5].supportAmount, 0, `"-" -> ${rows[5].supportAmount}`);

    const [target] = parseTargetExcel(sheetBuffer([
        ["Kode Salesman", "Nama Salesman", "Principal", "Cabang", "Target Value (Rp)", "Target EC"],
        ["M-A", "A", "KINO", "BDG", "satu juta", 12],
    ]));
    assert.ok(Number.isNaN(target.targetValue as number), `target invalid -> ${target.targetValue}`);
    assert.equal(target.targetEc, 12);
});

/*
 * S6-0c perbaikan 4: SATU aturan angka sel untuk target, support, dan progres — cermin parse_number_strict Python
 * (amplop _STRICT_NUMBER, batas 40 karakter, "-" = 0). Pemisah ribuan hanya bila kepala kelompoknya 1-3 digit tanpa nol depan.
 */
const ANGKA_SAH: Array<[unknown, number]> = [
    [undefined, 0], [null, 0], ["", 0], ["   ", 0], ["-", 0], [" - ", 0], [0, 0], [1250000, 1250000], [204.8, 204.8],
    ["1.250.000", 1250000], ["1,250,000", 1250000], ["1.234,56", 1234.56], ["1,234.56", 1234.56], ["1.234.567,89", 1234567.89],
    ["1,234,567.89", 1234567.89], ["1.250", 1250], ["1,250", 1250], ["204,8", 204.8], ["1,5", 1.5], ["1.5", 1.5],
    ["-533.000.000", -533000000], ["-250,5", -250.5], ["Rp 1.250.000,-", 1250000], ["Rp.5000", 5000], ["IDR 250,000.00", 250000],
    ["Rp-1.000", -1000], ["1 250 000", 1250000], ["500000", 500000],
    // (d) kepala kelompok ribuan 1-3 digit: selain itu pemisah tunggal = desimal.
    ["250000000.000", 250000000], ["533000000,50", 533000000.5], ["0.125", 0.125], ["0,125", 0.125], ["1250000,000", 1250000],
];
const ANGKA_TOLAK: unknown[] = [
    "abc", "N/A", "#N/A", "5 juta", "12abc", "(500)", "(533.000.000)", "\u22125", "--5", "-Rp-5", "1e5", "Rp", "1.2.3,4.5",
    "12.34.567", "1２3", "1" + "0".repeat(40), "-" + " ".repeat(800) + "x", true, new Date(2026, 8, 5), Number.POSITIVE_INFINITY,
];

test("aturan angka sel: tabel kasus sah (cermin parse_number_strict Python)", () => {
    for (const [v, harus] of ANGKA_SAH) assert.equal(angkaSel(v), harus, `angkaSel(${JSON.stringify(v)})`);
    assert.equal(parseLocaleNumber("Rp 83.977.857"), 83977857);
});

test("aturan angka sel: teks campuran, kurung, minus Unicode, galat → NaN (tidak jadi angka diam-diam)", () => {
    const t0 = performance.now();
    for (const v of ANGKA_TOLAK) assert.ok(Number.isNaN(angkaSel(v)), `angkaSel(${String(v).slice(0, 20)}) = ${angkaSel(v)}, harus NaN`);
    assert.ok(performance.now() - t0 < 50, "teks panjang tidak boleh lambat (ReDoS)");
});

test("sel galat Excel (#DIV/0!, #N/A) di kolom angka ditolak; di kolom teks tetap kosong; nol akuntansi tetap 0", () => {
    const ws = XLSX.utils.aoa_to_sheet([
        ["Kode Salesman", "Nama Salesman", "Principal", "Cabang", "Target Value (Rp)", "Target EC", "Target AO"],
        ["M-A", "A", "KINO", "BDG", 1000, 12, 0],
        ["M-B", "B", "KINO", "BDG", 1000, 12, 5],
    ]);
    ws["E2"] = { t: "e", v: 0x07, w: "#DIV/0!" };      // Target Value M-A = #DIV/0!
    ws["B3"] = { t: "e", v: 0x2a, w: "#N/A" };          // Nama M-B = #N/A (kolom teks)
    ws["G2"] = { t: "n", v: 0, z: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)' }; // nol berformat akuntansi (tampil "-")
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "T");
    const [a, b] = parseTargetExcel(toArrayBuffer(XLSX.write(wb, { bookType: "xlsx", type: "array" }) as Uint8Array));
    assert.ok(Number.isNaN(a.targetValue as number), `#DIV/0! -> ${a.targetValue}`);
    assert.equal(a.targetAo, 0);
    assert.equal(b.salesName, "");
    assert.equal(b.targetValue, 1000);

    const sup = XLSX.utils.aoa_to_sheet([["Kode Salesman", "Nama", "Principal", "Support (Rp)"], ["M-A", "", "KINO", 1]]);
    sup["D2"] = { t: "e", v: 0x2a, w: "#N/A" };
    const wb2 = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb2, sup, "S");
    const [s] = parseSupportExcel(toArrayBuffer(XLSX.write(wb2, { bookType: "xlsx", type: "array" }) as Uint8Array), "sales");
    assert.ok(Number.isNaN(s.supportAmount), `support #N/A -> ${s.supportAmount}`);
});
