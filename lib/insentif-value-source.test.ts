/*
 * Self-check pemilihan kolom acuan Value per cabang.
 * Jalankan: node --experimental-strip-types lib/insentif-value-source.test.ts
 */
import assert from "node:assert";
import { valueSourceForBranch, realisasiValue } from "./insentif-value-source.ts";

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

console.log("OK insentif-value-source");
