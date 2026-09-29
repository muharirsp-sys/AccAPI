/* AM-014 / C.14: bentuk kabel proxy tidak berubah setelah diekstrak; gate purchase-payment tidak
 * bisa dilewati lewat variasi path. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAccurateRequest, isGuardedAccurateWrite } from "./accurate-forward.ts";

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
