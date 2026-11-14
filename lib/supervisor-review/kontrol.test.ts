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

test("analisa kunjungan GPS (owner 14 Nov 2026): check-in/check-out jauh dari toko, tanpa GPS, rata-rata menit, singkat, rincian jauh", () => {
    const t = (hhmm: string) => new Date(`2026-11-10T${hhmm}:00Z`);
    const [s1] = hitungKontrol(dasar({
        koordinat: new Map([["C-1", { lat: -5.1477, lng: 119.4327 }], ["C-2", { lat: -5.2, lng: 119.5 }]]),
        ajuan: [{ salesCode: "S1", status: "menunggu" }, { salesCode: "S1", status: "ditolak" }, { salesCode: "S1", status: "disetujui" }, { salesCode: "S2", status: "menunggu" }],
        ao: [
            // C-1 dekat (±11 m) saat check-in dan check-out; 30 menit.
            { salesCode: "S1", custCode: "C-1-KN", date: "2026-11-10", status: "ordered", nomorOrder: null, checkin: true,
                checkinAt: t("01:00"), checkoutAt: t("01:30"), lat: -5.1477, lng: 119.4328, latKeluar: -5.1477, lngKeluar: 119.4328 },
            // C-2 check-in ±1,5 km dari toko, check-out di toko; 3 menit (singkat).
            { salesCode: "S1", custCode: "C-2", date: "2026-11-11", status: "not_order", nomorOrder: null, checkin: true,
                checkinAt: t("02:00"), checkoutAt: t("02:03"), lat: -5.2, lng: 119.5135, latKeluar: -5.2, lngKeluar: 119.5 },
            // Baris principal KEDUA toko C-1 hari yang sama = kunjungan yang SAMA (digabung seperti ringkasan harian), bukan kunjungan baru.
            { salesCode: "S1", custCode: "C-1", date: "2026-11-10", status: "not_order", nomorOrder: null, checkin: true,
                checkinAt: t("01:05"), checkoutAt: t("01:20"), lat: null, lng: null, latKeluar: -5.1477, lngKeluar: 119.4328 },
            // Check-in tanpa GPS (baris lama), belum check-out.
            { salesCode: "S1", custCode: "C-2", date: "2026-11-12", status: "not_order", nomorOrder: null, checkin: true,
                checkinAt: t("03:00"), checkoutAt: null, lat: null, lng: null },
            // Tanpa check-in = bukan kunjungan.
            { salesCode: "S1", custCode: "C-1", date: "2026-11-12", status: "priority", nomorOrder: null, checkin: false, checkinAt: null },
        ],
    }));
    assert.deepEqual(s1.gps, { kunjungan: 3, tanpaGps: 1, terukur: 2, masukJauh: 1, keluarJauh: 0, rataMenit: 17, singkat: 1, jauh: 1,
        ajuanMenunggu: 1, ajuanDitolak: 1 });
    assert.deepEqual(s1.kunjunganJauh.map((k) => [k.custCode, k.namaToko, k.tanggal, k.masukM !== null && k.masukM > 1_000, k.keluarM]),
        [["C-2", "TOKO 2", "2026-11-11", true, 0]]);
    const [tanpa] = hitungKontrol(dasar());
    assert.deepEqual(tanpa.gps, { kunjungan: 0, tanpaGps: 0, terukur: 0, masukJauh: 0, keluarJauh: 0, rataMenit: null, singkat: 0, jauh: 0, ajuanMenunggu: 0, ajuanDitolak: 0 });
});
