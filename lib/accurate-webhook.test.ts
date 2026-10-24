/* Kunci: salah id berarti menimpa baris master yang SALAH. Bentuk payload SALES_INVOICE
   terbukti dari log produksi; bentuk CUSTOMER/ITEM belum pernah kita lihat, jadi yang tidak
   dikenali wajib dilewati, bukan ditebak. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLoggedInvoiceIdsSince, flattenCustomerIds, flattenItemIds, flattenSalesInvoiceIds, salesInvoiceEvents } from "./accurate-webhook.ts";

test("envelope faktur dibaca seperti bentuk nyata produksi", () => {
    const payload = [{
        databaseId: 1742775, type: "SALES_INVOICE", uuid: "x",
        data: [{ salesInvoiceId: 331710, salesInvoiceNo: "SI.1", action: "WRITE" },
               { salesInvoiceId: 331711, action: "WRITE" }],
    }];
    assert.deepEqual(flattenSalesInvoiceIds(payload), [331710, 331711]);
    assert.deepEqual(flattenCustomerIds(payload), []);
});

test("pelanggan dan barang dikenali dari kunci ber-Id maupun `id`", () => {
    assert.deepEqual(flattenCustomerIds([{ type: "CUSTOMER", data: [{ customerId: 50123 }] }]), [50123]);
    assert.deepEqual(flattenCustomerIds([{ type: "CUSTOMER", data: [{ id: 50124 }] }]), [50124]);
    assert.deepEqual(flattenItemIds([{ type: "ITEM", data: [{ itemId: 9001 }, { id: 9002 }] }]), [9001, 9002]);
    // Id yang sama dua kali dalam satu envelope cukup diproses sekali.
    assert.deepEqual(flattenItemIds([{ type: "ITEM", data: [{ itemId: 7 }, { itemId: 7 }] }]), [7]);
});

test("yang tidak dikenali DILEWATI, tidak ditebak dari field lain", () => {
    // Hanya nomor dokumen yang ada, bukan id pelanggan -> jangan dipakai sebagai id.
    assert.deepEqual(flattenCustomerIds([{ type: "CUSTOMER", data: [{ customerNo: "C-001" }] }]), []);
    assert.deepEqual(flattenCustomerIds([{ type: "SALES_INVOICE", data: [{ customerId: 5 }] }]), []);
    assert.deepEqual(flattenItemIds([{ type: "ITEM", data: [{ itemId: 0 }, { itemId: -3 }, { itemId: "abc" }] }]), []);
    assert.deepEqual(flattenItemIds(null), []);
    assert.deepEqual(flattenItemIds({ type: "ITEM" }), []);
});

test("penambal log melewati faktur yang aksi terakhirnya DELETE, dan jendela waktunya dihormati", () => {
    // Bentuk baris nyata webhook_events.log (produksi, September 2026).
    const baris = (at: string, id: number, action: string) => JSON.stringify({ receivedAt: at, payload: [{ type: "SALES_INVOICE",
        data: [{ salesInvoiceId: id, salesInvoiceNo: `INV/2609/KN${id}`, isDownPayment: false, action }] }] });
    const log = [
        baris("2026-09-25T01:00:00.000Z", 1, "WRITE"),
        baris("2026-09-25T01:00:00.000Z", 2, "WRITE"),
        baris("2026-09-25T02:00:00.000Z", 2, "DELETE"),
        // Dua objek dalam satu event: aksi tiap objek miliknya sendiri, tidak dipinjam tetangganya.
        JSON.stringify({ receivedAt: "2026-09-25T03:00:00.000Z", payload: [{ type: "SALES_INVOICE",
            data: [{ salesInvoiceId: 3, action: "DELETE" }, { salesInvoiceId: 4, action: "WRITE" }] }] }),
        baris("2026-09-20T00:00:00.000Z", 5, "WRITE"),
        // Terpotong di 100.000 karakter: tanpa aksi, tetap dicoba.
        '{"receivedAt":"2026-09-25T04:00:00.000Z","payload":[{"data":[{"salesInvoiceId":6,"salesInv',
    ].join("\n");
    assert.deepEqual(extractLoggedInvoiceIdsSince(log, Date.parse("2026-09-24T00:00:00.000Z")).sort(), [1, 4, 6]);
});

test("event faktur membawa appKey dan jam simpan amplopnya (timestamp = WIB)", () => {
    // Bentuk amplop nyata produksi: appKey hanya ada bila disimpan aplikasi; timestamp "dd/MM/yyyy HH:mm:ss" WIB
    // (receivedAt 05:58:34Z <-> timestamp 12:58:34, spec 2026-10-23 §2).
    const payload = [
        { type: "SALES_INVOICE", timestamp: "17/10/2026 12:58:34", data: [{ salesInvoiceId: 101, action: "WRITE" }] },
        { type: "SALES_INVOICE", timestamp: "22/10/2026 13:49:06", appKey: "APP-A",
          data: [{ salesInvoiceId: 102, action: "WRITE" }, { salesInvoiceId: 103, action: "DELETE" }] },
        { type: "CUSTOMER", data: [{ customerId: 5 }] },
    ];
    assert.deepEqual(salesInvoiceEvents(payload).map((e) => [e.id, e.action, e.appKey, e.savedAt?.toISOString()]), [
        [101, "WRITE", "", "2026-10-17T05:58:34.000Z"],
        [102, "WRITE", "APP-A", "2026-10-22T06:49:06.000Z"],
        [103, "DELETE", "APP-A", "2026-10-22T06:49:06.000Z"],
    ]);
    // Tanpa timestamp/action: savedAt null, action WRITE. Id tidak sah dilewati.
    assert.deepEqual(salesInvoiceEvents([{ type: "SALES_INVOICE", data: [{ salesInvoiceId: 7 }, { salesInvoiceId: "x" }] }])
        .map((e) => [e.id, e.action, e.savedAt]), [[7, "WRITE", null]]);
    assert.deepEqual(flattenSalesInvoiceIds(payload), [101, 102, 103]);
    assert.deepEqual(salesInvoiceEvents(null), []);
});
