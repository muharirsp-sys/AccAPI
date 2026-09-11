/* Kunci: rekap ini menentukan berapa uang yang ditagihkan ke principal dan berapa yang
   ditanggung sendiri. Dua angka tidak boleh pernah "nol karena tidak dihitung": diskon
   tak bertuan (posisi 6+) dan klaim principal tanpa aturan terbit. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { invoiceLines, isoDate, recap, ruleFor, type PromoRule } from "./promo-recap.ts";

const aturan = (over: Partial<PromoRule> = {}): PromoRule => ({
    principal: "KINO NON FOOD", suratProgram: "BP2609007909", promoLabel: "MTI - HPC CONSUMER PROMO ON PO",
    promoGroup: "ELLIPS HAIR MIST", itemCode: "K1010001006010",
    periodStart: "2026-09-01", periodEnd: "2026-09-30",
    benefitType: "DISC_PCT", benefitValue: "3", benefitUnit: "%", onFaktur: false, ...over,
});

const faktur = {
    id: 331710, number: "SI.2026.09.0001", transDate: "11/09/2026",
    customer: { customerNo: "C-TRU001-KN" },
    detailItem: [
        // Distributor 4% lalu klaim principal 3% — persis bentuk rantai persen Accurate.
        { itemNo: "K1010001006010", item: { name: "KNF ELLIPS HAIR MIST 100ML" },
          quantity: 10, unitPrice: 100000, itemDiscPercent: "4+0+0+3", itemCashDiscount: 0 },
        // Tanpa diskon sama sekali.
        { itemNo: "K9999999999999", item: { name: "BARANG LAIN" },
          quantity: 2, unitPrice: 50000, itemDiscPercent: "", itemCashDiscount: 0 },
    ],
};

test("tanggal Accurate dd/MM/yyyy dibaca jadi ISO, bukan dipotong begitu saja", () => {
    assert.equal(isoDate("11/09/2026"), "2026-09-11");
    assert.equal(isoDate("2026-09-11"), "2026-09-11");
});

test("baris faktur dibongkar dari raw_data webhook, posisi persen dipertahankan", () => {
    const lines = invoiceLines(faktur);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].transDate, "2026-09-11");
    assert.equal(lines[0].customerNo, "C-TRU001-KN");
    assert.equal(lines[0].gross, 1000000);
    // "4+0+0+3": nol dibuang, tetapi POSISI tidak boleh bergeser — 3% harus tetap posisi 4,
    // karena posisi 4 berarti klaim principal sedangkan posisi 2 berarti tanggungan distributor.
    assert.deepEqual(lines[0].discounts, [{ position: 1, percent: 4 }, { position: 4, percent: 3 }]);
});

test("aturan hanya berlaku bila barang cocok DAN tanggal di dalam periode", () => {
    const line = invoiceLines(faktur)[0];
    assert.ok(ruleFor(line, [aturan()]));
    assert.equal(ruleFor(line, [aturan({ periodStart: "2026-10-01", periodEnd: "2026-10-31" })]), null);
    assert.equal(ruleFor(line, [aturan({ itemCode: "LAIN" })]), null);
});

test("diskon tak bertuan dan klaim tanpa aturan DIHITUNG, bukan dianggap nol", () => {
    const nakal = {
        ...faktur,
        detailItem: [
            // Posisi 6 = tak bertuan.
            { itemNo: "K1010001006010", item: { name: "X" }, quantity: 1, unitPrice: 100000,
              itemDiscPercent: "0+0+0+0+0+5", itemCashDiscount: 0 },
            // Posisi 4 (klaim principal) untuk barang yang tidak punya aturan terbit.
            { itemNo: "TANPA-ATURAN", item: { name: "Y" }, quantity: 1, unitPrice: 200000,
              itemDiscPercent: "0+0+0+2", itemCashDiscount: 0 },
        ],
    };
    const hasil = recap(invoiceLines(nakal), [aturan()]);
    assert.equal(hasil.unowned, 5000);
    assert.equal(hasil.unownedLines.length, 1);
    assert.equal(hasil.principalWithoutRule, 4000);
    assert.equal(hasil.unexplained[0].itemCode, "TANPA-ATURAN");
    assert.equal(hasil.programs.length, 0);
});

test("rekap per program, dan persen yang menyimpang dari mekanisme dilaporkan", () => {
    const hasil = recap(invoiceLines(faktur), [aturan()]);
    assert.equal(hasil.invoices, 1);
    assert.equal(hasil.gross, 1100000);
    // 4% atas 1.000.000 = 40.000 (distributor), lalu 3% atas sisanya = 28.800 (principal).
    assert.equal(hasil.distributor, 40000);
    assert.equal(hasil.principal, 28800);
    assert.equal(hasil.unowned, 0);
    assert.equal(hasil.principalWithoutRule, 0);
    assert.equal(hasil.programs[0].promoGroup, "ELLIPS HAIR MIST");
    assert.equal(hasil.programs[0].principalAmount, 28800);
    assert.deepEqual(hasil.programs[0].mismatched, []);

    // Surat bilang 3%, faktur memberi 5% -> harus ketahuan.
    const beda = recap(invoiceLines(faktur), [aturan({ benefitValue: "5" })]);
    assert.equal(beda.programs[0].mismatched.length, 1);
    assert.deepEqual(beda.programs[0].mismatched[0], {
        invoiceNo: "SI.2026.09.0001", itemCode: "K1010001006010", expected: 5, actual: 3,
    });
});
