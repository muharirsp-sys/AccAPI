/*
 * Tujuan: Kunci mapper detail faktur ke bentuk respons Accurate yang SUDAH diverifikasi live
 *         (faktur 304428, 2026-08-19) — supaya baris item tidak diam-diam jadi 0/kosong kalau
 *         mapper diutak-atik.
 * Caller: npx playwright test tests/faktur-detail-map.spec.ts
 */
import { test, expect } from "@playwright/test";
import { mapFakturDetail } from "../lib/accurate-invoice";

// Potongan respons asli sales-invoice/detail.do (dipangkas ke field yang dipakai mapper).
const LIVE = {
    id: 304428,
    number: "INV/2608/HZ00567",
    transDate: "11/08/2026",
    dueDate: "11/08/2026",
    statusName: "Lunas",
    branchName: "HEINZ",
    masterSalesmanName: "HEINZ2_SITI HALIMATUNSYAHDIAH",
    description: "IN-201882",
    subTotal: 194022.4,
    cashDiscount: 0,
    tax1Amount: 21342,
    totalAmount: 215364.4,
    customer: { customerNo: "C-JUR763-HZ", name: "JURAGAN FROZEN {C-JUR763}" },
    detailItem: [
        {
            detailName: "ABC SAMBAL ASLI 130 ML X 48 BTL",
            quantity: 1,
            itemUnit: { name: "BTL" },
            unitPrice: 5855.9,
            itemCashDiscount: 0,
            totalPrice: 5855.9,
            item: { no: "A1120006013010", name: "ABC SAMBAL ASLI 130 ML X 48 BTL" },
        },
        {
            detailName: "ABC TOMAT PILLOW 1 KG X 6 PCS",
            quantity: 5,
            itemUnit: { name: "PCS" },
            unitPrice: 17278,
            itemCashDiscount: 0,
            totalPrice: 86390,
            item: { no: "A1110001100110", name: "ABC TOMAT PILLOW 1 KG X 6 PCS" },
        },
    ],
};

test("maps the live Accurate response shape", () => {
    const d = mapFakturDetail(LIVE);
    expect(d).toMatchObject({
        number: "INV/2608/HZ00567",
        customerNo: "C-JUR763-HZ",
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

test("item total equals the invoice subtotal (angka baris bukan sekadar ada, tapi konsisten)", () => {
    const d = mapFakturDetail({ ...LIVE, subTotal: 92245.9 });
    const sum = d.items.reduce((acc, it) => acc + it.total, 0);
    expect(sum).toBeCloseTo(d.subTotal, 2);
});

test("kode barang diambil dari item.no, bukan itemNo di level baris", () => {
    // Level baris TIDAK punya itemNo (dibuktikan live) — kalau mapper dibalik ke sana, kolom Kode kosong.
    const d = mapFakturDetail({ detailItem: [{ item: { no: "X1", name: "BARANG X" }, quantity: 2, unitPrice: 10 }] });
    expect(d.items[0].itemNo).toBe("X1");
});

test("falls back to availableItemUnitName when itemUnit is missing", () => {
    const d = mapFakturDetail({ detailItem: [{ availableItemUnitName: "KRT", quantity: 1, item: { no: "Y1" } }] });
    expect(d.items[0].unit).toBe("KRT");
});

test("survives junk without throwing", () => {
    for (const junk of [null, undefined, 42, "x", [], { detailItem: "bukan array" }]) {
        expect(mapFakturDetail(junk).items).toEqual([]);
    }
});

test("zero stays 0 instead of leaking the next fallback", () => {
    const d = mapFakturDetail({ detailItem: [{ quantity: 0, unitPrice: 0, item: { no: "Z1" } }] });
    expect(d.items[0].quantity).toBe(0);
    expect(d.items[0].unitPrice).toBe(0);
});
