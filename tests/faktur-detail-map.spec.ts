/*
 * Tujuan: Kunci mapper detail faktur ke bentuk payload Accurate yang TERVERIFIKASI LIVE
 *         (2026-08-19, faktur 304428 production) — supaya kolom qty/harga tidak diam-diam
 *         jadi 0 kalau mapper diubah.
 * Caller: npx playwright test tests/faktur-detail-map.spec.ts
 */
import { test, expect } from "@playwright/test";
import { mapFakturDetail, parseAccurateDateTime } from "../lib/accurate-invoice";

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
    primeReceipt: 215364.4,
    primeOwing: 0,
    paymentTerm: { name: "C.O.D" },
    lastPaymentDate: "18/08/2026",
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
        paid: 215364.4,
        owing: 0,
        paymentTerm: "C.O.D",
        lastPaymentDate: "18/08/2026",
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

test("reads the outstanding balance that list.do never provides", () => {
    const d = mapFakturDetail({ totalAmount: 500000, primeReceipt: 200000, primeOwing: 300000 });
    expect(d.owing).toBe(300000);
    expect(d.paid + d.owing).toBe(d.totalAmount);
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

test("parses Accurate lastUpdate as dd/MM/yyyy in UTC+7", () => {
    // Dibuktikan dari webhook_events.log: "19/08/2026 16:07:43" == 2026-08-19T09:07:43Z.
    // Dibandingkan sebagai ISO, bukan komponen lokal — hasilnya tidak boleh bergantung TZ mesin uji.
    expect(parseAccurateDateTime("19/08/2026 16:07:43")!.toISOString()).toBe("2026-08-19T09:07:43.000Z");
    // Kalau dibaca MM/dd, bulan 19 tidak ada dan hasilnya melar ke tahun berikutnya.
    expect(parseAccurateDateTime("01/12/2025 00:00:00")!.toISOString()).toBe("2025-11-30T17:00:00.000Z");
});

test("accepts date without time, ISO fallback, and rejects junk", () => {
    expect(parseAccurateDateTime("01/12/2025")!.toISOString()).toBe("2025-11-30T17:00:00.000Z");
    expect(parseAccurateDateTime("2026-08-19T09:07:46.000Z")!.getUTCFullYear()).toBe(2026);
    for (const junk of ["", "   ", "bukan tanggal", null, undefined, 42]) {
        expect(parseAccurateDateTime(junk)).toBeNull();
    }
});
