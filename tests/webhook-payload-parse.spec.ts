/*
 * Tujuan: Unit test parser payload webhook Accurate — satu-satunya bagian webhook yang pernah
 *         salah baca bentuk payload (commit e9bb7ec). Tidak butuh server/DB.
 * Caller: npx playwright test tests/webhook-payload-parse.spec.ts
 */
import { test, expect } from "@playwright/test";
import { flattenSalesInvoiceIds } from "../lib/accurate-webhook";

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
