/*
 * Tujuan: Kunci mapper detail faktur ke bentuk payload Accurate yang TERVERIFIKASI LIVE
 *         (2026-08-19, faktur 304428 production) — supaya kolom qty/harga tidak diam-diam
 *         jadi 0 kalau mapper diubah.
 * Caller: npx playwright test tests/faktur-detail-map.spec.ts
 */
import { test, expect } from "@playwright/test";
import { mapFakturDetail } from "../lib/accurate-invoice";

// Potongan respons detail.do asli (field yang tidak dipakai mapper dibuang agar tetap terbaca).
const LIVE_SAMPLE = {
    id: 304428,
    number: "INV/2608/HZ00567",
    transDate: "11/08/2026",
    dueDate: "11/08/2026",
    statusName: "Lunas",
    description: "IN-201882",
    branchName: "HEINZ",
    masterSalesmanName: "HEINZ2_SITI HALIMATUNSYAHDIAH",
    subTotal: 194022.4,
    cashDiscount: 0,
    tax1Amount: 21342,
    totalAmount: 215364.4,
    customer: { customerNo: "C-JUR763-HZ", name: "JURAGAN FROZEN {C-JUR763}" },
    detailItem: [
        {
            itemNo: "A1120006013010",
            detailName: "ABC SAMBAL ASLI 130 ML X 48 BTL",
            quantity: 1,
            itemUnit: { name: "BTL" },
            unitPrice: 5855.9,
            itemCashDiscount: 0,
            totalPrice: 5855.9,
        },
        {
            itemNo: "A1110001100110",
            detailName: "ABC TOMAT PILLOW 1 KG X 6 PCS",
            quantity: 5,
            itemUnit: { name: "PCS" },
            unitPrice: 17278,
            itemCashDiscount: 0,
            totalPrice: 86390,
        },
    ],
};

test("maps the live Accurate payload", () => {
    const d = mapFakturDetail(LIVE_SAMPLE);
    expect(d).toMatchObject({
        id: 304428,
        number: "INV/2608/HZ00567",
        customerNo: "C-JUR763-HZ",
        customerName: "JURAGAN FROZEN {C-JUR763}",
        branchName: "HEINZ",
        salesName: "HEINZ2_SITI HALIMATUNSYAHDIAH",
        status: "Lunas",
        subTotal: 194022.4,
        tax: 21342,
        totalAmount: 215364.4,
    });
    expect(d.items).toHaveLength(2);
    expect(d.items[1]).toEqual({
        itemNo: "A1110001100110",
        itemName: "ABC TOMAT PILLOW 1 KG X 6 PCS",
        quantity: 5,
        unit: "PCS",
        unitPrice: 17278,
        discount: 0,
        total: 86390,
    });
});

test("header totals add up the way the page shows them", () => {
    const d = mapFakturDetail(LIVE_SAMPLE);
    expect(d.subTotal + d.tax - d.totalDiscount).toBeCloseTo(d.totalAmount, 2);
});

test("falls back to salesman.name when the header has no masterSalesmanName", () => {
    const d = mapFakturDetail({ salesman: { name: "HEINZ10_LILIS KARLINA" } });
    expect(d.salesName).toBe("HEINZ10_LILIS KARLINA");
});

test("survives junk without throwing", () => {
    for (const junk of [null, undefined, 42, "x", [], { detailItem: "bukan array" }]) {
        expect(mapFakturDetail(junk).items).toEqual([]);
    }
});
