/* Uji murni panel Kontrol bulan ini Supervisor Review (owner 13 Nov 2026): dua tipe sales, pindahan/potensi/kelas A, target, item super. */
import assert from "node:assert/strict";
import test from "node:test";
import { hitungKontrol, type MasukanKontrol } from "./kontrol";

const dasar = (x: Partial<MasukanKontrol> = {}): MasukanKontrol => ({
    tanggal: "2026-11-13",
    salesman: [{ salesCode: "S1", nama: "SALES A", cabang: "CABANG A", sumberOrder: "principal" }, { salesCode: "S2", nama: "SALES B", cabang: "CABANG A", sumberOrder: "accapi" }],
    jks: [
        { salesCode: "S1", custCode: "C-1", custName: "TOKO 1", kategori: "AKTIF", kelasA: true, statusJks: "PINDAH SALES", targetToko: 1_000, lokasiDari: "GPS lapangan" },
        { salesCode: "S1", custCode: "C-2", custName: "TOKO 2", kategori: "OUTLET POTENSI", kelasA: null, statusJks: "TETAP", targetToko: 500, lokasiDari: "tengah kelurahan" },
        { salesCode: "S2", custCode: "C-9", custName: "TOKO 9", kategori: null, kelasA: null, statusJks: null, targetToko: null, lokasiDari: null },
    ],
    ao: [], faktur: [], tawaran: [], ...x,
});

test("ORDER dilaporkan vs faktur: batas principal 3 hari, AccAPI 1 hari; faktur salesman lain tidak dihitung", () => {
    const [s1, s2] = hitungKontrol(dasar({
        ao: [
            { salesCode: "S1", custCode: "C-1", date: "2026-11-02", status: "ordered", nomorOrder: "SO-1", checkin: true }, // faktur 5 Nov (D+3) = berfaktur
            { salesCode: "S1", custCode: "C-2", date: "2026-11-03", status: "ordered", nomorOrder: null, checkin: true },  // tanpa faktur, 6 < 13 = terlambat
            { salesCode: "S1", custCode: "C-2", date: "2026-11-11", status: "ordered", nomorOrder: null, checkin: true },  // 14 ≥ 13 = menunggu
            { salesCode: "S2", custCode: "C-9", date: "2026-11-10", status: "ordered", nomorOrder: null, checkin: true },  // faktur 12 Nov (D+2) > batas 1 = terlambat
        ],
        faktur: [
            { salesCode: "S1", customerNo: "C-1-KN", tanggal: "2026-11-05", total: 700 },
            { salesCode: "S9", customerNo: "C-2-KN", tanggal: "2026-11-04", total: 999 }, // salesman lain
            { salesCode: "", customerNo: "C-9-AB", tanggal: "2026-11-12", total: 50 },     // tanpa salesman terpetakan = dihitung
        ],
    }));
    assert.equal(s1.salesCode, "S1");
    assert.deepEqual(s1.order, { dilaporkan: 3, berfaktur: 1, menunggu: 1, terlambat: 1 });
    assert.deepEqual(s1.orderTerlambat.map((o) => [o.custCode, o.tanggal]), [["C-2", "2026-11-03"]]);
    assert.deepEqual(s1.target, { target: 1_500, realisasi: 700 });
    assert.deepEqual(s2.order, { dilaporkan: 1, berfaktur: 0, menunggu: 0, terlambat: 1 });
    assert.equal(s2.target.realisasi, 50);
});

test("pindahan / potensi / kelas A sudah order (faktur atau ORDER dilaporkan); lokasi perkiraan; item super + alasan teratas", () => {
    const [s1] = hitungKontrol(dasar({
        ao: [{ salesCode: "S1", custCode: "C-2", date: "2026-11-04", status: "not_order", nomorOrder: null, checkin: true },
            // Bintang prioritas tanpa check-in BUKAN kunjungan.
            { salesCode: "S1", custCode: "C-2", date: "2026-11-05", status: "priority", nomorOrder: null, checkin: false }],
        faktur: [{ salesCode: "S1", customerNo: "C-1-KN", tanggal: "2026-11-05", total: 10 }],
        tawaran: [
            { salesCode: "S1", ditawarkan: true, dipesan: true, alasan: null },
            { salesCode: "S1", ditawarkan: true, dipesan: false, alasan: "HARGA" },
            { salesCode: "S1", ditawarkan: false, dipesan: null, alasan: "TIDAK_SEMPAT" },
            { salesCode: "S1", ditawarkan: true, dipesan: false, alasan: "HARGA" },
        ],
    }));
    assert.deepEqual(s1.pindahan, { total: 1, order: 1 });
    assert.deepEqual(s1.potensi, { total: 1, dikunjungi: 1, order: 0 });
    const [s1b] = hitungKontrol(dasar({ ao: [{ salesCode: "S1", custCode: "C-2", date: "2026-11-05", status: "priority", nomorOrder: null, checkin: false }] }));
    assert.equal(s1b.potensi.dikunjungi, 0, "bintang saja = belum dikunjungi");
    assert.deepEqual(s1.kelasA, { total: 1, order: 1 });
    assert.equal(s1.lokasiPerkiraan, 1);
    assert.equal(s1.itemSuper.saran, 4);
    assert.equal(s1.itemSuper.ditawarkan, 3);
    assert.equal(s1.itemSuper.dipesan, 1);
    assert.deepEqual(s1.itemSuper.alasan.map((a) => [a.kode, a.jumlah]), [["HARGA", 2], ["TIDAK_SEMPAT", 1]]);
});
