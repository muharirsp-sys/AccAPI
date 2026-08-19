/*
 * Tujuan: Parsing payload webhook Accurate (dipisah dari route supaya bisa diuji tanpa server).
 * Caller: app/api/webhook/accurate/route.ts, tests/webhook-payload-parse.spec.ts.
 */

// Bentuk payload dibuktikan live 2026-08-11 (webhook_events.log production): array envelope
// { databaseId, type: "SALES_INVOICE", timestamp, uuid, data: [{ salesInvoiceId, salesInvoiceNo,
// isDownPayment, salesInvoiceTotalAmount, action: "WRITE" }] } — BUKAN { eventType, module, id }
// seperti tebakan awal. `data` adalah array (bisa >1 baris per envelope).
export function flattenSalesInvoiceIds(payload: unknown): number[] {
    const envelopes = (Array.isArray(payload) ? payload : [payload]) as Array<{
        type?: string;
        data?: Array<{ salesInvoiceId?: unknown }>;
    }>;
    const ids: number[] = [];
    for (const envelope of envelopes) {
        if (envelope?.type !== "SALES_INVOICE") continue;
        for (const record of envelope?.data ?? []) {
            const id = Number(record?.salesInvoiceId);
            if (Number.isFinite(id) && id > 0) ids.push(id);
        }
    }
    return ids;
}
