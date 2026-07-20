/*
 * Guard aturan dedup (keputusan user 2026-07-20): bila Kode Barang principal ada, kunci = kode+isi
 * (nama diabaikan karena ekstraksi legacy sering kotor); tanpa kode, jatuh ke kunci nama lama.
 * Jalankan: npx tsx lib/master-barang/dedup.test.ts
 */
import assert from "node:assert";
import { generateMasterBarang, type SourceItem } from "@/lib/master-barang/engine";

const item = (kodePcpl: string, namaBarang: string, isiCtn: string): SourceItem =>
    ({ kodePcpl, namaBarang, isiCtn, klp: "MINUMAN", confidence: 1 });

const rows = (items: SourceItem[]) => generateMasterBarang("ABC PI", "AP", items).formRows;

// kode+isi sama, nama kotor (kasus nyata ABC PI: "ABC>" + kode nyangkut di ekor) -> gabung
const dirty = rows([
    item("BO101203", 'ABC BV NU OCEANA 330ML@24 LEMONADE "BO101203', "24"),
    item("BO101203", 'ABC> BV NU OCEANA 330ML@24 LEMONADE"BO101203', "24"),
]);
assert.strictEqual(dirty.length, 1, `nama kotor berkode sama harus gabung, dapat ${dirty.length}`);
assert.ok(dirty[0].namaBarangPrinciple.startsWith("ABC BV"), "baris pertama (nama bersih) yang bertahan");

// kode sama, isi beda -> kemasan berbeda, JANGAN gabung (kasus nyata FON isi 12 vs 120)
const packs = rows([item("10483782", "ANC BON MP CHOC 12X25G", "12"), item("10483782", "ANC BON MP CHOC 12X25G", "120")]);
assert.strictEqual(packs.length, 2, `isi berbeda harus tetap 2 baris, dapat ${packs.length}`);

// kode beda, nama sama -> SKU berbeda, JANGAN gabung (keputusan #13)
const twins = rows([item("10508320", "ANC BON MP CHOC", "120"), item("10483782", "ANC BON MP CHOC", "120")]);
assert.strictEqual(twins.length, 2, `kode berbeda harus tetap 2 baris, dapat ${twins.length}`);

// tanpa kode (master hasil OCR) -> kunci nama lama tetap berlaku
const noCode = rows([item("", "TEH KOTAK 200ML", "24"), item("", "TEH KOTAK 200ML", "24"), item("", "TEH KOTAK 300ML", "24")]);
assert.strictEqual(noCode.length, 2, `tanpa kode: nama sama gabung, nama beda tidak, dapat ${noCode.length}`);

// kirim-ulang (§9.2): hasil generate dikirim balik tidak boleh menambah/menggeser baris
const first = generateMasterBarang("ABC PI", "AP", [
    item("BO101203", 'ABC BV NU OCEANA 330ML@24 LEMONADE "BO101203', "24"),
    item("BO101601", "ABC BV NU OCEANA 460ML@24 LEMONADE", "24"),
    item("BO101601", "ABC BV NU OCEANA 460ML@24 LEMONADE", "6"),
]);
const again = generateMasterBarang("ABC PI", "AP", first.sourceItems, first.codebook);
assert.deepStrictEqual(
    again.formRows.map((r) => r.kodeBarangWin2),
    first.formRows.map((r) => r.kodeBarangWin2),
    "kirim-ulang harus stabil (baris & kode identik)",
);

// Ekspor master Win: satu KDPRC bisa dipakai dua KDBRG yang memang beda item (baris bonus "B>").
// Kode Win harus menang sebagai kunci, kalau tidak baris bonusnya hilang diam-diam.
const winPair = generateMasterBarang("KNF", "K1", [
    { kodeWin: "K1470003006510", kodePcpl: "FG11246.218.0065.P", namaBarang: "KNF SASHA PASTA WHITENING 65GR X 48 TUBE", isiCtn: "48" },
    { kodeWin: "K1470003006510B", kodePcpl: "FG11246.218.0065.P", namaBarang: "B> KNF SASHA PASTA WHITENING 65GR X 48 TUBE", isiCtn: "48" },
]);
assert.strictEqual(winPair.formRows.length, 2, `KDBRG beda harus tetap 2 baris, dapat ${winPair.formRows.length}`);

// KLP kosong pada item ber-kode Win = memang kosong; jangan ditebak dari 2 kata pertama nama
// (dulu jadi "KNF OVALE", nama principal ikut terbawa jadi KLP).
// Dua nama tanpa kata bersama di bawah satu kode KLP -> pembedah menyimpulkan KLP memang kosong.
const klpKosong = generateMasterBarang("KNF", "K1", [
    { kodeWin: "K1350001010010", namaBarang: "KNF OVALE MICELLAR WATER BRIGHTENING 100ML X 36 BTL", isiCtn: "36" },
    { kodeWin: "K1350002010010", namaBarang: "KNF RESIK V GODOKAN SIRIH 100ML X 36 BTL", isiCtn: "36" },
]);
assert.deepStrictEqual(
    klpKosong.formRows.map((r) => r.namaKlp),
    ["", ""],
    `KLP harus kosong, dapat ${JSON.stringify(klpKosong.formRows.map((r) => r.namaKlp))}`,
);

console.log("OK — dedup: kode+isi bila ada kode, kunci nama bila kode kosong, kode Win menang, kirim-ulang stabil.");
