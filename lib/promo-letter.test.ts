/* Kunci: satu lampiran memuat outlet SELURUH distributor nasional. Salah saring berarti
   memberi program milik distributor lain kepada outlet kita, atau sebaliknya. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readLetterOutlets } from "./promo-letter.ts";

// Baris asli BP2609007909 (halaman 2), apa adanya hasil bacaan lapisan teks suratnya.
const kop = [
    "Print Date : 26 August 2026",
    "NO. PROMO ID : PN26006070",
    "Kode Aju : BP2609007909",
    "Nama Program Promo : MTI - HPC CONSUMER PROMO ON PO 1 SEPTEMBER 2026 - 30 SEPTEMBER 2026",
].join("\n");

const lampiran = [
    "REGION KODE DIST NAMA DIST KONV KODE OUTLET NAMA OUTLET NAMA BM KIBAS SKP PRONAS MEKANISME PRONAS",
    "BALI NUSRA 1201937 JB DISTRIBUSI, CV - LOMBOK 1937JBD0123 CV MATAHARI KAMARUDDIN V V ON PO",
    "JABODETABEK 1202324 SARANA ABADI MAKMUR BERSAMA, PT - JAKARTA 232402LIA01 LIAN MART ON PO",
    "JAWA BARAT 1203564 SATRIA SAKTI SEJAHTERA, CV - TASIK 35645191202067333 FAJAR MM (XX006836) ON PO",
    "SULAWESI 1201671 SURYA PERKASA, CV - MAKASSAR 5191202075409 BAJI PAMAI CBA0003 ASRUL AJIB V V ON PO",
    "SULAWESI 1201671 SURYA PERKASA, CV - MAKASSAR 5191202076135 WANG MART CWA0012 ASRUL AJIB V V ON PO",
].join("\n");

test("lampiran surat dibaca jadi outlet peserta milik SATU distributor", () => {
    const hasil = readLetterOutlets([kop, lampiran], "1201671");
    assert.equal(hasil.kodeAju, "BP2609007909");
    assert.match(hasil.program, /MTI - HPC CONSUMER PROMO ON PO/);
    assert.deepEqual(hasil.outlets.map((o) => o.outletCode), ["5191202075409", "5191202076135"]);
    assert.equal(hasil.outlets[0].distName, "SURYA PERKASA, CV - MAKASSAR");
    assert.equal(hasil.skipped, 0);
});

test("outlet distributor LAIN tidak pernah ikut terbawa", () => {
    const hasil = readLetterOutlets([kop, lampiran], "1201671");
    assert.equal(hasil.outlets.every((o) => o.distCode === "1201671"), true);
    // Tetapi distributor lain TETAP dilaporkan, supaya kode yang salah ketik langsung kelihatan
    // sebagai "yang ada di lampiran justru ini" dan bukan sebagai lampiran kosong.
    assert.equal(hasil.distributors.length, 4);
    assert.equal(hasil.distributors.find((d) => d.code === "1201671")?.outlets, 2);
    assert.equal(hasil.distributors.find((d) => d.code === "1201937")?.outlets, 1);
});

test("kode distributor yang tidak ada di lampiran menghasilkan NOL, bukan semuanya", () => {
    const hasil = readLetterOutlets([kop, lampiran], "9999999");
    assert.deepEqual(hasil.outlets, []);
    assert.equal(hasil.distributors.length, 4);
});

test("kolom tengah yang kosong tidak menggeser pembacaan kode outlet", () => {
    // Baris LIAN MART dan FAJAR MM tidak punya NAMA BM/KIBAS/SKP. Kalau kolomnya dihitung per
    // posisi, kode outletnya akan meleset satu kolom; dua jangkar (kode dist, kode outlet)
    // membuat baris pendek terbaca sama benarnya dengan baris penuh.
    assert.equal(readLetterOutlets([kop, lampiran], "1202324").outlets[0].outletCode, "232402LIA01");
    assert.equal(readLetterOutlets([kop, lampiran], "1203564").outlets[0].outletCode, "35645191202067333");
});

test("halaman kop TIDAK pernah dibaca sebagai baris lampiran", () => {
    // Kop memuat "PN26006070" dan tanggal — tidak satu pun boleh jadi outlet.
    assert.deepEqual(readLetterOutlets([kop], "1201671").outlets, []);
    assert.deepEqual(readLetterOutlets([kop], "1201671").distributors, []);
});

test("baris yang tidak terbaca DIHITUNG, bukan dibuang diam-diam", () => {
    const rusak = "SULAWESI 1201671 SURYA PERKASA, CV - MAKASSAR 519-1202-075409 BAJI PAMAI ON PO";
    const hasil = readLetterOutlets([kop, rusak], "1201671");
    assert.deepEqual(hasil.outlets, []);
    assert.equal(hasil.skipped, 1);
});

test("surat hasil scan menghasilkan lampiran kosong, bukan daftar karangan", () => {
    const hasil = readLetterOutlets(["", ""], "1201671");
    assert.deepEqual(hasil.outlets, []);
    assert.equal(hasil.kodeAju, "");
});
