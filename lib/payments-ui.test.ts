/*
 * Tujuan: Self-check helper layar Pembayaran & SPPD: status rekaman (diajukan butuh nomor pengajuan), isian kurang = cermin
 *         cart/create, rekaman terkunci tidak bisa dipilih, angka ketat (NaN, bukan 0), izin → alasan, tanggal WITA, nomor SPPD,
 *         saringan rentang tanggal (Actual date / Tanggal bayar pabrik) dengan format tanggal ketat.
 * Caller: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ISIAN, angka, angkaJawaban, besokWita, bisaDiajukan, dalamRentang, galatTemplat, izinPembayaran, keYmd, kurangLengkap, namaAkun, pratinjauNomor, statusRekaman, tanggalTampil, type Rekaman } from "@/lib/payments-ui";

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

test("angka dari jawaban server: null/kosong/bukan angka = tidak terbaca (bukan 0)", () => {
    assert.equal(angkaJawaban(30_000_000), 30_000_000);
    assert.equal(angkaJawaban(0), 0);
    assert.equal(angkaJawaban("46"), 46);
    for (const v of [null, undefined, "", " ", "abc", NaN, Infinity, {}, true]) assert.equal(angkaJawaban(v), undefined, JSON.stringify(v));
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

test("saringan rentang tanggal: kosong = semua lolos; batas inklusif; dibandingkan sebagai tanggal; tanpa tanggal tidak lolos", () => {
    const OKT = { dari: "2026-10-01", sampai: "2026-10-31" };
    // Tidak aktif: semua lolos, termasuk baris tanpa tanggal.
    assert.equal(dalamRentang("", { dari: "", sampai: "" }), true);
    assert.equal(dalamRentang(undefined, { dari: "", sampai: "" }), true);
    // Batas inklusif kedua sisi.
    assert.equal(dalamRentang("2026-10-01", OKT), true);
    assert.equal(dalamRentang("2026-10-31", OKT), true);
    assert.equal(dalamRentang("2026-09-30", OKT), false);
    assert.equal(dalamRentang("2026-11-01", OKT), false);
    // Satu sisi saja.
    assert.equal(dalamRentang("2026-12-25", { dari: "2026-10-01", sampai: "" }), true);
    assert.equal(dalamRentang("2026-09-30", { dari: "2026-10-01", sampai: "" }), false);
    assert.equal(dalamRentang("2026-09-30", { dari: "", sampai: "2026-10-31" }), true);
    assert.equal(dalamRentang("2026-11-01", { dari: "", sampai: "2026-10-31" }), false);
    // Data lama DD/MM/YYYY dibandingkan sebagai tanggal (sebagai teks "15/10/2026" < "2026-…" → salah).
    assert.equal(dalamRentang("15/10/2026", OKT), true);
    assert.equal(dalamRentang("15/11/2026", OKT), false);
    // Bercap waktu: tanggal kalender di depan dipakai apa adanya (tanpa geser zona waktu).
    assert.equal(dalamRentang("2026-10-31T23:30:00Z", OKT), true);
    // Aktif: kosong / teks bukan tanggal / tanggal mustahil = tanpa tanggal → tidak lolos.
    assert.equal(dalamRentang("", OKT), false);
    assert.equal(dalamRentang(undefined, { dari: "2026-10-01", sampai: "" }), false);
    // Hanya "sampai": teks kosong menurut urutan teks < tanggal mana pun → tanpa penjaga, baris tanpa tanggal ikut lolos.
    assert.equal(dalamRentang("", { dari: "", sampai: "2026-10-31" }), false);
    assert.equal(dalamRentang("belum", OKT), false);
    assert.equal(dalamRentang("2026-10-45", { dari: "2026-10-01", sampai: "" }), false);
    assert.equal(dalamRentang("2027-02-30", { dari: "2026-10-01", sampai: "" }), false);
    // Format ketat: hanya YYYY-MM-DD (boleh berjam), DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY. Tebakan `new Date` ("0" → 2000,
    // "12" → 2001, "10/15/26") = tanpa tanggal, bukan tanggal acak yang lolos saringan satu sisi.
    const SEMUA = { dari: "1900-01-01", sampai: "2999-12-31" };
    for (const rusak of ["0", "1", "12", "10/15/26", "15/10/26", "Oct 15 2026", "2026/10/15", "10/15/2026"]) assert.equal(dalamRentang(rusak, SEMUA), false, rusak);
    for (const baik of ["2026-10-15", "2026-10-15 00:00:00", "15/10/2026", "15-10-2026", "15.10.2026", "5/1/2026"]) assert.equal(dalamRentang(baik, SEMUA), true, baik);
    assert.equal(dalamRentang("5/1/2026", { dari: "2026-01-05", sampai: "2026-01-05" }), true); // 5 Jan (DD/MM), bukan 1 Mei
    // Dari > sampai: tidak ada yang lolos (layar menampilkan galat).
    assert.equal(dalamRentang("2026-10-15", { dari: "2026-10-31", sampai: "2026-10-01" }), false);
});

test("label isian tgl_pembayaran = Tanggal bayar pabrik (owner 13 Okt); kunci data tetap", () => {
    assert.equal(ISIAN.find((i) => i.key === "tgl_pembayaran")?.label, "Tanggal bayar pabrik");
});

test("nomor SPPD: cermin templat server; tanpa nomor urut / isian asing ditolak", () => {
    assert.equal(pratinjauNomor("{seq:03d}/SPA/PDSB/{roman_month}/{year}", 32, "2026-10-10"), "032/SPA/PDSB/X/2026");
    assert.equal(pratinjauNomor("{seq}-{month}-{yy}", 7, "2027-01-02"), "7-1-27");
    assert.match(galatTemplat("SPA/PDSB/{year}") ?? "", /nomor urut/);
    assert.match(galatTemplat("{seq:03d}/{tahun}") ?? "", /tidak dikenal/);
    assert.equal(galatTemplat("{seq:03d}/SPA/PDSB/{roman_month}/{year}"), undefined);
});
