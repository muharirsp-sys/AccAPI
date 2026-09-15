/* Kunci: satu lampiran memuat outlet SELURUH distributor nasional. Salah saring berarti
   memberi program milik distributor lain kepada outlet kita, atau sebaliknya. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromOcrRows, letterHead, readLetterOutlets } from "./promo-letter.ts";

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

test("hasil OCR: yang jelas bukan kode ditolak, sisanya tetap disaring per distributor", () => {
    const hasil = fromOcrRows([
        { kode_dist: "1201671", nama_dist: "SURYA PERKASA, CV - MAKASSAR", kode_outlet: "5191202075409", nama_outlet: "BAJI PAMAI CBA0003" },
        { kode_dist: "1201671", nama_dist: "SURYA PERKASA, CV - MAKASSAR", kode_outlet: "5191202076135", nama_outlet: "WANG MART CWA0012" },
        // Sel yang tidak terbaca pada hasil scan: bukan kode, jadi jadi LUBANG yang terlihat.
        { kode_dist: "1201671", nama_dist: "SURYA PERKASA, CV - MAKASSAR", kode_outlet: "tidak terbaca", nama_outlet: "?" },
        { kode_dist: "1201937", nama_dist: "JB DISTRIBUSI, CV - LOMBOK", kode_outlet: "1937JBD0123", nama_outlet: "CV MATAHARI" },
    ], { kodeAju: "BP2609007909", program: "MTI - HPC CONSUMER PROMO ON PO" }, "1201671");

    assert.deepEqual(hasil.outlets.map((o) => o.outletCode), ["5191202075409", "5191202076135"]);
    assert.equal(hasil.skipped, 1);
    assert.equal(hasil.kodeAju, "BP2609007909");
    assert.equal(hasil.tanpaKodeDist, false);
    // Distributor lain tetap terhitung, supaya kode yang salah ketik tetap bisa ditunjukkan.
    assert.equal(hasil.distributors.length, 2);
});

test("lampiran principal LAIN: kode beraksara dan tanpa kolom distributor tetap terbaca", () => {
    // Bentuk nyata surat URC "PROMO TOKO ONLINE SEPTEMBER 2026 - SULAWESI 1": kode toko sudah
    // kode Accurate (`C-BRI002`) dan kode distributornya beraksara (`SUR030`) — dua-duanya
    // gagal kalau dipaksa memakai jangkar Kino (tujuh angka / diawali angka).
    const berdist = fromOcrRows([
        { kode_dist: "SUR030", nama_dist: "CV SURYA PERKASA", kode_outlet: "C-BRI002", nama_outlet: "BRILLIAN KEVIN" },
        { kode_dist: "SUR030", nama_dist: "CV SURYA PERKASA", kode_outlet: "C-ZEL790", nama_outlet: "ZELAN STORE" },
        { kode_dist: "NUR011", nama_dist: "CV NURHIDAYAT", kode_outlet: "C-LAIN01", nama_outlet: "MILIK ORANG LAIN" },
    ], { kodeAju: "542/TMDH1/8/26", program: "PROMO TOKO ONLINE" }, "SUR030");
    assert.deepEqual(berdist.outlets.map((o) => o.outletCode), ["C-BRI002", "C-ZEL790"]);

    // Lampiran yang memang TIDAK punya kolom distributor: seluruh daftarnya milik kita, karena
    // surat seperti itu memang dikirim per distributor. Tetap ditandai supaya terlihat.
    const tanpa = fromOcrRows([
        { kode_dist: "", nama_dist: "", kode_outlet: "C-BRI002", nama_outlet: "BRILLIAN KEVIN" },
        { kode_dist: "", nama_dist: "", kode_outlet: "C-ZEL790", nama_outlet: "ZELAN STORE" },
    ], { kodeAju: "542/TMDH1/8/26", program: "PROMO TOKO ONLINE" }, "SUR030");
    assert.equal(tanpa.outlets.length, 2);
    assert.equal(tanpa.tanpaKodeDist, true);
    assert.deepEqual(tanpa.distributors, []);
});

test("kop surat dibaca sama dari lapisan teks maupun dari markdown OCR", () => {
    assert.deepEqual(letterHead("Kode Aju : BP2609007909\nNama Program Promo : MTI - HPC"),
        { kodeAju: "BP2609007909", program: "MTI - HPC" });
    // Markdown OCR membubuhi tebal; nilainya tetap harus keluar.
    assert.equal(letterHead("**Kode Aju** : BP2609007713").kodeAju, "BP2609007713");
    assert.deepEqual(letterHead("halaman tanpa kop"), { kodeAju: "", program: "" });
});

test("kop dalam bentuk TABEL markdown juga terbaca", () => {
    assert.equal(letterHead("| Kode Aju | BP2609006016 |\n| Nama Program Promo | MSG ALL BRAND |").kodeAju, "BP2609006016");
    assert.equal(letterHead("| Kode Aju | BP2609006016 |\n| Nama Program Promo | MSG ALL BRAND |").program, "MSG ALL BRAND");
});
