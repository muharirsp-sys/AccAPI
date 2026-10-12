/* Detail faktur (sales-invoice/detail.do): sales tersimpan PER BARIS (`detailItem[].salesmanList`, terbukti lewat verifikasi balik
   lib/invoice-verify). Faktur Order Masuk/Principal yang salesnya hanya di baris tidak boleh tampil "Sales —" (tinjauan S6d B-M7). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapFakturDetail, salesFaktur } from "./accurate-invoice.ts";

const baris = (salesmanList: unknown) => ({ itemNo: "BRG-A1", detailName: "BARANG A1", quantity: 1, unitPrice: 1000, totalPrice: 1000, salesmanList });

test("sales per baris dipetakan; kepala kosong → sales dari baris, ditandai 'per baris'", () => {
    const d = mapFakturDetail({ detailItem: [baris([{ number: "M-SLA", name: "SALES A" }]), baris([{ number: "M-SLA", name: "SALES A" }]), baris([])] });
    assert.deepEqual(d.items.map((i) => i.salesmen), [["SALES A"], ["SALES A"], []]);
    assert.deepEqual(salesFaktur(d), { teks: "SALES A", sumber: "baris" });
});

test("kepala faktur menang; tanpa kepala dan tanpa baris = kosong (bukan tebakan)", () => {
    const kepala = mapFakturDetail({ masterSalesmanName: "SALES B", detailItem: [baris([{ number: "M-SLA", name: "SALES A" }])] });
    assert.deepEqual(salesFaktur(kepala), { teks: "SALES B", sumber: "kepala" });
    const kosong = mapFakturDetail({ detailItem: [baris(undefined)] });
    assert.deepEqual(salesFaktur(kosong), { teks: "", sumber: "tidak ada" });
    // Nama kosong → nomor pegawai; beberapa sales berbeda disebut semuanya.
    const dua = mapFakturDetail({ detailItem: [baris([{ number: "M-SLA" }]), baris([{ number: "M-SLB", name: "SALES B" }])] });
    assert.deepEqual(salesFaktur(dua), { teks: "M-SLA, SALES B", sumber: "baris" });
});
