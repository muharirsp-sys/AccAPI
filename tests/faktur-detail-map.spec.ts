/*
 * Tujuan: Kunci perilaku mapper detail faktur — terutama bahwa baris item tidak diam-diam
 *         jadi 0/kosong saat nama field Accurate berbeda dari tebakan utama.
 * Caller: npx playwright test tests/faktur-detail-map.spec.ts
 */
import { test, expect } from "@playwright/test";
import { mapFakturDetail } from "../lib/accurate-invoice";

test("maps header + items from the primary field names", () => {
    const d = mapFakturDetail({
        id: 304428,
        number: "INV/2608/HZ00567",
        transDate: "19/08/2026",
        statusName: "Lunas",
        totalAmount: 215364.4,
        customer: { customerNo: "C-JUR763", name: "JURAGAN FROZEN" },
        detailItem: [
            { itemNo: "A01", detailName: "SUSU 1L", quantity: 3, itemUnit: { name: "PCS" }, unitPrice: 50000, totalPrice: 150000 },
        ],
    });
    expect(d.number).toBe("INV/2608/HZ00567");
    expect(d.customerName).toBe("JURAGAN FROZEN");
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({ itemNo: "A01", itemName: "SUSU 1L", quantity: 3, unit: "PCS", unitPrice: 50000, total: 150000 });
});

test("falls back to alias field names (qty/price/total/item.name)", () => {
    const d = mapFakturDetail({
        no: "INV/X", customerName: "TOKO A",
        detail: [{ no: "B02", item: { name: "TEH KOTAK" }, qty: 2, unitName: "DUS", price: 12000, total: 24000 }],
    });
    expect(d.number).toBe("INV/X");
    expect(d.items[0]).toMatchObject({ itemNo: "B02", itemName: "TEH KOTAK", quantity: 2, unit: "DUS", unitPrice: 12000, total: 24000 });
});

test("survives junk without throwing", () => {
    for (const junk of [null, undefined, 42, "x", [], { detailItem: "bukan array" }]) {
        expect(mapFakturDetail(junk).items).toEqual([]);
    }
});

test("zero-value fields stay 0 instead of leaking the next alias", () => {
    const d = mapFakturDetail({ detailItem: [{ quantity: 0, qty: 99, unitPrice: 0, price: 77 }] });
    expect(d.items[0].quantity).toBe(0);
    expect(d.items[0].unitPrice).toBe(0);
});
