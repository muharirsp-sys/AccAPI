/* D-22 (owner 7-8 Okt 2026): fingerprint idempotency sales-receipt = pelanggan + tanggal + faktur + nominal (+ diskon),
 * TIDAK diubah oleh port AM (rumus dipindah utuh dari api-wrapper/page.tsx origin/feat/fiori a9968c45). Uji ini mengunci
 * rumusnya: baris idempotency_log produksi berkunci rumus lama — rumus baru = semua baris lama "tak dikenal". */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSalesReceiptIdempotencyPayload, salesReceiptBaseIdentity } from "./sales-receipt-fingerprint.ts";

const row = {
    customerNo: " C-001 ", transDate: "01/09/2026", paymentMethod: "CASH",
    detailInvoice: [
        { invoiceNo: "INV-B", paymentAmount: 150000.004, detailDiscount: [{ accountNo: "6100", discountNotes: "DISC", amount: 2500 }] },
        { invoiceNo: " INV-A", paymentAmount: "99900" },
    ],
};

test("D-22: rumus fingerprint sales-receipt terkunci (pelanggan + tanggal + faktur + nominal + diskon)", () => {
    const fp = buildSalesReceiptIdempotencyPayload(row);
    assert.equal(fp.key, "PAY_C-001_01/09/2026_INV-A|99900|;INV-B|150000|6100:DISC:2500");
    assert.deepEqual({ invoiceNo: fp.invoiceNo, amount: fp.amount, transDate: fp.transDate }, { invoiceNo: "INV-A,INV-B", amount: 252400, transDate: "01/09/2026" });
    // Urutan faktur tidak mengubah key; nominal & tanggal ikut key (tanpa POSSIBLE_DUPLICATE — D-22).
    assert.equal(buildSalesReceiptIdempotencyPayload({ ...row, detailInvoice: [...row.detailInvoice].reverse() }).key, fp.key);
    assert.notEqual(buildSalesReceiptIdempotencyPayload({ ...row, transDate: "02/09/2026" }).key, fp.key);
    assert.notEqual(buildSalesReceiptIdempotencyPayload({ ...row, detailInvoice: [{ ...row.detailInvoice[0], paymentAmount: 150001 }, row.detailInvoice[1]] }).key, fp.key);
    assert.equal(salesReceiptBaseIdentity(fp), "C-001|01/09/2026|INV-A,INV-B", "identitas dasar (tanpa nominal) untuk koreksi self-heal");
});
