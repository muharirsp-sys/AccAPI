/* AM-014 / C.14: bentuk kabel proxy tidak berubah setelah diekstrak; gate purchase-payment tidak
 * bisa dilewati lewat variasi path. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as forward from "./accurate-forward.ts";
import { buildAccurateRequest, isGuardedAccurateWrite, isSalesInvoiceWrite, isSalesReceiptWrite } from "./accurate-forward.ts";

const target = { sessionHost: "https://zeus.accurate.id", sessionId: "SID", accessToken: "TOK" };

test("bulk-save array -> data[i].field; GET -> query dengan koma literal (sama dengan proxy lama)", () => {
    const bulk = buildAccurateRequest(target, "/api/purchase-payment/bulk-save.do", "post",
        [{ bankNo: "1101", detailInvoice: [{ invoiceNo: "INV-1", paymentAmount: 5 }] }]);
    assert.equal(bulk.url, "https://zeus.accurate.id/accurate/api/purchase-payment/bulk-save.do");
    assert.equal(bulk.init.method, "POST");
    assert.deepEqual(JSON.parse(String(bulk.init.body)), {
        "data[0].bankNo": "1101", "data[0].detailInvoice[0].invoiceNo": "INV-1", "data[0].detailInvoice[0].paymentAmount": 5,
    });
    assert.equal((bulk.init.headers as Record<string, string>)["X-Session-ID"], "SID");
    assert.equal(bulk.init.redirect, "manual");

    const get = buildAccurateRequest(target, "/api/item/list.do", "GET", { fields: "id,no", "sp.page": 2, skip: null });
    assert.equal(get.url, "https://zeus.accurate.id/accurate/api/item/list.do?fields=id,no&sp.page=2");
    assert.equal(get.init.body, undefined);

    const single = buildAccurateRequest(target, "/api/sales-invoice/save.do", "POST", { customerNo: "C1" });
    assert.deepEqual(JSON.parse(String(single.init.body)), { customerNo: "C1" });
});

test("gate purchase-payment: variasi path/huruf/encoding tetap ditolak; baca & endpoint lain lolos", () => {
    for (const p of [
        "/api/purchase-payment/bulk-save.do",
        "/api/purchase-payment/save.do",
        "/api/PURCHASE-PAYMENT/Bulk-Save.do",
        "/api/purchase-payment/./bulk-save.do",
        "/api/x/../purchase-payment/bulk-save.do",
        "/api/purchase-payment/%2e/bulk-save.do",
        "/api//purchase-payment//bulk-save.do",
        "/api/purchase%2Dpayment/bulk-save.do",
        "/api/purchase-payment/bulk-save.do/",
        "/api/purchase-payment/bulk-save.do?x=1",
        " /api/purchase-payment/bulk-save.do ",
        "/api/%E0%A4%A/bulk-save.do", // encoding rusak -> fail-closed
        // Review sesi 2 H1: `replace("/api","")` di URL kabel menghapus "/api" PERTAMA di mana pun.
        "/purchase-payment/bulk-save.do/api",
        "/purchase-pay/apiment/bulk-save.do",
        "/purchase-payment/bulk-save.d/apio",
        "/api/purchase-payment/bulk-save.do;jsessionid=x",
        "/api/purchase-payment;v=1/bulk-save.do", // host Java membuang ;param per segmen
        "/api/purchase-payment\\bulk-save.do",
    ]) {
        assert.equal(isGuardedAccurateWrite(p), true, p);
        // Gate dan URL kabel harus sepakat: yang lolos gate tidak boleh tiba di save.do.
    }
    for (const p of ["/api/purchase-payment/list.do", "/api/purchase-payment/detail.do", "/api/sales-receipt/bulk-save.do", "/api/item/list.do"]) {
        assert.equal(isGuardedAccurateWrite(p), false, p);
        const { url } = buildAccurateRequest(target, p, "POST", null);
        assert.doesNotMatch(new URL(url).pathname, /purchase-payment\/(bulk-)?save\.do/i);
    }
});

test("re-review d60433f2 LOW: %5C (backslash ter-encode) & encoding ganda tetap dianggap tulis", () => {
    for (const p of [
        "/api/sales-receipt%5Csave.do",
        "/api/sales-receipt/save%252Edo",
        "/api/sales-receipt%252Fbulk-save.do",
        "/api/purchase-payment%5Cbulk-save.do",
        "/api/purchase-payment/bulk-save%25252Edo",
    ]) {
        assert.equal(p.includes("purchase") ? isGuardedAccurateWrite(p) : isSalesReceiptWrite(p), true, p);
    }
    for (const p of ["/api/sales-receipt/list.do", "/api/sales-receipt/detail.do"]) assert.equal(isSalesReceiptWrite(p), false, p);
});

// S6-0d E4 (owner 9 Okt): faktur penjualan hanya lewat antrean faktur (klaim + riwayat + pencarian);
// proxy generik menolak tulisnya — termasuk bentuk path yang dinormalkan host seperti di purchase-payment.
test("S6-0d E4: tulis sales-invoice (save/bulk-save) dikenali walau path disamarkan; baca tidak", () => {
    for (const p of [
        "/api/sales-invoice/save.do",
        "/api/sales-invoice/bulk-save.do",
        "/api/SALES-INVOICE/SAVE.DO",
        "/api/./sales-invoice/%62ulk-save.do",
        "/api/sales-invoice/../sales-invoice/save.do",
        "//api//sales-invoice//save.do",
        "/api/sales-invoice%5Csave.do",
        "/api/sales-invoice/save%252Edo",
        "/api/sales-invoice/save.do;jsessionid=x",
        "/api/sales-invoice\\bulk-save.do",
    ]) {
        assert.equal(isSalesInvoiceWrite(p), true, p);
    }
    for (const p of ["/api/sales-invoice/list.do", "/api/sales-invoice/detail.do", "/api/sales-receipt/save.do", "/api/sales-order/save.do"]) {
        assert.equal(isSalesInvoiceWrite(p), false, p);
    }
});

// Tinjauan S6-0a LOW: timeout tulis Accurate = status TIDAK PASTI — pesan 504 proxy tidak boleh menyuruh mengulang.
test("pesan 504 proxy: tulis tidak menyuruh coba lagi, baca boleh", () => {
    const msg = (forward as unknown as { accurateTimeoutMessage?: (m: string) => string }).accurateTimeoutMessage;
    assert.equal(typeof msg, "function");
    for (const m of ["POST", "post", "DELETE"]) {
        assert.doesNotMatch(msg!(m), /coba lagi/i, m);
        assert.match(msg!(m), /TIDAK PASTI/);
    }
    assert.match(msg!("GET"), /Coba lagi/);
});
