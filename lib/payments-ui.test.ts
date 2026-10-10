/*
 * Tujuan: Self-check helper layar Pembayaran & SPPD: status rekaman (diajukan butuh nomor pengajuan), isian kurang = cermin
 *         cart/create, rekaman terkunci tidak bisa dipilih, angka ketat (NaN, bukan 0), izin → alasan, tanggal WITA, nomor SPPD.
 * Caller: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { angka, besokWita, bisaDiajukan, galatTemplat, izinPembayaran, keYmd, kurangLengkap, namaAkun, pratinjauNomor, statusRekaman, tanggalTampil, type Rekaman } from "@/lib/payments-ui";

const LENGKAP: Rekaman = { record_id: "LPB-1", tipe_pengajuan: "LPB", no_lpb: "LPB-1", principle: "PRINCIPLE A", tgl_invoice: "2026-10-06", jt_invoice: "2026-11-05", invoice_no: "INV-1", nilai_invoice: "12.500.000", locked_reason: "" };

test("status: lengkap = siap; kurang = draf; diajukan butuh nomor pengajuan; transfer/posted menang", () => {
    assert.equal(statusRekaman(LENGKAP), "siap");
    assert.equal(statusRekaman({ ...LENGKAP, invoice_no: "" }), "draf");
    assert.equal(statusRekaman({ ...LENGKAP, status_pembayaran: "Belum Transfer", submission_id: "1f2e3d4c" }), "diajukan");
    // Data lama "Belum Transfer" tanpa pengajuan bisa diajukan (server _already_submitted = false).
    assert.equal(statusRekaman({ ...LENGKAP, status_pembayaran: "Belum Transfer" }), "siap");
    assert.equal(statusRekaman({ ...LENGKAP, status_pembayaran: "Ajukan Ulang", submission_id: "x" }), "ulang");
    assert.equal(statusRekaman({ ...LENGKAP, status_pembayaran: "Sudah Transfer" }), "transfer");
    assert.equal(statusRekaman({ ...LENGKAP, status_pembayaran: "Ajukan Ulang", accurate_post_status: "posted" }), "transfer");
});

test("isian kurang = cermin cart/create per tipe; nilai 0/tak terbaca = kurang", () => {
    assert.deepEqual(kurangLengkap(LENGKAP), []);
    assert.deepEqual(kurangLengkap({ record_id: "C", tipe_pengajuan: "CBD", principle: "P", nilai_invoice: 1000 }), ["No. invoice"]);
    assert.deepEqual(kurangLengkap({ record_id: "C", tipe_pengajuan: "CBD", principle: "P", no_lpb: "REF", nilai_invoice: 1000 }), []);
    assert.deepEqual(kurangLengkap({ record_id: "N", tipe_pengajuan: "NON_LPB", principle: "P", jenis_dokumen: "Nota Debet", nilai_invoice: "3.250.000" }), ["Nomor dokumen"]);
    assert.deepEqual(kurangLengkap({ ...LENGKAP, nilai_invoice: "" }), ["Nilai invoice"]);
    assert.deepEqual(kurangLengkap({ ...LENGKAP, nilai_invoice: "17.750.00O" }), ["Nilai invoice"]);
});

test("pilihan keranjang: hanya siap/ajukan ulang yang lengkap dan TIDAK dikunci server", () => {
    assert.equal(bisaDiajukan(LENGKAP), true);
    assert.equal(bisaDiajukan({ ...LENGKAP, status_pembayaran: "Ajukan Ulang" }), true);
    assert.equal(bisaDiajukan({ ...LENGKAP, status_pembayaran: "Ajukan Ulang", locked_reason: "posting Accurate tidak pasti (menunggu penyelesaian Finance)" }), false);
    assert.equal(bisaDiajukan({ ...LENGKAP, status_pembayaran: "Belum Transfer", submission_id: "a" }), false);
    assert.equal(bisaDiajukan({ ...LENGKAP, invoice_no: "" }), false);
});

test("angka ketat: rupiah Indonesia, NaN untuk teks rusak (bukan 0)", () => {
    assert.equal(angka("12.500.000"), 12_500_000);
    assert.equal(angka("Rp 1.250,50"), 1250.5);
    assert.equal(angka(3250000), 3_250_000);
    assert.equal(angka(""), 0);
    assert.ok(Number.isNaN(angka("17.750.00O")));
    assert.ok(Number.isNaN(angka("5 juta")));
});

test("izin: tanpa kunci = alasan terlihat tanpa nama kunci mentah", () => {
    const iz = izinPembayaran(["payments.view", "payments.edit", "sppd.view"]);
    assert.equal(iz.keranjang, undefined);
    assert.equal(iz.unggah, undefined);
    assert.match(iz.ubah ?? "", /belum punya izin mengubah isian rekaman/);
    assert.match(iz.restore ?? "", /memulihkan backup/);
    assert.match(iz.setelan ?? "", /setelan dan nomor SPPD/);
    for (const alasan of Object.values(iz)) assert.doesNotMatch(alasan ?? "", /payments\.|sppd\./);
});

test("tanggal: tampil dd/mm/yyyy, isian YYYY-MM-DD, besok menurut WITA (bukan UTC)", () => {
    assert.equal(tanggalTampil("2026-10-06"), "06/10/2026");
    assert.equal(tanggalTampil("06/10/2026"), "06/10/2026");
    assert.equal(tanggalTampil(""), "—");
    assert.equal(keYmd("6/10/2026"), "2026-10-06");
    // 9 Okt 23.30 UTC = 10 Okt 07.30 WITA → besok = 11 Okt (UTC akan menjawab 10 Okt).
    assert.equal(besokWita(new Date("2026-10-09T23:30:00Z")), "2026-10-11");
    assert.equal(namaAkun("betterauth|staff|a@x"), "a@x");
});

test("nomor SPPD: cermin templat server; tanpa nomor urut / isian asing ditolak", () => {
    assert.equal(pratinjauNomor("{seq:03d}/SPA/PDSB/{roman_month}/{year}", 32, "2026-10-10"), "032/SPA/PDSB/X/2026");
    assert.equal(pratinjauNomor("{seq}-{month}-{yy}", 7, "2027-01-02"), "7-1-27");
    assert.match(galatTemplat("SPA/PDSB/{year}") ?? "", /nomor urut/);
    assert.match(galatTemplat("{seq:03d}/{tahun}") ?? "", /tidak dikenal/);
    assert.equal(galatTemplat("{seq:03d}/SPA/PDSB/{roman_month}/{year}"), undefined);
});
