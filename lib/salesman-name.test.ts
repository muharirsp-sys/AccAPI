/*
 * Self-check keKodeNama: nama salesman Accurate format baru "NAMA_ KODE" (owner 20 Nov 2026) dibaca seperti format lama "KODE_NAMA".
 * Jalankan: npm test (tsx --test).
 */
import assert from "node:assert";
import { test } from "node:test";
import { keKodeNama } from "./salesman-name.ts";

test("format baru -> KODE_NAMA (pola nyata: bertingkat, berspasi, MT/MT2, SPV_, OFFICE, koma, titik)", () => {
    const pasangan: [string, string][] = [
        ["IRMAWATI_ RB3", "RB3_IRMAWATI"],
        ["HAPPY VALENDINO HENDRIK BUDI_ ABC1_MT", "ABC1_MT_HAPPY VALENDINO HENDRIK BUDI"],
        ["RISDA HARIS_ M2_5 MT", "M2_5_MT_RISDA HARIS"],
        ["BASRI YUSUF_ M2_1", "M2_1_BASRI YUSUF"],
        ["MELIZA_ KN_MT2", "KN_MT2_MELIZA"],
        ["ANDI MARYAM_ KN_MT1", "KN_MT1_ANDI MARYAM"],
        ["OFFICE_ FS_MT", "FS_MT_OFFICE"],
        ["OFFICE_ EN", "EN_OFFICE"],
        ["SYACHRULLAH, ANDI_ SPV_HEINZ", "SPV_HEINZ_SYACHRULLAH, ANDI"],
        ["SUMARTONO_ SPV", "SPV_SUMARTONO"],
        ["ANDI IRFANDI ZUBAIR, SE._ GDI8", "GDI8_ANDI IRFANDI ZUBAIR, SE."],
        ["ANDIEKA ANUGRAH HASAL_ MTRHNZ10", "MTRHNZ10_ANDIEKA ANUGRAH HASAL"],
        ["RIDWAN_ ENKV", "ENKV_RIDWAN"],
    ];
    for (const [baru, lama] of pasangan) assert.strictEqual(keKodeNama(baru), lama, baru);
});

test("format lama dan nama tanpa kode tidak berubah; huruf/spasi dirapikan", () => {
    for (const lama of ["RB3_IRMAWATI", "M2_5_MT_RISDA HARIS", "KN_MT2__MELIZA", "FS_MT_OFFICE_HRK", "SPV_SUMARTONO", "ISMAIL", "MUH. AKBAR SAGALA"]) {
        assert.strictEqual(keKodeNama(lama), lama, lama);
    }
    assert.strictEqual(keKodeNama("  tansi_   ms10 "), "MS10_TANSI");
    assert.strictEqual(keKodeNama("ms10_tansi"), "MS10_TANSI");
    assert.strictEqual(keKodeNama(null), "");
    assert.strictEqual(keKodeNama(undefined), "");
    assert.strictEqual(keKodeNama("_ RAMLAN"), "_ RAMLAN", "tanpa nama di depan = bukan format baru");
    assert.strictEqual(keKodeNama("ISMAIL_"), "ISMAIL_", "tanpa kode di belakang = bukan format baru");
});
