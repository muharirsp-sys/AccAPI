/* Pembanding rincian faktur (spec docs/superpowers/specs/2026-10-23-perubahan-rincian-faktur-design.md §6-7).
   Data contoh generik; bentuk mengikuti detail.do nyata (INV/2610/CS00399: baris 72 -> 6 PCS, id baris tetap). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKFILL, deletedInvoiceLines, diffInvoiceLines, parsePrintedView, parseRaw, type ChangeContext } from "./sales-invoice-change.ts";

const brs = (id: number | null, no: string, qty: number, o: Record<string, unknown> = {}) => ({
    id, item: { no, name: `NAMA ${no}` }, quantity: qty, itemUnit: { name: "PCS" }, unitRatio: 1, unitPrice: 4610,
    itemDiscPercent: "2", itemCashDiscount: 0, totalPrice: qty * 4610 * 0.98, warehouse: { name: "GUDANG A" },
    deliveredQuantity: 0, returnQuantity: 0, salesmanList: [{ id: 1 }], ...o,
});
const faktur = (rinci: unknown[], o: Record<string, unknown> = {}) => ({
    id: 900, number: "INV/2610/AA00001", transDate: "17/10/2026", customer: { customerNo: "C-A01-AA" }, totalAmount: 1000,
    printedTimeView: "17 Oct 2026 15:23:23", printUserName: "FAKTURIS A", detailItem: rinci, ...o,
});
// raw_data di cache = string JSON (kolom jsonb berisi string), jadi isi lama diberikan sebagai JSON.stringify(...).
const lama = (f: unknown) => JSON.stringify(f);
const WEBHOOK: ChangeContext = { source: "webhook", appKey: "", savedAt: new Date("2026-10-22T06:49:06Z") };
const KINI = new Date("2026-10-22T06:49:07Z");

test("qty berubah 72 -> 6 pada id baris yang sama: satu 'changed', delta dasar -66, sesudah cetak", () => {
    const r = diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 72), brs(12, "BARANG B", 3)])),
        faktur([brs(11, "BARANG A", 6), brs(12, "BARANG B", 3)], { totalAmount: 900 }), WEBHOOK, KINI);
    assert.equal(r.length, 1);
    assert.deepEqual([r[0].kind, r[0].lineId, r[0].itemNo, r[0].itemName, r[0].oldLine?.qty, r[0].newLine?.qty, r[0].baseQtyDelta],
        ["changed", 11, "BARANG A", "NAMA BARANG A", 72, 6, -66]);
    assert.deepEqual([r[0].totalBefore, r[0].totalAfter, r[0].appKey, r[0].source, r[0].savedAt?.toISOString()],
        [1000, 900, "", "webhook", "2026-10-22T06:49:06.000Z"]);
    assert.equal(r[0].printedAt?.toISOString(), "2026-10-17T08:23:23.000Z");
    assert.deepEqual([r[0].printedBy, r[0].afterPrint, r[0].invoiceId, r[0].invoiceNumber, r[0].transDate, r[0].customerNo],
        ["FAKTURIS A", true, 900, "INV/2610/AA00001", "17/10/2026", "C-A01-AA"]);
    assert.equal(r[0].detectedAt, KINI);
});

test("baris hilang dan baris baru tercatat terpisah", () => {
    const r = diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 6), brs(12, "BARANG B", 3)])),
        faktur([brs(11, "BARANG A", 6), brs(13, "BARANG C", 2)]), WEBHOOK, KINI);
    assert.deepEqual(r.map((x) => [x.kind, x.itemNo, x.baseQtyDelta]), [["removed", "BARANG B", -3], ["added", "BARANG C", 2]]);
    assert.equal(r[0].newLine, null);
    assert.equal(r[1].oldLine, null);
});

test("barang diganti pada id baris yang sama = removed barang lama + added barang baru", () => {
    const r = diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 6)])), faktur([brs(11, "BARANG B", 6)]), WEBHOOK, KINI);
    assert.deepEqual(r.map((x) => [x.kind, x.itemNo, x.lineId]), [["removed", "BARANG A", 11], ["added", "BARANG B", 11]]);
});

test("satuan KRT -> PCS dengan qty dasar sama: 'changed', delta 0", () => {
    const r = diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 2, { itemUnit: { name: "KRT" }, unitRatio: 36, unitPrice: 165960 })])),
        faktur([brs(11, "BARANG A", 72)]), WEBHOOK, KINI);
    assert.deepEqual(r.map((x) => [x.kind, x.oldLine?.unit, x.newLine?.unit, x.baseQtyDelta]), [["changed", "KRT", "PCS", 0]]);
});

test("hanya qty kirim/retur, salesman, atau totalPrice yang berubah: tidak ada baris", () => {
    const r = diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 6)])),
        faktur([brs(11, "BARANG A", 6, { deliveredQuantity: 6, returnQuantity: 1, salesmanList: [{ id: 2 }], totalPrice: 1 })]), WEBHOOK, KINI);
    assert.deepEqual(r, []);
});

test("isi lama tanpa detailItem, cache kosong, JSON rusak, DFT, atau RJN: tidak ada baris", () => {
    const baru = faktur([brs(11, "BARANG A", 6)]);
    assert.deepEqual(diffInvoiceLines(lama({ ...faktur([]), detailItem: undefined }), baru, WEBHOOK, KINI), []);
    assert.deepEqual(diffInvoiceLines(null, baru, WEBHOOK, KINI), []);
    assert.deepEqual(diffInvoiceLines("bukan json", baru, WEBHOOK, KINI), []);
    for (const number of ["DFT.1001", "RJN/2610/AA00001"]) {
        assert.deepEqual(diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 72)], { number })),
            faktur([brs(11, "BARANG A", 6)], { number }), WEBHOOK, KINI), [], number);
    }
});

test("sesudah cetak: belum dicetak -> false; dicetak sesudah simpan -> false; penambal memakai jam deteksi", () => {
    const isiLama = lama(faktur([brs(11, "BARANG A", 72)]));
    const [belum] = diffInvoiceLines(isiLama, faktur([brs(11, "BARANG A", 6)], { printedTimeView: null, printUserName: "Belum cetak/email" }), WEBHOOK, KINI);
    assert.deepEqual([belum.printedAt, belum.printedBy, belum.afterPrint], [null, "", false]);
    // Dicetak 22 Okt 14:00 WIB = 07:00Z, sesudah simpan 06:49Z.
    const [nanti] = diffInvoiceLines(isiLama, faktur([brs(11, "BARANG A", 6)], { printedTimeView: "22 Oct 2026 14:00:00" }), WEBHOOK, KINI);
    assert.equal(nanti.afterPrint, false);
    const [tambal] = diffInvoiceLines(isiLama, faktur([brs(11, "BARANG A", 6)]), BACKFILL, KINI);
    assert.deepEqual([tambal.source, tambal.appKey, tambal.savedAt, tambal.afterPrint], ["backfill", null, null, true]);
});

test("faktur dihapus: semua baris terakhir jadi invoice_deleted dengan delta negatif", () => {
    const r = deletedInvoiceLines(lama(faktur([brs(11, "BARANG A", 6), brs(12, "BARANG B", 2, { itemUnit: { name: "KRT" }, unitRatio: 12 })])),
        { source: "webhook", appKey: "", savedAt: KINI }, KINI);
    assert.deepEqual(r.map((x) => [x.kind, x.itemNo, x.baseQtyDelta, x.newLine, x.totalBefore, x.totalAfter]),
        [["invoice_deleted", "BARANG A", -6, null, 1000, null], ["invoice_deleted", "BARANG B", -24, null, 1000, null]]);
    assert.deepEqual(deletedInvoiceLines(lama(faktur([brs(11, "BARANG A", 6)], { number: "DFT.9" })), BACKFILL, KINI), []);
    assert.deepEqual(deletedInvoiceLines(null, BACKFILL, KINI), []);
});

test("rasio satuan tidak ada: delta dasar null, perubahan tetap tercatat", () => {
    const r = diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 6, { unitRatio: null })])),
        faktur([brs(11, "BARANG A", 5, { unitRatio: null })]), WEBHOOK, KINI);
    assert.deepEqual(r.map((x) => [x.kind, x.baseQtyDelta]), [["changed", null]]);
});

test("baris tanpa id tidak berpasangan: removed + added walau isinya sama", () => {
    const r = diffInvoiceLines(lama(faktur([brs(null, "BARANG A", 6)])), faktur([brs(null, "BARANG A", 6)]), WEBHOOK, KINI);
    assert.deepEqual(r.map((x) => [x.kind, x.lineId]), [["removed", null], ["added", null]]);
});

test("parseRaw menerima string sekali/dua kali dienkode dan objek; parsePrintedView = WIB", () => {
    const f = { number: "INV/1" };
    assert.deepEqual(parseRaw(JSON.stringify(f)), f);
    assert.deepEqual(parseRaw(JSON.stringify(JSON.stringify(f))), f);
    assert.deepEqual(parseRaw(f), f);
    assert.equal(parseRaw("[1]"), null);
    assert.equal(parsePrintedView("17 Oct 2026 15:23:23")?.toISOString(), "2026-10-17T08:23:23.000Z");
    assert.equal(parsePrintedView("17 Okt 2026 15:23:23")?.toISOString(), "2026-10-17T08:23:23.000Z");
    assert.equal(parsePrintedView("Belum cetak/email"), null);
    assert.equal(parsePrintedView(undefined), null);
});

// ---- Perketatan hasil tinjauan (Task 2) ----

test("tiap kolom pembanding yang berubah sendirian = tepat satu 'changed'", () => {
    const kasus: [string, Record<string, unknown>][] = [
        ["satuan", { itemUnit: { name: "KRT" } }],
        ["rasio", { unitRatio: 2 }],
        ["harga", { unitPrice: 4700 }],
        ["diskon persen", { itemDiscPercent: "3" }],
        ["diskon rupiah", { itemCashDiscount: 500 }],
        ["gudang", { warehouse: { name: "GUDANG B" } }],
    ];
    for (const [nama, ubah] of kasus) {
        const r = diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 6)])), faktur([brs(11, "BARANG A", 6, ubah)]), WEBHOOK, KINI);
        assert.deepEqual(r.map((x) => x.kind), ["changed"], nama);
    }
});

test("derau pecahan pada harga (4610.0000000001) bukan perubahan", () => {
    const r = diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 6)])), faktur([brs(11, "BARANG A", 6, { unitPrice: 4610.0000000001 })]), WEBHOOK, KINI);
    assert.deepEqual(r, []);
});

test("dicetak tepat pada detik simpan = sesudah cetak (batas inklusif)", () => {
    // 22 Oct 2026 13:49:06 WIB = 06:49:06Z = savedAt WEBHOOK.
    const [r] = diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 72)])),
        faktur([brs(11, "BARANG A", 6)], { printedTimeView: "22 Oct 2026 13:49:06" }), WEBHOOK, KINI);
    assert.equal(r.printedAt?.toISOString(), "2026-10-22T06:49:06.000Z");
    assert.equal(r.afterPrint, true);
});

test("rasio satuan 0 dianggap tidak ada: delta dasar null", () => {
    const r = diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 6, { unitRatio: 0 })])),
        faktur([brs(11, "BARANG A", 5, { unitRatio: 0 })]), WEBHOOK, KINI);
    assert.deepEqual(r.map((x) => [x.kind, x.oldLine?.ratio, x.newLine?.ratio, x.baseQtyDelta]), [["changed", null, null, null]]);
});

test("draf (DFT) yang baru terbit jadi INV: nomor LAMA bukan INV -> tidak ada baris", () => {
    const r = diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 72)], { number: "DFT.1001" })),
        faktur([brs(11, "BARANG A", 6)], { number: "INV/2610/AA00001" }), WEBHOOK, KINI);
    assert.deepEqual(r, []);
});

test("parsePrintedView: bulan 3-4 huruf (Sept), Agt, jam 1 digit; detik tetap wajib", () => {
    assert.equal(parsePrintedView("17 Sept 2026 15:23:23")?.toISOString(), "2026-09-17T08:23:23.000Z");
    assert.equal(parsePrintedView("17 Agt 2026 15:23:23")?.toISOString(), "2026-08-17T08:23:23.000Z");
    assert.equal(parsePrintedView("7 Oct 2026 5:23:23")?.toISOString(), "2026-10-06T22:23:23.000Z");
    assert.equal(parsePrintedView("17 Oct 2026 15:23"), null);
});

test("printedTimeView tak terbaca: printedAt null tapi printedBy tetap terisi (kegagalan tampak), afterPrint false", () => {
    const isiLama = lama(faktur([brs(11, "BARANG A", 72)]));
    const [rusak] = diffInvoiceLines(isiLama, faktur([brs(11, "BARANG A", 6)], { printedTimeView: "rusak", printUserName: "FAKTURIS A" }), WEBHOOK, KINI);
    assert.deepEqual([rusak.printedAt, rusak.printedBy, rusak.afterPrint], [null, "FAKTURIS A", false]);
    // Penanda "belum cetak" tidak dianggap nama pencetak, huruf besar/kecil tidak berpengaruh.
    const [belum] = diffInvoiceLines(isiLama, faktur([brs(11, "BARANG A", 6)], { printedTimeView: null, printUserName: "BELUM CETAK/email" }), WEBHOOK, KINI);
    assert.deepEqual([belum.printedAt, belum.printedBy, belum.afterPrint], [null, "", false]);
});

test("kunci baris kembar (id + kode barang sama): tidak ada baris lama yang hilang diam-diam", () => {
    const r = diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 5), brs(11, "BARANG A", 7)])),
        faktur([brs(11, "BARANG A", 7)]), WEBHOOK, KINI);
    // Baris lama pertama berpasangan dengan baris baru (5 -> 7); yang kembar (qty 7) tidak berpasangan -> removed.
    assert.deepEqual(r.map((x) => [x.kind, x.oldLine?.qty, x.newLine?.qty]), [["changed", 5, 7], ["removed", 7, undefined]]);
    // Jumlah selisih dasar = qty baru (7) - total qty lama (12) = -5: tidak ada qty yang lolos dari catatan.
    assert.equal(r.reduce((s, x) => s + (x.baseQtyDelta ?? 0), 0), -5);
});

test("diskon persen kosong, '0', '0.0', 0 = nilai kosong yang sama", () => {
    for (const baru of ["0", "0.0", 0, ""]) {
        assert.deepEqual(diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 6, { itemDiscPercent: "" })])),
            faktur([brs(11, "BARANG A", 6, { itemDiscPercent: baru })]), WEBHOOK, KINI), [], String(baru));
        assert.deepEqual(diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 6, { itemDiscPercent: baru })])),
            faktur([brs(11, "BARANG A", 6, { itemDiscPercent: "" })]), WEBHOOK, KINI), [], `balik ${String(baru)}`);
    }
});

test("id faktur 0/hilang, newRow null, entri bukan objek di detailItem: tidak melempar dan tidak ada baris palsu", () => {
    const isiLama = lama(faktur([brs(11, "BARANG A", 72)]));
    assert.deepEqual(diffInvoiceLines(isiLama, faktur([brs(11, "BARANG A", 6)], { id: 0 }), WEBHOOK, KINI), []);
    assert.deepEqual(diffInvoiceLines(isiLama, faktur([brs(11, "BARANG A", 6)], { id: undefined }), WEBHOOK, KINI), []);
    assert.deepEqual(deletedInvoiceLines(lama(faktur([brs(11, "BARANG A", 6)], { id: 0 })), BACKFILL, KINI), []);
    assert.deepEqual(diffInvoiceLines(isiLama, null as never, WEBHOOK, KINI), []);
    assert.deepEqual(diffInvoiceLines(isiLama, undefined as never, WEBHOOK, KINI), []);
    const r = diffInvoiceLines(lama(faktur([null, brs(11, "BARANG A", 72), "x", 5])), faktur([brs(11, "BARANG A", 6), null]), WEBHOOK, KINI);
    assert.deepEqual(r.map((x) => [x.kind, x.lineId, x.itemNo]), [["changed", 11, "BARANG A"]]);
    const h = deletedInvoiceLines(lama(faktur([null, brs(11, "BARANG A", 6)])), BACKFILL, KINI);
    assert.deepEqual(h.map((x) => [x.kind, x.itemNo]), [["invoice_deleted", "BARANG A"]]);
});
