/* Kunci: faktur tidak boleh dibuat dari angka yang tidak beku, satuan tidak boleh ditebak,
   dan timeout tidak boleh dianggap gagal (faktur ganda di Accurate tidak bisa dibatalkan). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInvoicePayload, nextOutboxState, readInvoiceIdentity, sendable, toAccurateDate, type InvoiceOrder } from "./accurate-invoice-write.ts";

const UNITS = new Map([["KRT", 100], ["BAG", 350]]);

const order = (patch: Partial<InvoiceOrder> = {}): InvoiceOrder => ({
    id: "11111111-2222-3333-4444-555555555555",
    customer_no: "C-MUS026-GD",
    outlet: "HJ. MUSTARI, TK",
    channel: "GT",
    order_date: "2026-09-08",
    status: "draft",
    note: "catatan",
    lines: [{ code: "M5012001000740", unit: "KRT", quantity: "2", price: "1144800" }],
    sources: [{ draft_id: "e6c56dac-aaaa", revision: 2 }],
    result: {
        gross: "2289600.00", discount: "228960.00", net: "2060640.00",
        lines: [{ code: "M5012001000740", unit: "KRT", quantity: "2", gross: "2289600.00", net: "2060640.00" }],
    },
    ...patch,
});

test("tanggal tulis Accurate dd/MM/yyyy", () => {
    assert.equal(toAccurateDate("2026-09-08"), "08/09/2026");
    assert.throws(() => toAccurateDate("08-09-2026"));
});

test("payload memakai angka beku dan tidak pernah mengarang nomor faktur", () => {
    const payload = buildInvoicePayload(order(), { unitIds: UNITS, branchId: 150, typeAutoNumber: 1702 });
    assert.equal(payload.customerNo, "C-MUS026-GD");
    assert.equal(payload.transDate, "08/09/2026");
    // Seri penomoran datang dari cabang pelanggan, bukan nilai tetap: penomoran Faktur
    // Penjualan berjalan per cabang, jadi `1` untuk semua faktur = nomor nyasar ke cabang lain.
    assert.equal(payload.typeAutoNumber, 1702);
    assert.ok(!("number" in payload), "nomor faktur harus datang dari Accurate");
    assert.equal(payload.branchId, 150);
    assert.deepEqual(payload.detailItem[0], {
        itemNo: "M5012001000740", quantity: 2, unitPrice: 1144800, itemUnitId: 100,
        // Diskon = bruto - netto dari hasil BEKU, bukan hitung ulang persentase.
        itemCashDiscount: 228960, detailNotes: "order 11111111 baris 1", charField1: order().id,
    });
    // Jejak balik untuk rekonsiliasi status TIDAK PASTI.
    assert.equal(payload.charField1, order().id);
    assert.equal(payload.charField2, "e6c56dacr2");
});

test("menolak, bukan menebak, saat ada yang tidak pasti", () => {
    assert.throws(() => buildInvoicePayload(order({ customer_no: "" }), { unitIds: UNITS, branchId: 150, typeAutoNumber: 1702 }), /pelanggan/);
    assert.throws(() => buildInvoicePayload(order({ result: { pending_price: true } }), { unitIds: UNITS, branchId: 150, typeAutoNumber: 1702 }), /needs_price/);
    assert.throws(() => buildInvoicePayload(order(), { unitIds: new Map(), branchId: 150, typeAutoNumber: 1702 }), /master satuan/);
    // Satuan yang tidak ada di master satuan Accurate: satu item bisa berselisih 72x.
    assert.throws(() => buildInvoicePayload(order({
        lines: [{ code: "X", unit: "LUSIN", quantity: "1", price: "1" }],
        result: { lines: [{ code: "X", unit: "LUSIN", quantity: "1", gross: "1", net: "1" }] },
    }), { unitIds: UNITS, branchId: 150, typeAutoNumber: 1702 }), /master satuan/);
    // Baris hasil yang tidak punya pasangan baris masukan = angka beku tidak konsisten.
    assert.throws(() => buildInvoicePayload(order({
        result: { lines: [{ code: "LAIN", unit: "KRT", quantity: "1", gross: "1", net: "1" }] },
    }), { unitIds: UNITS, branchId: 150, typeAutoNumber: 1702 }), /tidak konsisten/);
    assert.throws(() => buildInvoicePayload(order({ result: { lines: [] } }), { unitIds: UNITS, branchId: 150, typeAutoNumber: 1702 }), /baris hasil/);
});

test("identitas dokumen dibaca dari amplop Accurate", () => {
    assert.deepEqual(readInvoiceIdentity({ s: true, r: { id: 331710, number: "INV/2609/M100412" } }),
        { ok: true, id: "331710", number: "INV/2609/M100412", message: "" });
    const failed = readInvoiceIdentity({ s: false, d: ["Customer tidak ditemukan"] });
    assert.equal(failed.ok, false);
    assert.match(failed.message, /Customer tidak ditemukan/);
});

test("tanpa jawaban dari Accurate statusnya TIDAK PASTI, bukan gagal, dan tidak boleh dikirim lagi", () => {
    assert.equal(nextOutboxState("queued", { kind: "no_answer", message: "timeout" }), "unknown");
    assert.equal(nextOutboxState("sending", { kind: "no_answer", message: "ECONNRESET" }), "unknown");
    // Status TIDAK PASTI bertahan: pengiriman ulang otomatis bisa membuat faktur ganda di
    // Accurate yang tidak bisa dibatalkan dari sini.
    assert.equal(nextOutboxState("unknown", { kind: "posted", id: "1", number: "X" }), "unknown");
    assert.equal(sendable("unknown"), false);
    assert.equal(sendable("posted"), false);
    assert.equal(sendable("sending"), false);

    // Accurate menjawab dan menolak: aman diperbaiki lalu dicoba lagi.
    assert.equal(nextOutboxState("sending", { kind: "rejected", message: "customer suspended" }), "rejected");
    assert.equal(sendable("rejected"), true);
    assert.equal(sendable("queued"), true);
    assert.equal(nextOutboxState("sending", { kind: "posted", id: "331710", number: "INV/1" }), "posted");
    assert.equal(nextOutboxState("posted", { kind: "rejected", message: "apa pun" }), "posted");
});
