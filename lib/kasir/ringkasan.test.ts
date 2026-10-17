/*
 * Tujuan: Uji ringkasan Kasir untuk tile Beranda (K3, BL-59) TANPA DB: angka tile = angka layar /kasir (bentukJawabanHari), Incaso belum
 *   lengkap = null (bukan nol), jendela "hari belum ditutup" = hari ini + 7 hari kerja terakhir (Senin–Sabtu), kunci otomatis ≠ tutup.
 * Caller: npm test (tsx --test lib/**\/*.test.ts).
 * Dependensi: node:test, lib/kasir/ringkasan, lib/kasir/hari (bentukJawabanHari), lib/kasir/rekonsiliasi.
 * Main Functions: jendelaTutup, bentukRingkasan.
 * Side Effects: Tidak ada.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { bentukJawabanHari, type Muatan } from "./hari.ts";
import { belumDibaca, type StatusBaca } from "./baca-pelunasan.ts";
import { rekonsiliasiHari, type PetaOrang } from "./rekonsiliasi.ts";
import { bentukRingkasan, jendelaTutup, type EventJendela } from "./ringkasan.ts";

const D = "2026-10-17"; // Sabtu
const SEKARANG = new Date("2026-10-17T10:00:00+08:00");
const PETA: PetaOrang = { kodeSalesman: new Map([[1, "S-A"], [2, "S-B"], [3, "S-C"], [4, "S-D"]]), gabunganPerBulan: new Map() };
const cair = (id: number, nomor: string, sid: number, sen: number) => ({ id, nomor, tanggal: D, metode: "CASH_OTHER", chequeAmount: sen,
    faktur: [{ fakturId: id * 10, masterSalesmanId: sid, invoicePayment: sen }] });
const setor = (id: number, kode: string, sen: number) => ({ id, salesmanKode: kode, revisi: 1, tunai: sen, transfer: 0, giro: 0, giroNomor: null,
    giroJatuhTempo: null, noFormKasir: "FK-1", buktiTransfer: null, catatan: null, dicatatOleh: "u-kasir", dicatatPada: SEKARANG });
const kartu = (id: number, sen: number) => ({ id, nomor: `SR/${id}`, tanggal: D, metode: "CREDIT_CARD", chequeAmount: sen, faktur: [] });

/**
 * S-A klop; S-B selisih (belum dijelaskan); S-C belum setor (belum dijelaskan); S-D belum setor (SUDAH dijelaskan);
 * ember 91 belum dijelaskan, ember 92 sudah dijelaskan.
 */
function muatan(baca: StatusBaca | null): Muatan {
    const pelunasan = baca ? [cair(11, "SR/11", 1, 10_000_000), cair(12, "SR/12", 2, 20_000_000), cair(13, "SR/13", 3, 30_000_000),
        cair(14, "SR/14", 4, 5_000_000), kartu(91, 50_000_000), kartu(92, 7_000_000)] : [];
    const setoran = [setor(1, "S-A", 10_000_000), setor(2, "S-B", 15_000_000)];
    const catatan = [{ salesmanKode: "S-D", pelunasan: 5_000_000, setoran: 0 }];
    const catatanTak = [{ pelunasanId: 92, sisa: 7_000_000 }];
    return {
        tanggal: D, databaseId: baca ? "DB-UJI" : "", events: [], setoran, baca, pelunasan, peta: PETA, namaKode: new Map(),
        pegawai: [], kodeDikenal: new Set(["S-A", "S-B", "S-C", "S-D"]),
        catatan: catatan.map((c, i) => ({ id: i + 1, ...c, penjelasan: "x".repeat(20), tindakLanjut: "setor_susulan", dicatatOleh: "u-kasir", dicatatPada: SEKARANG })),
        catatanTak: catatanTak.map((c, i) => ({ id: i + 1, ...c, penjelasan: "x".repeat(20), dicatatOleh: "u-kasir", dicatatPada: SEKARANG })),
        hasil: rekonsiliasiHari({ tanggal: D, pelunasan, setoran, peta: PETA, catatan, catatanTakTeralokasi: catatanTak }),
    };
}
const st = (s: Partial<StatusBaca>): StatusBaca => ({ ...belumDibaca("DB-UJI", D), ...s });
const LENGKAP = st({ status: "lengkap", lengkapPada: "2026-10-17T01:55:00.000Z", jumlahDaftar: 6, sisaDetail: 0 });

let nomorEvent = 0;
const ev = (tanggal: string, jenis: EventJendela["jenis"], jam: string, alasan: string | null = null): EventJendela =>
    ({ id: ++nomorEvent, tanggal, jenis, pada: new Date(`${tanggal}T${jam}+08:00`), alasan });

test("jendelaTutup: hari ini + 7 hari kerja terakhir (Senin–Sabtu), Minggu dilewati, lintas pekan", () => {
    // Sabtu 17 Okt: Jumat 16 ... Senin 12, Sabtu 10, Jumat 9 (Minggu 11 dilewati).
    assert.deepEqual(jendelaTutup("2026-10-17"), ["2026-10-09", "2026-10-10", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"]);
    // Senin 12 Okt: Sabtu 10 mundur sampai Sabtu 3 (Minggu 11 dan 4 dilewati).
    assert.deepEqual(jendelaTutup("2026-10-12"), ["2026-10-03", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-12"]);
    // Minggu 18 Okt (bukan hari kerja): hari ini DIKECUALIKAN; tinggal 7 hari kerja sebelumnya (Sabtu 17 s/d Sabtu 10).
    assert.deepEqual(jendelaTutup("2026-10-18"), ["2026-10-10", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"]);
    // Lintas bulan/tahun: tanggal sah tetap (tanpa 31 Feb dsb).
    assert.deepEqual(jendelaTutup("2027-01-04"), ["2026-12-26", "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-04"]);
});

test("bentukRingkasan: angka tile = hitungan layar /kasir dari JawabanHari yang sama (selisih orang, ember, belum setor)", () => {
    const m = muatan(LENGKAP);
    const layar = bentukJawabanHari(m, { sekarang: SEKARANG, orang: null, namaUser: new Map(), baca: null });
    // Rumus layar (app/(dashboard)/kasir/Kasir.tsx): nSelisih, nBelum, total.takTeralokasiBelumDijelaskan.
    const nSelisih = layar.orang.filter((o) => o.status === "selisih" && !o.dijelaskan).length;
    const nBelum = layar.orang.filter((o) => o.status === "belum_setor" && !o.dijelaskan).length;
    const r = bentukRingkasan(m, [], jendelaTutup(D), SEKARANG);
    assert.equal(r.ok, true);
    assert.equal(r.tanggal, D);
    assert.deepEqual(r.incaso, layar.incaso);
    assert.deepEqual(r.baca, { status: "lengkap", lengkapPada: "2026-10-17T01:55:00.000Z" });
    assert.deepEqual([nSelisih, nBelum, layar.total.takTeralokasiBelumDijelaskan], [1, 1, 1], "pegangan fixture: S-B, S-C, ember 91");
    assert.deepEqual(r.selisih, { orang: nSelisih, takTeralokasi: layar.total.takTeralokasiBelumDijelaskan, jumlah: 2 });
    // Belum menyetor = SEMUA orang ber-pelunasan tanpa setoran (S-C dan S-D, juga yang sudah dijelaskan); belumDijelaskan = nBelum layar.
    assert.deepEqual(r.belumSetor, { jumlah: 2, belumDijelaskan: nBelum });
});

test("bentukRingkasan: Incaso belum lengkap = null (BUKAN nol) untuk selisih & belum setor; hari belum ditutup tetap ada; tanpa database -> baca null", () => {
    for (const baca of [st({}), st({ status: "berjalan", aktif: true }), st({ status: "sebagian", jumlahDaftar: 3, sisaDetail: 1 }), st({ status: "gagal", sebab: "bentuk", pesan: "x" })]) {
        const r = bentukRingkasan(muatan(baca), [], jendelaTutup(D), SEKARANG);
        assert.equal(r.selisih, null, baca.status);
        assert.equal(r.belumSetor, null, baca.status);
        assert.equal(r.incaso.lengkap, false);
        assert.equal(r.incaso.sebab, "BACA_BELUM_LENGKAP");
        assert.equal(r.baca?.status, baca.status);
        assert.equal(r.hariBelumDitutup.jumlah, 8, "Tutup tidak bergantung pada pembacaan Incaso");
    }
    const tanpaDb = bentukRingkasan(muatan(null), [], jendelaTutup(D), SEKARANG);
    assert.deepEqual([tanpaDb.baca, tanpaDb.incaso.sebab, tanpaDb.selisih, tanpaDb.belumSetor], [null, "SESI_SINKRON", null, null]);
});

test("bentukRingkasan: hari belum ditutup = tanpa event tutup yang berlaku; kunci otomatis & buka kembali TIDAK menutup", () => {
    const events = [
        ev("2026-10-09", "tutup", "18:00:00"),
        ev("2026-10-13", "tutup", "18:00:00"),
        ev("2026-10-14", "tutup", "18:00:00"), ev("2026-10-14", "buka", "21:00:00", "koreksi selisih ember tak teralokasi"), // dibuka lagi, jendela lewat
        ev("2026-10-15", "kunci", "20:00:00"), // kunci otomatis ≠ tutup
        ev("2026-10-16", "tutup", "19:00:00"),
        ev("2026-10-08", "tutup", "18:00:00"), // di luar jendela: diabaikan
    ];
    const r = bentukRingkasan(muatan(LENGKAP), events, jendelaTutup(D), SEKARANG);
    assert.deepEqual(r.hariBelumDitutup.tanggal, ["2026-10-10", "2026-10-12", "2026-10-14", "2026-10-15", "2026-10-17"]);
    assert.equal(r.hariBelumDitutup.jumlah, 5);
    assert.deepEqual(r.hariBelumDitutup.jendela, jendelaTutup(D));
    // Semua tutup -> nol (benar-benar nol, bukan kosong tanpa makna).
    const semua = jendelaTutup(D).map((t) => ev(t, "tutup", "18:00:00"));
    assert.deepEqual(bentukRingkasan(muatan(LENGKAP), semua, jendelaTutup(D), SEKARANG).hariBelumDitutup, { jumlah: 0, tanggal: [], jendela: jendelaTutup(D) });
});
