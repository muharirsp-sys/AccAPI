/* ringkasFaktur (spec §3.2): satu faktur detail.do -> salesman, qty satuan terkecil, jumlah baris, DPP. Murni. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ringkasFaktur } from "./ringkas-faktur.ts";

const FAKTUR = {
    id: 7, number: "INV/CBA/0001", masterSalesmanId: 4652,
    detailItem: [
        { quantity: 2, unitRatio: 12, quantityDefault: 24, dppAmount: 100000.5 },
        { quantity: 3, unitRatio: 6, dppAmount: "50000.25" }, // tanpa quantityDefault -> cadangan quantity × unitRatio = 18
        { quantity: 5, dppAmount: 0 }, // tanpa unitRatio -> × 1
    ],
};

test("ringkasFaktur: salesman header, Σ quantityDefault (cadangan quantity×unitRatio), jumlah baris, Σ dppAmount", () => {
    assert.deepEqual(ringkasFaktur(FAKTUR), { salesmanId: 4652, qtyTotal: 47, jumlahItem: 3, dpp: 150000.75 });
});

test("ringkasFaktur: raw_data tersimpan sebagai STRING JSON diurai lebih dulu", () => {
    assert.deepEqual(ringkasFaktur(JSON.stringify(FAKTUR)), { salesmanId: 4652, qtyTotal: 47, jumlahItem: 3, dpp: 150000.75 });
});

test("ringkasFaktur: tanpa detailItem (jawaban list.do) / JSON rusak -> semua null", () => {
    const kosong = { salesmanId: null, qtyTotal: null, jumlahItem: null, dpp: null };
    assert.deepEqual(ringkasFaktur({ id: 7, number: "INV/1", masterSalesmanId: 4652 }), kosong);
    assert.deepEqual(ringkasFaktur({ id: 7, detailItem: "bukan larik" }), kosong);
    assert.deepEqual(ringkasFaktur("{rusak"), kosong);
    assert.deepEqual(ringkasFaktur(null), kosong);
});

test("ringkasFaktur: masterSalesmanId absen/nol/bukan angka -> salesmanId null, angka lain tetap", () => {
    for (const id of [undefined, null, 0, "", "abc"]) {
        assert.deepEqual(ringkasFaktur({ masterSalesmanId: id, detailItem: [{ quantityDefault: 1, dppAmount: 10 }] }),
            { salesmanId: null, qtyTotal: 1, jumlahItem: 1, dpp: 10 }, String(id));
    }
    assert.equal(ringkasFaktur({ masterSalesmanId: "4652", detailItem: [] }).salesmanId, 4652, "angka berbentuk teks diterima");
    assert.deepEqual(ringkasFaktur({ masterSalesmanId: 1, detailItem: [] }), { salesmanId: 1, qtyTotal: 0, jumlahItem: 0, dpp: 0 }, "larik kosong = 0, bukan null");
});
