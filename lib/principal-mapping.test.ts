/* Kunci: judul kolom berkas principal tidak stabil, dan baris yang tidak lengkap harus
   DILAPORKAN. Mapping barang tanpa ISI tidak boleh lolos: aturan satuan yang berjalan
   menaikkan baris ke KRT hanya bila QTY habis dibagi ISI, jadi ISI yang hilang = salah 36x. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { columnOf, packOf, parseMappingRows } from "./principal-mapping.ts";

test("kolom dicari lewat judul, bukan indeks tetap", () => {
    const header = ["KODE ITEM", "Kode Alias", "Satuan", "ISI"];
    assert.equal(columnOf(header, ["kode alias"]), 1);
    assert.equal(columnOf(header, ["isi", "isi/ctn"]), 3);
    // Urutan kolom boleh berubah tanpa merusak apa pun.
    assert.equal(columnOf(["ISI", "Satuan", "Kode Alias", "KODE ITEM"], ["kode item"]), 3);
    assert.equal(columnOf(header, ["tidak ada"]), -1);
});

test("ISI dibaca dari angka maupun teks bergaya Indonesia", () => {
    assert.equal(packOf(36), 36);
    assert.equal(packOf("36"), 36);
    assert.equal(packOf("1.152"), 1152);
    assert.equal(packOf("12,5"), 12.5);
    for (const kosong of ["", "  ", "-", null, undefined, 0, -5]) assert.equal(packOf(kosong), null, String(kosong));
});

test("barang: kode, satuan, dan ISI ikut; tanpa ISI baris dibuang dan dilaporkan", () => {
    const { rows, issues } = parseMappingRows("item", [
        ["FORM MAPPING", "", "", ""],
        ["KODE ITEM", "Kode Alias", "Satuan", "ISI"],
        ["K1111009005010B", "106072", "btl", "36"],
        ["K1141002011010", "106029", "BTL", ""],
        ["", "", "", ""],
    ]);
    assert.deepEqual(rows, [{ kind: "item", sourceCode: "106072", targetCode: "K1111009005010B", unit: "BTL", packSize: 36 }]);
    assert.match(issues.join(" "), /106029.*ISI/);
});

test("pelanggan dan salesman tidak butuh satuan", () => {
    const pelanggan = parseMappingRows("customer", [["Code Kino", "Code Internal"], ["2191200122844", "C-100001"]]);
    assert.deepEqual(pelanggan.rows, [{ kind: "customer", sourceCode: "2191200122844", targetCode: "C-100001", unit: null, packSize: null }]);
    assert.deepEqual(pelanggan.issues, []);

    const sales = parseMappingRows("salesman", [["SLSMAN_ID", "Code Internal"], ["1671GR4102", "M-SIT"]]);
    assert.equal(sales.rows[0].targetCode, "M-SIT");
});

test("baris setengah jadi dan kode ganda dilaporkan, bukan didiamkan", () => {
    const { rows, issues } = parseMappingRows("customer", [
        ["Code Kino", "Code Internal"],
        ["111", "C-A001"],
        ["222", ""],
        ["", "C-B002"],
        ["111", "C-C003"],
    ]);
    // Kode ganda: yang terakhir menang, tetapi wajib muncul sebagai temuan.
    assert.deepEqual(rows, [{ kind: "customer", sourceCode: "111", targetCode: "C-C003", unit: null, packSize: null }]);
    assert.equal(issues.length, 3, issues.join(" | "));
    assert.match(issues.join(" "), /muncul lagi/);
});

test("judul yang tidak ketemu ditolak, bukan menghasilkan nol baris diam-diam", () => {
    const { rows, issues } = parseMappingRows("customer", [["Kolom A", "Kolom B"], ["1", "2"]]);
    assert.equal(rows.length, 0);
    assert.match(issues[0], /tidak menemukan kolom/);
});
