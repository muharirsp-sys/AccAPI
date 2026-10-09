/* Kunci: satu baris yang belum lolos validasi HARUS menjatuhkan seluruh SO-nya (faktur
   separuh isi tidak bisa ditarik dari Accurate), kunci antrean tidak boleh memuat id batch
   (berkas ditarik ulang setiap hari), dan nilai baris yang masuk payload harus sama dengan
   bruto laporan — termasuk saat satu item+satuan muncul dua kali karena baris bonus. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupCandidates, invoiceKey, percentChain, type BatchLine } from "./principal-invoice.ts";
import { buildInvoicePayload } from "./accurate-invoice-write.ts";
import { invoiceLines, recap, type PromoRule } from "./promo-recap.ts";

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
    // Nolnya IKUT: posisi 4 adalah klaim principal, dan "4+2.25" akan membuatnya terbaca
    // sebagai posisi 2 alias tanggungan distributor saat faktur dibaca kembali.
    assert.equal(payload.detailItem[0].itemDiscPercent, "4+0+0+2.25+0");
    assert.equal(payload.detailItem[1].itemDiscPercent, "100+0+0+0+0");
    // Baris bonus tetap berharga penuh; yang membuatnya gratis adalah persennya.
    for (const item of payload.detailItem) {
        assert.equal(item.unitPrice, 345945.95);
        assert.equal(item.itemUnitId, 100);
        assert.equal(item.itemCashDiscount, 0);
    }
});

test("rantai persen mempertahankan POSISI dengan nol, bukan dimampatkan", () => {
    // POSISI menentukan siapa menanggung. Klaim principal di posisi 4 yang dikirim sebagai "3"
    // akan terbaca sebagai posisi 1 — tanggungan distributor — oleh siapa pun yang membaca
    // fakturnya kembali. Terbukti pada INV/2609/KN00450: Rp 28.921 yang bisa ditagihkan ke
    // principal tersimpan sebagai biaya sendiri, tanpa satu pun galat.
    assert.deepEqual(percentChain([{ position: 4, percent: 3 }], 100), ["0", "0", "0", "3", "0"]);
    // SELALU lima slot (permintaan pengguna 2026-09-24): "3.96+3.1+0+0+0", bukan "3.96+3.1".
    assert.deepEqual(percentChain([{ position: 1, percent: 2 }], 100), ["2", "0", "0", "0", "0"]);
    assert.deepEqual(percentChain([{ position: 1, percent: 3.96 }, { position: 2, percent: 3.1 }], 100).join("+"), "3.96+3.1+0+0+0");
    assert.deepEqual(percentChain([{ position: 1, percent: 4 }, { position: 4, percent: 2.25 }], 100),
        ["4", "0", "0", "2.25", "0"]);
    // Baris yang SEMUA potongannya rupiah tidak punya rantai: rupiahnya dikirim apa adanya.
    assert.deepEqual(percentChain([{ position: 5, percent: 1.5, amount: 446.85 }], 29729.73), []);
});

test("rupiah murni (tanpa persen) tetap bentuk lama dan tetap terbaca potongan tingkat faktur", () => {
    // RISKA TK INV/2609/KN00451: potongan MSG Rp 18.018,02 di DISC_5 sebagai RUPIAH, tanpa persen.
    // Bentuk lama ("" + itemCashDiscount) diterima Accurate dan dibaca Rekap Promo sebagai
    // potongan tingkat faktur; dilipat jadi "0+0+0+0+1.5035", klaim principal-nya jadi 0.
    const { candidates } = groupCandidates("KINO", [line({
        soDate: "2026-09-12", customerNo: "C-RIS035-KN", qty: "1", price: "1198378",
        discounts: [{ position: 5, percent: 18018.02 / 1198378 * 100, amount: 18018.02 }],
    })], { fallbackDate: "2026-09-12" });
    const payload = buildInvoicePayload(candidates[0].order, { unitIds: new Map([["KRT", 100]]), branchId: 50, typeAutoNumber: 7 });
    assert.equal(payload.detailItem[0].itemDiscPercent, "");
    assert.equal(payload.detailItem[0].itemCashDiscount, 18018.02);

    const tier: PromoRule = {
        principal: "KINO NON FOOD", suratProgram: "BP2609006016", promoLabel: "MSG", promoGroup: "ALL BRAND HPC",
        itemCode: "", customerCode: "", periodStart: "2026-09-01", periodEnd: "2026-09-30",
        benefitType: "DISC_RP", benefitValue: "20000", benefitUnit: "RP", benefitBeban: "PRINCIPAL",
        tierNo: 1, triggerQty: 1_000_000, triggerUnit: "RP",
    };
    const hasil = recap(invoiceLines({ ...payload, number: "INV/2609/KN00451", id: 1 }), [tier]);
    assert.equal(hasil.principal, 18018.02);
    assert.equal(hasil.unowned, 0);
});

test("persen + rupiah satu baris dikirim sebagai rantai persen saja (INV/2609/KN01376)", () => {
    // TK SUBHAN 30 Sep 2026: DISC_1 2% + DISC_5 Rp 4.933,33 (potongan faktur MSG dibagi rata).
    // Dikirim "2+0+0+0+0" + itemCashDiscount 4.933,33, Accurate membuang rupiahnya.
    const { candidates } = groupCandidates("KINO", [line({
        qty: "24", price: "14414.4144",
        discounts: [{ position: 1, percent: 2 }, { position: 5, percent: 4933.33 / 339027.03 * 100, amount: 4933.33 }],
    })], { fallbackDate: "2026-09-30" });
    const [item] = buildInvoicePayload(candidates[0].order, { unitIds: new Map([["KRT", 100]]), branchId: 50, typeAutoNumber: 7 }).detailItem;
    assert.equal(item.itemDiscPercent, "2+0+0+0+1.4551");
    assert.equal(item.itemCashDiscount, 0);
    assert.equal(candidates[0].net, 334093.7);

    // Batas 4 desimal (yang terbukti disimpan Accurate): baris besar yang melesetnya lewat Rp 1
    // DITAHAN, bukan dikirim dengan netto lain — dan pesannya harus bisa ditindaklanjuti petugas.
    const besar = groupCandidates("KINO", [line({
        qty: "1", price: "50000000",
        discounts: [{ position: 1, percent: 2 }, { position: 5, percent: 712345.67 / 49000000 * 100, amount: 712345.67 }],
    })], { fallbackDate: "2026-09-30" });
    assert.throws(() => buildInvoicePayload(besar.candidates[0].order, { unitIds: new Map([["KRT", 100]]), branchId: 50, typeAutoNumber: 7 }),
        (error: Error) => {
            assert.match(error.message, /Barang ITM-1 \(KRT\)/);
            assert.match(error.message, /netto SO Rp 48287654\.33/);
            assert.match(error.message, /netto hasil persen 2\+0\+0\+0\+1\.4538 Rp 48287638\.00/);
            assert.match(error.message, /selisih Rp 16\.33/);
            assert.match(error.message, /SO ditahan utuh: potongan rupiah baris terlalu besar untuk dipersenkan 4 desimal — buat faktur ini manual di Accurate atau minta perbaikan/);
            return true;
        });
});

