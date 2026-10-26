/* Kunci: rumus harga Enigma (Tabel1), retur negatif, filter pemasok Marketama, barang tanpa PRODUK_ID_MI dilaporkan. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { barisEnigma, PEMASOK_MARKETAMA } from "./laporan.ts";

const barang = (no: string, nama: string) => ({ no, name: nama, preferedVendorId: PEMASOK_MARKETAMA, unit1: { name: "BTL" } });
const faktur = {
    number: "INV/2610/M100228", transDate: "05/10/2026", toAddress: "JL A\nMAKASSAR",
    customer: { name: "MISI PASARAYA BARUGA {C-MIS013}" },
    detailItem: [
        // Tabel3 Okt: 168 BTL × 7.472,52 = 1.255.383,36; DISC_RUTIN 36.756,72 × 1,11 ≈ 40.800
        { item: barang("M5013101035030", "ANTIS BTL"), itemUnit: { name: "BTL" }, unitRatio: 1, quantity: 168, unitPrice: 6732, itemCashDiscount: 36756.72,
            tax1Rate: 11, useTax1: true, salesmanName: "MIX1_MT_KARMILA", salesmanList: [{ number: "M-KR" }] },
        { item: barang("M5013101035030", "ANTIS BTL"), itemUnit: { name: "KRT" }, unitRatio: 24, quantity: 2, unitPrice: 161568, itemCashDiscount: 0,
            salesmanName: "MIX1_MT_KARMILA", salesmanList: [{ number: "M-KR" }] },
        { item: { no: "X1", name: "BUKAN MARKETAMA", preferedVendorId: 1 }, itemUnit: { name: "PCS" }, quantity: 5 },
        { item: barang("M5999999999999", "BARANG BARU TANPA KODE MI"), itemUnit: { name: "KLG" }, unitRatio: 1, quantity: 1, salesmanList: [{ number: "M-KR" }] },
    ],
};

test("rumus PRICE_JUAL/BRUTO/NETTO mengikuti Tabel1; KRT pakai harga karton", () => {
    const { baris, lewat, outletBaru, galat } = barisEnigma([faktur], false);
    assert.equal(baris.length, 2);
    const [btl, krt] = baris;
    assert.equal(btl.PRICE_JUAL, 179340.48 / 24);
    assert.ok(Math.abs(Number(btl.VALUE_BRUTO) - 1255383.36) < 0.01);
    assert.ok(Math.abs(Number(btl.DISC_RUTIN) - 36756.72 * 1.11) < 1e-6);
    assert.equal(btl.VALUE_NETTO, Number(btl.VALUE_BRUTO) - Number(btl.DISC_RUTIN));
    assert.equal(btl.QTY_CRT, 7);
    assert.equal(btl.TYPE_OUTLET, "MTI OTHERS"); // C-MIS013 dipetakan MTI OTHERS
    assert.equal(btl.DATE_INVOICE, "2026-10-05");
    assert.equal(krt.UNIT, "KRT");
    assert.equal(krt.PRICE_JUAL, 179340.48);
    assert.equal(krt.QTY_CRT, 2);
    assert.deepEqual([...lewat.keys()], ["M5999999999999"]);
    assert.equal(outletBaru.size, 0);
    assert.equal(galat.size, 0);
});

test("retur: SALES_TYPE RETUR, qty dan nilai negatif; RSJ dan faktur non-INV dibuang; pelanggan baru diberi bawaan", () => {
    const retur = { ...faktur, number: "RJN/2610/M100015", customer: { name: "TOKO BARU {C-BARU01}" }, detailItem: [faktur.detailItem[0]] };
    const { baris, outletBaru } = barisEnigma([retur, { ...retur, number: "RSJ/2610/00001" }], true);
    assert.equal(baris.length, 1);
    assert.equal(baris[0].SALES_TYPE, "RETUR");
    assert.equal(baris[0].QTY, -168);
    assert.ok(Number(baris[0].VALUE_BRUTO) < 0 && Number(baris[0].DISC_RUTIN) < 0 && Number(baris[0].VALUE_NETTO) < 0);
    assert.deepEqual([...outletBaru.keys()], ["C-BARU01"]);
    assert.equal(barisEnigma([{ ...faktur, number: "RJN/2610/M1" }], false).baris.length, 0);
});

test("salesman kosong = galat (Enigma menolak SALESMAN_ID/DESC kosong)", () => {
    const tanpa = { ...faktur, detailItem: [{ ...faktur.detailItem[0], salesmanName: "", salesmanList: [] }] };
    assert.match([...barisEnigma([tanpa], false).galat][0], /salesman kosong/);
});
