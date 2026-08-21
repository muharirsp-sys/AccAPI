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

// ponytail: regex global, BUKAN JSON.parse per baris. Alasannya bukan kemalasan — route webhook
// memotong payload jumbo di 100.000 karakter, jadi sebagian baris memang JSON tidak lengkap dan
// JSON.parse akan membuangnya utuh. Regex tetap menemukan id di baris terpotong.
// Ceiling: seluruh isi log dibaca ke memori; kalau nanti melewati beberapa ratus MB, ganti ke
// pembacaan per baris (readline).
export function extractLoggedInvoiceIds(logText: string): number[] {
    const ids = new Set<number>();
    for (const m of logText.matchAll(/"salesInvoiceId":\s*(\d+)/g)) {
        const id = Number(m[1]);
        if (Number.isFinite(id) && id > 0) ids.add(id);
    }
    return [...ids];
}
