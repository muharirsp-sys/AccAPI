/* Kunci: salah id berarti menimpa baris master yang SALAH. Bentuk payload SALES_INVOICE
   terbukti dari log produksi; bentuk CUSTOMER/ITEM belum pernah kita lihat, jadi yang tidak
   dikenali wajib dilewati, bukan ditebak. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenCustomerIds, flattenItemIds, flattenSalesInvoiceIds } from "./accurate-webhook.ts";

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
