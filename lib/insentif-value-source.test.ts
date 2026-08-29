/*
 * Self-check pemilihan kolom acuan Value per cabang.
 * Jalankan: node --experimental-strip-types lib/insentif-value-source.test.ts
 */
import assert from "node:assert";
import { valueSourceForBranch, realisasiValue, DEFAULT_BRANCH_NILAI_JUAL } from "./insentif-value-source.ts";

// --- empat cabang yang pakai NILAI_JUAL ---
for (const b of ["VINDA", "KINO NON FOOD", "MIX NON FOOD", "ABC"]) {
    assert.strictEqual(valueSourceForBranch(b), "nilai_jual", `${b} pakai NILAI_JUAL`);
}
// --- sisanya pakai DPP ---
for (const b of ["CUSSONS", "ENERGIZER", "FORISA", "FORISA - MT", "MOTASA", "PURATOS", "SHINZUI", "MIX FOOD", "GODREJ"]) {
    assert.strictEqual(valueSourceForBranch(b), "dpp", `${b} pakai DPP`);
}

// --- MIX FOOD (ADNAN) TIDAK sama dengan MIX NON FOOD — jangan tertukar ---
assert.strictEqual(valueSourceForBranch("MIX FOOD"), "dpp", "MIX FOOD tetap DPP");
assert.strictEqual(valueSourceForBranch("MIX NON FOOD"), "nilai_jual", "MIX NON FOOD pakai NILAI_JUAL");
// --- KINO NON FOOD vs KINO biasa ---
assert.strictEqual(valueSourceForBranch("KINO"), "dpp", "KINO tanpa NON FOOD tetap DPP");
// --- selisih besar BUKAN alasan masuk daftar (keputusan user 2026-08-29) ---
assert.strictEqual(valueSourceForBranch("HEINZ"), "dpp", "HEINZ tetap DPP walau selisih 19,2%");
assert.strictEqual(valueSourceForBranch("MONTISS"), "dpp", "MONTISS tetap DPP walau selisih 17,5%");
// --- ejaan ABC, bukan ABCPI ---
assert.strictEqual(valueSourceForBranch("ABC"), "nilai_jual", "ABC pakai NILAI_JUAL");
assert.strictEqual(valueSourceForBranch("ABCPI"), "dpp", "ABCPI bukan ejaan di file closing");

// --- toleran huruf kecil, spasi berlebih, spasi ganda ---
assert.strictEqual(valueSourceForBranch("  vinda "), "nilai_jual", "case & spasi");
assert.strictEqual(valueSourceForBranch("Mix  Non   Food"), "nilai_jual", "spasi ganda");

// --- cabang kosong / tak dikenal → DPP (default aman, tidak melebihkan realisasi) ---
assert.strictEqual(valueSourceForBranch(""), "dpp", "kosong → DPP");
assert.strictEqual(valueSourceForBranch("PRINCIPAL BARU"), "dpp", "tak dikenal → DPP");

// --- realisasiValue memilih angka yang benar ---
assert.strictEqual(realisasiValue("VINDA", 100, 123), 123, "VINDA ambil nilai jual");
assert.strictEqual(realisasiValue("ABC", 100, 123), 123, "ABC ambil nilai jual");
assert.strictEqual(realisasiValue("HEINZ", 100, 123), 100, "HEINZ ambil DPP");
// retur bernilai negatif harus lewat apa adanya, tidak dibalik tandanya
assert.strictEqual(realisasiValue("VINDA", -100, -123), -123, "retur VINDA tetap negatif");
assert.strictEqual(realisasiValue("ABC", -100, -123), -123, "retur ABC tetap negatif");

// --- daftar dapat diganti dari setelan (app_setting), bukan cuma bawaan ---
{
    const daftar = ["HEINZ", "MONTISS"];
    assert.strictEqual(valueSourceForBranch("HEINZ", daftar), "nilai_jual", "daftar kustom dipakai");
    // Bawaan TIDAK ikut menempel: mengosongkan ABC dari daftar berarti ABC kembali DPP.
    assert.strictEqual(valueSourceForBranch("ABC", daftar), "dpp", "bawaan tidak diam-diam ditambahkan");
    assert.strictEqual(realisasiValue("HEINZ", 100, 123, daftar), 123, "realisasiValue ikut daftar");
    // Normalisasi berlaku pada ISI daftar juga, bukan cuma pada argumen cabang — setelan
    // diketik manusia, jadi "  mix  non food " harus tetap cocok.
    assert.strictEqual(valueSourceForBranch("MIX NON FOOD", ["  mix  non food "]), "nilai_jual", "isi daftar dinormalisasi");
}
// Daftar KOSONG berarti semuanya DPP — keputusan yang sah, bukan alasan jatuh ke bawaan.
assert.strictEqual(valueSourceForBranch("VINDA", []), "dpp", "daftar kosong = semua DPP");
// Tanpa argumen tetap memakai bawaan yang sama dengan konstanta yang diekspor.
assert.deepStrictEqual([...DEFAULT_BRANCH_NILAI_JUAL], ["VINDA", "KINO NON FOOD", "MIX NON FOOD", "ABC"], "isi bawaan");

console.log("OK insentif-value-source");
