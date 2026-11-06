import { test } from "node:test";
import assert from "node:assert/strict";
import { alasanTaxDokumen, perluTax, sidikPajak, tahapTax, type ItemPajak } from "./tax";

const item = (id: string, ppnRate = 0, pphRate = 0, dpp = 1_000_000): ItemPajak =>
    ({ id, dpp, ppnRate, ppnAmount: Math.round((dpp * ppnRate) / 100), pphRate, pphAmount: Math.round((dpp * pphRate) / 100) });
const draf = (taxStatus: string | null = null, taxSidik: string | null = null) => ({ status: "Draft", taxStatus, taxSidik });

test("klaim tanpa PPN/PPh tidak perlu Tax; satu item ber-PPN atau ber-PPh sudah perlu", () => {
    assert.equal(perluTax([item("a"), item("b")]), false);
    assert.equal(perluTax([item("a"), item("b", 11)]), true);
    assert.equal(perluTax([item("a", 0, 2)]), true);
    assert.equal(tahapTax(draf(), [item("a")]), "tidak_perlu");
    assert.equal(alasanTaxDokumen(draf(), [item("a")]), "");
});

test("sidik tidak bergantung urutan item, tetapi berubah bila nilai pajak satu item berubah", () => {
    const awal = [item("a", 11), item("b", 0, 2)];
    assert.equal(sidikPajak(awal), sidikPajak([...awal].reverse()));
    assert.notEqual(sidikPajak(awal), sidikPajak([item("a", 12), item("b", 0, 2)]));
    assert.notEqual(sidikPajak(awal), sidikPajak([item("a", 11, 0, 1_000_001), item("b", 0, 2)]));
});

test("tahap Tax: belum dikirim → menunggu → dikembalikan / disetujui; nilai berubah sesudah disetujui = berubah", () => {
    const items = [item("a", 11)];
    assert.equal(tahapTax(draf(), items), "belum_dikirim");
    assert.equal(tahapTax(draf("menunggu"), items), "menunggu");
    assert.equal(tahapTax(draf("dikembalikan"), items), "dikembalikan");
    assert.equal(tahapTax(draf("disetujui", sidikPajak(items)), items), "disetujui");
    assert.equal(tahapTax(draf("disetujui", sidikPajak(items)), [item("a", 12)]), "berubah");
});

test("dokumen terkunci sampai disetujui, hanya selagi Draf / Perlu revisi", () => {
    const items = [item("a", 11)];
    for (const st of [null, "menunggu", "dikembalikan"]) assert.notEqual(alasanTaxDokumen(draf(st), items), "", `${st} harus terkunci`);
    assert.notEqual(alasanTaxDokumen(draf("disetujui", "sidik-lama"), items), "", "disetujui dengan nilai lama tetap terkunci");
    assert.equal(alasanTaxDokumen(draf("disetujui", sidikPajak(items)), items), "");
    assert.notEqual(alasanTaxDokumen({ status: "Need Revision", taxStatus: null, taxSidik: null }, items), "");
    // Klaim lama yang sudah Siap dikirim / Dikirim sebelum aturan ini tidak dikunci.
    assert.equal(alasanTaxDokumen({ status: "Ready to Submit", taxStatus: null, taxSidik: null }, items), "");
    assert.equal(alasanTaxDokumen({ status: "Submitted to Principal", taxStatus: null, taxSidik: null }, items), "");
});
