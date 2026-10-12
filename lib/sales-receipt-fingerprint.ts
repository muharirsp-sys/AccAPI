/**
 * Tujuan: SATU rumus fingerprint idempotency sales-receipt, dipakai browser (API Wrapper) dan server
 *   (lock + guard proxy AM-024) — dulu hanya di halaman, sehingga server tidak bisa memeriksanya.
 * Caller: app/(dashboard)/api-wrapper/page.tsx, app/api/proxy/route.ts (lib/sales-receipt-guard.ts).
 * Main Functions: buildSalesReceiptIdempotencyPayload (dipindah utuh dari halaman), salesReceiptBaseIdentity.
 * Side Effects: tidak ada (murni).
 */
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- baris Excel bebas bentuk

export const buildSalesReceiptIdempotencyPayload = (row: Row) => {
    const normalizeMoney = (value: unknown) => Number((Number(value) || 0).toFixed(2));
    const detailSignature = (row.detailInvoice || [])
        .map((detail: Row) => {
            const discountSignature = (detail.detailDiscount || [])
                .map((discount: Row) => [
                    String(discount.accountNo || "").trim(),
                    String(discount.discountNotes || "").trim(),
                    normalizeMoney(discount.amount),
                ].join(":"))
                .sort()
                .join("&");
            return [
                String(detail.invoiceNo || "").trim(),
                normalizeMoney(detail.paymentAmount),
                discountSignature,
            ].join("|");
        })
        .sort()
        .join(";");

    const invoices = (row.detailInvoice || [])
        .map((detail: Row) => String(detail.invoiceNo || "").trim())
        .filter(Boolean)
        .sort()
        .join(",");

    const appliedAmount = Number(
        (row.detailInvoice || []).reduce((sum: number, detail: Row) => {
            const discountTotal = (detail.detailDiscount || []).reduce((discountSum: number, discount: Row) => discountSum + normalizeMoney(discount.amount), 0);
            return sum + normalizeMoney(detail.paymentAmount) + discountTotal;
        }, 0).toFixed(2),
    );

    return {
        key: `PAY_${String(row.customerNo || "").trim()}_${String(row.transDate || "").trim()}_${detailSignature}`,
        invoiceNo: invoices,
        customerNo: row.customerNo,
        amount: appliedAmount,
        transDate: String(row.transDate || "").trim(),
        paymentMethod: row.paymentMethod,
        source: "Excel Upload",
    };
};

/**
 * Identitas dasar = pelanggan + tanggal + himpunan faktur, TANPA nominal: kiriman koreksi self-heal
 * mengubah nominal (fingerprint berubah) tetapi tetap baris yang sama dari upload yang terkunci.
 * Bentuk yang sama dihitung dari baris payload maupun dari kolom idempotency_log.
 */
export const salesReceiptBaseIdentity = (r: { customerNo?: unknown; transDate?: unknown; invoiceNo?: unknown }) =>
    [String(r.customerNo ?? "").trim(), String(r.transDate ?? "").trim(), String(r.invoiceNo ?? "").trim()].join("|");
