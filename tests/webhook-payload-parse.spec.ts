/*
 * Tujuan: Unit test parser payload webhook Accurate — satu-satunya bagian webhook yang pernah
 *         salah baca bentuk payload (commit e9bb7ec). Tidak butuh server/DB.
 * Caller: npx playwright test tests/webhook-payload-parse.spec.ts
 */
import { test, expect } from "@playwright/test";
import { extractLoggedInvoiceIds, extractLoggedInvoiceIdsSince, flattenSalesInvoiceIds } from "../lib/accurate-webhook";

test("parses the real Accurate envelope shape (array + data array)", () => {
    const live = [
        {
            databaseId: 123,
            type: "SALES_INVOICE",
            timestamp: 1754870000000,
            uuid: "abc",
            data: [
                { salesInvoiceId: 4001, salesInvoiceNo: "SI-1", action: "WRITE" },
                { salesInvoiceId: 4002, salesInvoiceNo: "SI-2", action: "WRITE" },
            ],
        },
    ];
    expect(flattenSalesInvoiceIds(live)).toEqual([4001, 4002]);
});

test("accepts a bare (non-array) envelope", () => {
    expect(flattenSalesInvoiceIds({ type: "SALES_INVOICE", data: [{ salesInvoiceId: 7 }] })).toEqual([7]);
});

test("ignores other modules and malformed ids", () => {
    expect(flattenSalesInvoiceIds([{ type: "ITEM", data: [{ salesInvoiceId: 9 }] }])).toEqual([]);
    expect(
        flattenSalesInvoiceIds([{ type: "SALES_INVOICE", data: [{ salesInvoiceId: 0 }, { salesInvoiceId: "x" }, {}] }]),
    ).toEqual([]);
});

test("never throws on junk payloads", () => {
    for (const junk of [null, undefined, 42, "str", [], {}, [{ type: "SALES_INVOICE" }]]) {
        expect(flattenSalesInvoiceIds(junk)).toEqual([]);
    }
});

test("keeps the old guessed shape unmatched (regression on e9bb7ec)", () => {
    expect(flattenSalesInvoiceIds({ eventType: "WRITE", module: "SALES_INVOICE", id: 55 })).toEqual([]);
});

test("extracts ids from a log with truncated lines", () => {
    // Baris pertama utuh, baris kedua terpotong di tengah (route memotong payload di 100.000 char).
    const log = [
        '{"receivedAt":"2026-08-21T01:04:11.775Z","payload":[{"type":"SALES_INVOICE","data":[{"salesInvoiceId":314414,"salesInvoiceNo":"INV/2608/VI00275"}]}]}',
        '{"receivedAt":"2026-08-21T01:07:00.000Z","payload":[{"type":"SALES_INVOICE","data":[{"salesInvoiceId": 314662,"salesInvoiceNo":"INV/2608/M2006',
    ].join("\n");
    expect(extractLoggedInvoiceIds(log)).toEqual([314414, 314662]);
});

test("dedupes repeated ids and ignores junk", () => {
    expect(extractLoggedInvoiceIds('"salesInvoiceId":7 "salesInvoiceId":7 "salesInvoiceId":0 "salesInvoiceId":"x"')).toEqual([7]);
    expect(extractLoggedInvoiceIds("")).toEqual([]);
});

test("time-bounded extraction skips entries older than the cutoff", () => {
    const log = [
        '{"receivedAt":"2026-08-19T01:00:00.000Z","payload":[{"data":[{"salesInvoiceId":111}]}]}',
        '{"receivedAt":"2026-08-21T01:04:11.775Z","payload":[{"data":[{"salesInvoiceId":314414}]}]}',
        // Baris tanpa receivedAt tetap disertakan: lebih baik mencoba sekali daripada melewatkan.
        '{"payload":[{"data":[{"salesInvoiceId":999}]}]}',
    ].join("\n");
    const cutoff = new Date("2026-08-20T00:00:00.000Z").getTime();
    expect(extractLoggedInvoiceIdsSince(log, cutoff)).toEqual([314414, 999]);
});
