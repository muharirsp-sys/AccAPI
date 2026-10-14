import assert from "node:assert/strict";
import test from "node:test";
import { fakturKeHistory } from "./accurate";

// Potongan nyata INV/2605/HZ00075 (produksi) — nilai harapan = baris berkas closing Mei 2026 untuk faktur yang sama.
const faktur = {
    number: "INV/2605/HZ00075", transDate: "02/05/2026", branchName: "HEINZ", description: "IN-186062",
    customer: { name: "ANNISA, TK {C-ANN028}", customerNo: "C-ANN028-HZ", npwpNo: "" },
    detailItem: [
        { item: { no: "X-SAMPAH", name: "BARANG LAIN" }, quantity: 1, itemUnit: { name: "PCS" }, unitPrice: 10, grossAmount: 10, itemCashDiscount: 0, dppAmount: 10, tax1Amount: 1.1 },
        { item: { no: "A1011000060010", name: "ABC KECAP MANIS 600 GR X 12 PCH" }, quantity: 5, itemUnit: { name: "KRT" }, unitPrice: 205875.6,
          itemDiscPercent: "0+10+0", itemCashDiscount: 102937.8, grossAmount: 1029378, salesAmount: 926440.2, dppAmount: 926440.2, tax1Amount: 101908.422 },
    ],
};
const principal = (kode: string) => ({ "X-SAMPAH": "Toko Aswan", A1011000060010: "HEINZ ABC INDONESIA, PT" } as Record<string, string>)[kode] ?? "";

test("faktur Accurate dipetakan sama dengan baris berkas closing", () => {
    const h = fakturKeHistory(JSON.stringify(faktur), principal, new Set(["HEINZ ABC INDONESIA, PT"]));
    assert.ok(h);
    assert.equal(h.kodeCust, "C-ANN028");
    assert.equal(h.tanggal, "2026-05-02");
    assert.equal(h.principal, "HEINZ ABC INDONESIA, PT"); // charField1 sampah di baris pertama tidak menang
    const b = h.items[1];
    assert.deepEqual([b.qty, b.satuan, b.hargaSatuan, b.hargaTotal, b.diskonRp, b.dpp, b.ppn, b.keterangan],
        [5, "KRT", 205875.6, 1029378, 102937.8, 926440.2, 101908.422, "IN-186062"]);
});

test("ADNA SENTRAL NIAGA disatukan ke GUMINDO BOGAMANIS; tanpa rincian = null", () => {
    const h = fakturKeHistory(faktur, () => "ADNA SENTRAL NIAGA, PT", new Set());
    assert.equal(h?.principal, "GUMINDO BOGAMANIS, PT");
    assert.equal(fakturKeHistory({ ...faktur, detailItem: undefined }, principal, new Set()), null);
    assert.equal(fakturKeHistory({ ...faktur, number: "SR/2605/1" }, principal, new Set()), null);
});
