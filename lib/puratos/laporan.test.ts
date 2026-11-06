/* Kunci: 5 CSV laporan Puratos — parser nama barang (data nyata Accurate), pembersih teks, DUMMY, dan susun ulang contoh 02.11.2026. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { alamatLengkap, angka, bersih, bersihSalesman, deskripsi, gramasi, kodePelanggan, kodePuratos, namaPelanggan, pcsPerSatuanDasar,
    periode, rupiah, susun, type Baris } from "./laporan.ts";

test("gramasi kg/pcs dari nama barang", () => {
    assert.equal(gramasi('TOPFIL DARK CHERRY 1 PCSX5KG "4025476"T01'), 5);
    assert.equal(gramasi("PURATOS SOFT'R 20 PCSX500GR"), 0.5);
    assert.equal(gramasi("PURATOS AMBIANTE 1 PCSX12LTR"), 12);
    assert.equal(gramasi("CARAT SUPERCREM 10 PCHX1KG"), 1);
    assert.equal(gramasi("A 24 BTL X 250 ML"), 0.25);
    assert.equal(gramasi("A 4 BAGX2,5KG"), 2.5);
    assert.equal(gramasi('B> PRTS TEG. HI WIPCREAM VANILA12 PCSX400GR "4027223"'), 0.4); // angka menempel huruf (data nyata)
    assert.equal(gramasi("PURATOS TANPA KEMASAN"), undefined);
    assert.equal(pcsPerSatuanDasar("ARISTO CROISSANT 10 PCSX1KG", "PCS"), 1);
    assert.equal(pcsPerSatuanDasar("X 4 PCSX5KG", "KRT"), 4);
});

test("kode Puratos & deskripsi SKU", () => {
    assert.equal(kodePuratos('TOPFIL DARK CHERRY 1 PCSX5KG "4025476"T01"'), "4025476");
    assert.equal(kodePuratos('X 1 PCSX5KG "4025476" "4111458"'), "4111458");
    assert.equal(kodePuratos("CARAT SUPERCREM MALT'O CRUNCH 10PCSX1KG 4026248\"CS"), "4026248"); // kutip sesudah kode
    assert.equal(kodePuratos('B> PRTS COLDFIL BLUEBERRY 1 PCSX10KG ""PCF111"'), undefined);
    assert.equal(kodePuratos('X "12345678"'), undefined);
    assert.equal(deskripsi("37010011005000", 'TOPFIL DARK CHERRY 1 PCSX5KG "4025476"T01"'), "TOPFIL DARK CHERRY 1 PCSX5KG");
    assert.equal(deskripsi("370", 'B>PRTS MIMETIC 5 PCSX2KG "4011260"'), "PURATOS MIMETIC 5 PCSX2KG (B)");
    assert.equal(deskripsi("37040061001020B", "B> CARAT SUPERCREM MALT'O CRUNCH 10PCSX1KG 4026248\"CS11\""), "CARAT SUPERCREM MALT'O CRUNCH 10PCSX1KG (B)");
});

test("pembersih teks, pelanggan, angka", () => {
    assert.equal(bersih('A;B_C  "D"..E'), "A.B C D.E");
    assert.equal(bersih("TOKO A , TK"), "TOKO A. TK");
    assert.equal(bersih("BAKERY A'S"), "BAKERY A'S");
    assert.equal(bersihSalesman("PRTS1_SALES A, X"), "PRTS1_SALES A. X");
    assert.equal(namaPelanggan("TOKO B {C-TKB001} (C.O.D)"), "TOKO B");
    assert.equal(kodePelanggan("C-TKC001-PT", "PT. TOKO C  {C-TKC.001}"), "C-TKC001");
    assert.equal(kodePelanggan("", "TOKO D {C-TKD001}"), "C-TKD001");
    assert.equal(alamatLengkap("JL. CONTOH 03 LR 04_ KEL. A", "KOTA A"), "JL. CONTOH 03 LR 04 KEL. A. KOTA A");
    assert.equal(angka(28.8), "28.8");
    assert.equal(angka(-0), "0");
    assert.equal(rupiah(342712.5), 342712); // pembulatan bank = contoh (INV/2609/PT00079)
    assert.equal(rupiah(2115970.5014730003), 2115971);
    assert.equal(rupiah(-912481.8), -912482);
    assert.deepEqual([periode("2026-11-02")[0], periode("2026-11-02").at(-1), periode("2026-11-02").length], ["2026-09-19", "2026-11-02", 45]);
});

test("DUMMY: tiap tanggal memuat semua SKU yang bertransaksi; gramasi kosong menghentikan", () => {
    const b = (tanggal: string, faktur: string, barang: string, qty: number, nilai: number): Baris => ({ tanggal, faktur, pelanggan: "C-1", salesman: "M-1", barang, qty, nilai });
    const h = susun({ tanggal: "2026-11-02", barang: new Map([["A1", 'X 1 PCSX5KG "1111111"'], ["B1", 'Y 10 PCSX1KG "2222222"'], ["C1", 'Z 1 PCSX1KG "3333333"']]),
        baris: [b("2026-11-02", "INV/1", "A1", 2, 1000.4), b("2026-10-01", "INV/2", "B1", 10, 50.5)], stok: new Map(),
        pelanggan: new Map([["C-1", ["TOKO {C-1}", "JL", "MKS"]]]), salesman: new Map([["M-1", "SALES"]]) });
    assert.deepEqual(h.galat, []);
    const rows = h.berkas["delivery.csv"].toString("utf8").split("\r\n").slice(1, -1);
    assert.equal(rows.length, 45 * 2);
    assert.ok(rows.includes("113;C-1;01.10.2026;B1;10;50;M-1;INV/2")); // 50.5 → 50 (pembulatan bank)
    assert.equal(rows.indexOf("113;C-1;02.11.2026;A1;10;1000;M-1;INV/1") + 1, rows.indexOf("113;C-DUMMY;02.11.2026;B1;0;0;DUMMY;0"));
    assert.equal(h.ringkasan.stocks, 3 * 45);
    const henti = susun({ tanggal: "2026-11-02", barang: new Map([["A1", 'X TANPA KEMASAN "1111111"']]), baris: [], stok: new Map(), pelanggan: new Map(), salesman: new Map() });
    assert.match(henti.galat[0], /Gramasi tidak terbaca/);
});

test("contoh 02.11.2026: data mentah dari 5 CSV contoh → susun() sama persis byte demi byte", () => {
    const contoh = JSON.parse(gunzipSync(readFileSync(new URL("./contoh-2026-11-02.json.gz", import.meta.url))).toString("utf8")) as Record<string, string>;
    const baca = (n: string) => contoh[n].replace(/^﻿/, "").split("\r\n").slice(1, -1).map((r) => r.split(";"));
    const barang = new Map<string, string>(), kg = new Map<string, number>();
    for (const [, no, desc, kode] of baca("sku.csv")) {
        barang.set(no, `${desc.replace(/ \(B\)$/, "")} "${kode}"T01`);
        kg.set(no, gramasi(desc)!);
    }
    const iso = (t: string) => t.split(".").reverse().join("-");
    const baris = baca("delivery.csv").filter((r) => r[1] !== "C-DUMMY")
        .map(([, p, t, no, q, rp, s, f]) => ({ tanggal: iso(t), faktur: f, pelanggan: p, salesman: s, barang: no, qty: Number(q) / kg.get(no)!, nilai: Number(rp) }));
    const stok = new Map(baca("stocks.csv").map(([, t, no, q]) => [`${iso(t)}|${no}`, Number(q) / kg.get(no)!]));
    const pelanggan = new Map(baca("ttoptions.csv").filter((r) => r[1] !== "C-DUMMY").map(([, k, n, a]) => [k, [n, a, ""] as [string, string, string]]));
    const salesman = new Map(baca("ta.csv").filter((r) => r[1] !== "DUMMY").map(([, k, n]) => [k, n]));
    const h = susun({ tanggal: "2026-11-02", barang, baris, stok, pelanggan, salesman });
    assert.deepEqual(h.galat, []);
    for (const n of Object.keys(contoh)) assert.equal(h.berkas[n].toString("utf8"), contoh[n], n);
    assert.deepEqual([h.ringkasan.delivery, h.ringkasan.stocks, h.ringkasan.sku, h.ringkasan.ttoptions, h.ringkasan.ta, h.ringkasan.barisAsli, h.ringkasan.stokKgD],
        [2914, 10170, 226, 155, 5, 305, 34551.6]);
});
