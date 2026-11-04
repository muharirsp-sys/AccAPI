import { test } from "node:test";
import assert from "node:assert/strict";
import { cocokPelanggan, parseAlokasi, periksaAlokasi, type FakturPotong } from "./potong-tagihan";

const faktur = (number: string, customerNo: string, customerName: string, outstanding: number | null, id = 1): FakturPotong =>
    ({ id, number, customerNo, customerName, outstanding });
const peta = (...f: FakturPotong[]) => new Map(f.map((x) => [x.number.toUpperCase(), [x]]));
const item = { id: "i1", itemNo: 1, toko: "TOKO A (C-TA0001)", nominal: 700_000 };

test("cocokPelanggan: kode pelanggan di teks toko, atau nama sama persis; selain itu tidak", () => {
    assert.equal(cocokPelanggan("TOKO A (C-TA0001)", "C-TA0001", "TOKO LAIN"), true);
    assert.equal(cocokPelanggan("Toko A", null, "TOKO A"), true);
    assert.equal(cocokPelanggan("TOKO A (C-TA0001)", "C-TB0002", "TOKO B"), false);
    assert.equal(cocokPelanggan("", "", ""), false);
});

test("parseAlokasi membuang baris kosong dan menolak muatan bukan larik", () => {
    assert.deepEqual(parseAlokasi('[{"itemId":"i1","nomorFaktur":" INV/1 ","nominal":"5"},{}]'), [{ itemId: "i1", nomorFaktur: "INV/1", nominal: 5 }]);
    assert.throws(() => parseAlokasi('{"a":1}'));
});

test("periksaAlokasi: satu item dari dua faktur lolos bila jumlahnya pas dan tiap faktur cukup", () => {
    const hasil = periksaAlokasi({
        items: [item],
        alokasi: [{ itemId: "i1", nomorFaktur: "inv/1", nominal: 500_000 }, { itemId: "i1", nomorFaktur: "INV/2", nominal: 200_000 }],
        faktur: peta(faktur("INV/1", "C-TA0001", "TOKO A", 600_000, 1), faktur("INV/2", "C-TA0001", "TOKO A", 200_000, 2)),
        terpakai: new Map(),
    });
    assert.deepEqual(hasil, { ok: true });
});

test("periksaAlokasi menolak: jumlah tak sama nominal, faktur tak ada, pelanggan beda, melebihi sisa setelah potongan OPC lain", () => {
    const dasar = { items: [item], terpakai: new Map<string, number>() };
    const satu = (nominal: number) => [{ itemId: "i1", nomorFaktur: "INV/1", nominal }];
    assert.match((periksaAlokasi({ ...dasar, alokasi: satu(600_000), faktur: peta(faktur("INV/1", "C-TA0001", "TOKO A", 900_000)) }) as { error: string }).error, /sama dengan nominal item/);
    assert.match((periksaAlokasi({ ...dasar, alokasi: satu(700_000), faktur: new Map() }) as { error: string }).error, /tidak ditemukan/);
    assert.match((periksaAlokasi({ ...dasar, alokasi: satu(700_000), faktur: peta(faktur("INV/1", "C-TB0002", "TOKO B", 900_000)) }) as { error: string }).error, /bukan toko/);
    assert.match((periksaAlokasi({ items: [item], terpakai: new Map([["INV/1", 300_000]]), alokasi: satu(700_000), faktur: peta(faktur("INV/1", "C-TA0001", "TOKO A", 900_000)) }) as { error: string }).error, /melebihi sisa tagihan/);
    assert.match((periksaAlokasi({ ...dasar, alokasi: [], faktur: new Map() }) as { error: string }).error, /minimal satu nomor faktur/);
});
