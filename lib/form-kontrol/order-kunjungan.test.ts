/* Uji murni order kunjungan (owner 14 Nov 2026): stok toko, rujukan order per tipe salesman, saran order, limit kredit. */
import assert from "node:assert/strict";
import test from "node:test";
import { MAKS_BARIS_STOK, REF_PRINCIPAL, gabungRefOrder, nomorDariRef, periksaRefOrder, periksaStok, refWebsales, ringkasLimit, saranOrder, sisaLimit } from "./order-kunjungan";

test("periksaStok: kosong = tanpa stok; angka ≥ 0 maks. 2 desimal; satuan huruf besar; ganda ditolak", () => {
    assert.deepEqual(periksaStok(null), { baris: [] });
    assert.deepEqual(periksaStok(undefined), { baris: [] });
    assert.ok("error" in periksaStok("x"));
    const ok = periksaStok([{ kodeBarang: " A1 ", namaBarang: "Sabun", satuan: "pcs", stok: "0,5", rataBulan: 12.345 }, { kodeBarang: "A1", satuan: "KRT", stok: 0 }]);
    assert.deepEqual(ok, { baris: [
        { kodeBarang: "A1", namaBarang: "Sabun", satuan: "PCS", stok: 0.5, rataBulan: 12.35 },
        { kodeBarang: "A1", namaBarang: "A1", satuan: "KRT", stok: 0, rataBulan: null },
    ] });
    assert.ok("baris" in periksaStok([{ kodeBarang: "A", satuan: "PCS", stok: 0.1 }]), "0.1 * 100 bukan bilangan bulat persis di floating point");
    assert.ok("error" in periksaStok([{ kodeBarang: "A", satuan: "PCS", stok: -1 }]));
    assert.ok("error" in periksaStok([{ kodeBarang: "A", satuan: "PCS", stok: 1.234 }]));
    assert.ok("error" in periksaStok([{ kodeBarang: "A", satuan: "PCS", stok: "" }]));
    assert.ok("error" in periksaStok([{ kodeBarang: "", satuan: "PCS", stok: 1 }]));
    assert.ok("error" in periksaStok([{ kodeBarang: "A", satuan: "pcs", stok: 1 }, { kodeBarang: "A", satuan: "PCS", stok: 2 }]));
    assert.ok("error" in periksaStok(Array.from({ length: MAKS_BARIS_STOK + 1 }, (_, i) => ({ kodeBarang: `K${i}`, satuan: "PCS", stok: 1 }))));
});

test("rujukan order: principal hanya REF_PRINCIPAL, AccAPI hanya websales:<id>; order kedua menambah rujukan", () => {
    assert.equal(periksaRefOrder(REF_PRINCIPAL, "principal"), null);
    assert.notEqual(periksaRefOrder(refWebsales("abc"), "principal"), null);
    assert.equal(periksaRefOrder(refWebsales("3f2a9c1e-77aa-4d1b-9c2e-000000000001"), "accapi"), null);
    assert.notEqual(periksaRefOrder(REF_PRINCIPAL, "accapi"), null);
    assert.notEqual(periksaRefOrder("websales:", "accapi"), null);
    assert.notEqual(periksaRefOrder("websales:a b", "accapi"), null);
    assert.equal(gabungRefOrder(null, "websales:a"), "websales:a");
    assert.equal(gabungRefOrder("websales:a", "websales:b"), "websales:a,websales:b");
    assert.equal(gabungRefOrder("websales:a,websales:b", "websales:a"), "websales:a,websales:b");
    assert.deepEqual(nomorDariRef("websales:3f2a9c1e-77aa,websales:b"), ["#3f2a9c1e", "#b"]);
    assert.deepEqual(nomorDariRef(REF_PRINCIPAL), []);
});

test("saran order = ceil(rata sebulan − stok), minimal 0", () => {
    assert.equal(saranOrder(24, 10), 14);
    assert.equal(saranOrder(1.2, 0), 2);
    assert.equal(saranOrder(5, 9), 0);
    assert.equal(saranOrder(0, 0), 0);
    assert.equal(saranOrder(6, null), 6);
});

test("limit kredit: sisa = limit − piutang; tidak diatur = null; lewat limit disebut", () => {
    const rb = (n: number) => `${n / 1000} rb`;
    assert.equal(sisaLimit({ limit: 5_000_000, piutang: 4_100_000 }), 900_000);
    assert.equal(sisaLimit({ limit: null, piutang: 100 }), null);
    assert.deepEqual(ringkasLimit({ limit: 5_000, piutang: 4_000 }, rb), { teks: "Limit 5 rb · sisa 1 rb", lewat: false });
    assert.deepEqual(ringkasLimit({ limit: 5_000, piutang: 6_000 }, rb), { teks: "Limit 5 rb · lewat 1 rb", lewat: true });
    assert.deepEqual(ringkasLimit({ limit: null, piutang: null }, rb), { teks: "Limit tidak diatur", lewat: false });
});
