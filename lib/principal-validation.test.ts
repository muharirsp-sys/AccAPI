/* Kunci: setiap temuan di sini berakhir sebagai angka pada faktur, jadi tidak ada yang
   "cuma warning". Toleransi Rp 1 hanya menyerap pembulatan, bukan selisih aturan. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLine, splitDiscounts, type LineInput } from "./principal-validation.ts";

const line = (over: Partial<LineInput> = {}): LineInput => ({
    productCode: "106052", itemCode: "K1010001006010", itemExists: true,
    customerCode: "16710223162", customerNo: "C-GAL006-KN", customerExists: true,
    salesmanCode: "1671GR4102", salesmanInternal: "M-SIT",
    unit: "BTL", knownUnits: ["BTL", "KRT"],
    price: 13513.51, expectedPrice: 13513.51,
    gross: 324324.32, reportDiscount: 0, discounts: [], bonus: false,
    hasPublishedRules: false, ...over,
});

test("diskon bertingkat cocok dengan angka nyata Kino", () => {
    // ALFAMART 3 Sep 2026: DISC_1 4% lalu DISC_4 2,25% atas Rp 345.945,95.
    const split = splitDiscounts(345945.95, [{ position: 1, percent: 4 }, { position: 4, percent: 2.25 }]);
    assert.deepEqual(split, { distributor: 13837.84, principal: 7472.43, unowned: 0, total: 21310.27 });
    // Dijumlah rata 6,25% akan meleset dari TOTAL_DISC yang dilaporkan.
    assert.notEqual(splitDiscounts(345945.95, [{ position: 1, percent: 6.25 }]).total, 21310.27);
    // Urutan masukan tidak boleh mengubah hasil; posisi yang menentukan.
    assert.deepEqual(splitDiscounts(345945.95, [{ position: 4, percent: 2.25 }, { position: 1, percent: 4 }]).total, 21310.27);
});

test("posisi di luar 1-5 jadi diskon tak bertuan", () => {
    const split = splitDiscounts(100000, [{ position: 7, percent: 5 }]);
    assert.equal(split.unowned, 5000);
    assert.equal(split.distributor + split.principal, 0);
});

test("baris lengkap dan cocok lolos tanpa temuan", () => {
    const result = checkLine(line());
    assert.equal(result.status, "ok", result.findings.join(" | "));
});

test("selisih harga sampai Rp 1 lolos, di atas itu ditahan dua arah", () => {
    assert.equal(checkLine(line({ price: 13514.51 })).status, "ok");
    assert.equal(checkLine(line({ price: 13512.51 })).status, "ok");
    const tinggi = checkLine(line({ price: 13600 }));
    assert.equal(tinggi.status, "review");
    assert.match(tinggi.findings[0], /lebih tinggi/);
    assert.match(checkLine(line({ price: 13000 })).findings[0], /lebih rendah/);
});

test("mapping dan master yang hilang ditahan, masing-masing dengan sebabnya", () => {
    assert.match(checkLine(line({ itemCode: null })).findings[0], /belum ada di mapping/);
    assert.match(checkLine(line({ itemExists: false })).findings[0], /tidak ada di master Accurate/);
    assert.match(checkLine(line({ customerNo: null })).findings[0], /outlet .* belum ada di mapping/);
    assert.match(checkLine(line({ customerExists: false })).findings[0], /tidak ada di master Accurate/);
    assert.match(checkLine(line({ salesmanInternal: null })).findings[0], /salesman .* belum ada di mapping/);
    assert.match(checkLine(line({ expectedPrice: null })).findings[0], /Harga Accurate .* tidak ditemukan/);
    assert.match(checkLine(line({ unit: "LSN" })).findings[0], /Satuan LSN tidak ada pada daftar harga/);
});

test("klaim principal tanpa aturan terbit dan diskon tak bertuan ditahan", () => {
    const tanpaAturan = checkLine(line({ discounts: [{ position: 4, percent: 2.25 }], reportDiscount: 7297.3 }));
    assert.equal(tanpaAturan.status, "review");
    assert.match(tanpaAturan.findings.join(" "), /belum punya aturan promo terbit/);
    // Begitu aturannya terbit, klaim yang sama tidak lagi ditahan karena alasan itu.
    const adaAturan = checkLine(line({ discounts: [{ position: 4, percent: 2.25 }], reportDiscount: 7297.3, hasPublishedRules: true }));
    assert.equal(adaAturan.findings.filter((f) => f.includes("aturan promo terbit")).length, 0);

    const liar = checkLine(line({ discounts: [{ position: 7, percent: 5 }], reportDiscount: 16216.22 }));
    assert.match(liar.findings.join(" "), /tak bertuan .* DISC_7/);
});

test("total diskon kami harus sama dengan laporan principal", () => {
    const beda = checkLine(line({ discounts: [{ position: 1, percent: 4 }], reportDiscount: 0 }));
    assert.match(beda.findings.join(" "), /berbeda dari laporan principal/);
    const sama = checkLine(line({ discounts: [{ position: 1, percent: 4 }], reportDiscount: 12972.97 }));
    assert.equal(sama.findings.filter((f) => f.includes("berbeda dari laporan")).length, 0, sama.findings.join(" | "));
});

test("baris bonus tetap diperiksa harganya", () => {
    const bonus = checkLine(line({ bonus: true, price: 99999, discounts: [{ position: 1, percent: 100 }], reportDiscount: 324324.32 }));
    assert.equal(bonus.status, "review");
    assert.match(bonus.findings.join(" "), /Harga laporan/);
});
