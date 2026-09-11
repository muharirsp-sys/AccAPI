/* Kunci: satu baris yang belum lolos validasi HARUS menjatuhkan seluruh SO-nya (faktur
   separuh isi tidak bisa ditarik dari Accurate), kunci antrean tidak boleh memuat id batch
   (berkas ditarik ulang setiap hari), dan nilai baris yang masuk payload harus sama dengan
   bruto laporan — termasuk saat satu item+satuan muncul dua kali karena baris bonus. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupCandidates, invoiceKey, type BatchLine } from "./principal-invoice.ts";
import { buildInvoicePayload } from "./accurate-invoice-write.ts";

const line = (over: Partial<BatchLine>): BatchLine => ({
    rowNumber: 1, soNo: "SO-1", soDate: "2026-09-11",
    customerNo: "C-001-KN", customerName: "TRUFARM", customerType: "General Trade",
    itemCode: "ITM-1", unit: "KRT", qty: "2", price: "100000",
    discounts: [], status: "ok", ...over,
});

test("kunci antrean = principal + SO, tanpa id batch", () => {
    assert.equal(invoiceKey("KINO NON FOOD", "1671-SOP-260013001"), "KINO-NON-FOOD:1671-SOP-260013001");
    // Batch berbeda, SO sama -> kunci sama -> bentrok di primary key, bukan faktur kedua.
    const a = groupCandidates("KINO NON FOOD", [line({})], { fallbackDate: "2026-09-11" });
    const b = groupCandidates("KINO NON FOOD", [line({ rowNumber: 9 })], { fallbackDate: "2026-09-01" });
    assert.equal(a.candidates[0].key, b.candidates[0].key);
});

test("satu baris review menjatuhkan seluruh SO-nya", () => {
    const { candidates, skipped } = groupCandidates("KINO", [
        line({ rowNumber: 1, soNo: "SO-A" }),
        line({ rowNumber: 2, soNo: "SO-A", status: "review" }),
        line({ rowNumber: 3, soNo: "SO-B" }),
    ], { fallbackDate: "2026-09-11" });
    assert.deepEqual(candidates.map((c) => c.soNo), ["SO-B"]);
    assert.match(skipped[0].reason, /1 dari 2 baris belum lolos/);
});

test("pelanggan tidak tunggal dan tanggal tidak terbaca ditolak, bukan ditebak", () => {
    const campur = groupCandidates("KINO", [
        line({ rowNumber: 1 }), line({ rowNumber: 2, customerNo: "C-002-KN" }),
    ], { fallbackDate: "2026-09-11" });
    assert.equal(campur.candidates.length, 0);
    assert.match(campur.skipped[0].reason, /pelanggan tidak tunggal/);

    const tanpaTanggal = groupCandidates("KINO", [line({ soDate: null })], { fallbackDate: "" });
    assert.equal(tanpaTanggal.candidates.length, 0);
    assert.match(tanpaTanggal.skipped[0].reason, /tanggal SO tidak terbaca/);
});

test("diskon bertingkat, dan nilai baris payload sama dengan bruto laporan", () => {
    const { candidates } = groupCandidates("KINO", [
        // 345.945,95 dipotong 4% lalu 2,25% = 21.310,27 (angka nyata ALFAMART 3 Sep 2026).
        line({ rowNumber: 1, qty: "1", price: "345945.95", discounts: [{ position: 1, percent: 4 }, { position: 4, percent: 2.25 }] }),
        // Item + satuan yang SAMA muncul lagi sebagai baris bonus berdiskon 100%.
        line({ rowNumber: 2, qty: "1", price: "345945.95", discounts: [{ position: 1, percent: 100 }] }),
    ], { fallbackDate: "2026-09-11" });

    const [candidate] = candidates;
    assert.equal(candidate.lineCount, 2);
    assert.equal(candidate.gross, 691891.9);
    assert.equal(candidate.net, 691891.9 - 21310.27 - 345945.95);

    const payload = buildInvoicePayload(candidate.order, {
        unitIds: new Map([["KRT", 100]]),
        branchId: 50, typeAutoNumber: 7,
    });
    assert.equal(payload.detailItem.length, 2);
    assert.equal(payload.taxable, true);
    assert.equal(payload.transDate, "11/09/2026");
    assert.equal(payload.detailItem[0].itemDiscPercent, "4+2.25");
    assert.equal(payload.detailItem[1].itemDiscPercent, "100");
    // Baris bonus tetap berharga penuh; yang membuatnya gratis adalah persennya.
    for (const item of payload.detailItem) {
        assert.equal(item.unitPrice, 345945.95);
        assert.equal(item.itemUnitId, 100);
        assert.equal(item.itemCashDiscount, 0);
    }
});
