/*
 * Regression guard: penyelaras item baru terhadap master yang sudah ada.
 * Item manual tanpa struktur harus mewarisi KLP/kemasan/isi/format-gramasi dari item
 * lama ber-batang nama sama, ekor " - X" jadi aroma dengan singkatan hasil tambang,
 * dan kode aroma lanjut dari nomor terakhir (bukan bikin KLP baru).
 * Jalankan: npx tsx lib/master-barang/aligner.test.ts (DB-free).
 */
import assert from "node:assert";
import { generateMasterBarang, type SourceItem } from "./engine";

const existing: SourceItem[] = [
    { namaBarang: "HARMONY SABUN MANDI BUAH 70 GR (NEW) - STRAWBERRY ALPINE", kelompokPcpl: "HARMONY SABUN MANDI", aroma: "STRAW ALP", gramasi: "70GR", isiCtn: 72, kemasan: "PCS" },
    { namaBarang: "HARMONY SABUN MANDI BUAH 70 GR (NEW) - ORANGE SATSUMA", kelompokPcpl: "HARMONY SABUN MANDI", aroma: "ORANGE SAT", gramasi: "70GR", isiCtn: 72, kemasan: "PCS" },
    { namaBarang: "HARMONY SABUN MANDI BUAH 70 GR (NEW) - LEMON CITRUS", kelompokPcpl: "HARMONY SABUN MANDI", aroma: "LEMON CITR", gramasi: "70GR", isiCtn: 72, kemasan: "PCS" },
];
const fresh: SourceItem = { namaBarang: "HARMONY SABUN MANDI BUAH 70 GR (NEW) - PEACH SAKURA", isiCtn: "72", gramasi: "70 GR", confidence: 1 };

const result = generateMasterBarang("MSM", "M8", [...existing, ...fresh ? [fresh] : []]);
const rows = result.formRows;
const peach = rows.find((row) => row.namaBarangPrinciple.includes("PEACH"));
assert.ok(peach, "baris PEACH SAKURA tidak ditemukan");
const donorRow = rows.find((row) => row.namaBarangPrinciple.includes("STRAWBERRY"))!;

assert.equal(peach.namaKlp, donorRow.namaKlp, "KLP harus warisan donor, bukan kelompok baru");
assert.equal(peach.kodeKlp, donorRow.kodeKlp, "kode KLP harus dipakai ulang");
assert.equal(peach.namaGramasi, donorRow.namaGramasi, "format gramasi harus ikut donor (70GR)");
assert.equal(peach.kodeGramasi, donorRow.kodeGramasi, "kode gramasi harus dipakai ulang");
assert.equal(peach.namaKemasan, donorRow.namaKemasan, "kemasan harus warisan donor");
assert.ok(peach.namaAroma.includes("PEACH"), `aroma harus dari ekor nama, dapat: ${peach.namaAroma}`);
const aromaCodes = rows.filter((row) => row.kodeKlp === donorRow.kodeKlp).map((row) => row.kodeAroma);
assert.equal(peach.kodeAroma, "04", `kode aroma harus lanjut nomor berikutnya, dapat ${peach.kodeAroma} dari ${aromaCodes.join(",")}`);
assert.ok(peach.kodeBarangWin2.startsWith(`M8${donorRow.kodeKlp}`), `kode barang harus se-struktur donor: ${peach.kodeBarangWin2}`);

// Tanpa donor (master kosong) perilaku lama tetap: tidak ada warisan, jalan seperti dulu.
const solo = generateMasterBarang("MSM", "M8", [fresh]);
assert.ok(solo.formRows.length === 1 && solo.formRows[0].namaKlp, "jalur tanpa donor tetap menghasilkan baris");

// Idempoten: penyelaras menulis format donor ("70 GR" -> "70GR") ke item tersimpan, jadi
// kiriman ulang item mentah yang sama TIDAK boleh menambah baris kembar (regresi 2026-07-19).
const again = generateMasterBarang("MSM", "M8", [...result.sourceItems, fresh]);
assert.equal(again.formRows.length, result.formRows.length, `kirim ulang item sama tidak boleh menambah baris (${again.formRows.length} vs ${result.formRows.length})`);
const kodes = again.formRows.map((row) => row.kodeBarangWin2);
assert.equal(new Set(kodes).size, kodes.length, "tidak boleh ada kode barang kembar");

console.log(`OK — penyelaras: PEACH SAKURA -> KLP "${peach.namaKlp}" aroma "${peach.namaAroma}" (kode ${peach.kodeAroma}), kode ${peach.kodeBarangWin2}, namaWin "${peach.namaWin}"`);
