/*
 * Self-check deteksi kandidat merge kode sales.
 * Jalankan: node --experimental-strip-types lib/sales-code-merge.test.ts
 */
import assert from "node:assert";
import { namePrefix, groupByPrefix, applyMergeMap } from "./sales-code-merge.ts";

// --- prefiks: pola nyata dari file closing ---
assert.strictEqual(namePrefix("MS10_TANSI"), "MS10", "MS10");
assert.strictEqual(namePrefix("KN2_IRDAWATI ALIM"), "KN2", "KN2");
assert.strictEqual(namePrefix("M2_5_MT_YUANITA VIRNI KUSUMA"), "M2_5", "M2_5 (bertingkat)");
assert.strictEqual(namePrefix("M2_1_BASRI YUSUF"), "M2_1", "M2_1");
assert.strictEqual(namePrefix("FS1_MT_SYAHRUL RAMADAN"), "FS1", "penanda MT bukan bagian prefiks");
assert.strictEqual(namePrefix("ABC1_MT_NURWANTY"), "ABC1", "ABC1");
// tanpa angka → bukan pola prefiks rute
assert.strictEqual(namePrefix("SPV_SUMARTONO"), null, "SPV bukan prefiks rute");
assert.strictEqual(namePrefix("EN_OFFICE"), null, "OFFICE tanpa angka → null");
assert.strictEqual(namePrefix(""), null, "kosong → null");

// --- MS10 kolisi nyata: ISMAIL KADIR vs TANSI ---
{
    const g = groupByPrefix([
        { salesCode: "M-ISK", salesName: "MS10_ISMAIL KADIR" },
        { salesCode: "M-TNS", salesName: "MS10_TANSI" },
        { salesCode: "M-LKM", salesName: "MS1_LUKMAN" }, // tunggal → bukan kandidat
    ]);
    assert.strictEqual(g.length, 1, "cuma MS10 jadi kandidat");
    assert.strictEqual(g[0].prefix, "MS10", "prefix MS10");
    assert.deepStrictEqual(g[0].members.map((m) => m.salesCode), ["M-ISK", "M-TNS"], "dua anggota terurut");
}

// --- kode sama muncul berkali-kali (banyak principal) tidak jadi duplikat ---
{
    const g = groupByPrefix([
        { salesCode: "M-BSR", salesName: "M2_1_BASRI YUSUF" },
        { salesCode: "M-BSR", salesName: "M2_1_BASRI YUSUF" },
        { salesCode: "M-MAW", salesName: "M2_1_MAWARDHI RAHMAN" },
    ]);
    assert.strictEqual(g[0].members.length, 2, "kode duplikat dihitung sekali");
}

// --- GT vs MT prefiks sama TETAP muncul sebagai kandidat (biar user bisa menolak sadar) ---
{
    const g = groupByPrefix([
        { salesCode: "M-GTO", salesName: "FS1_GITO ADAM SAPUTRA" },
        { salesCode: "M-SRD", salesName: "FS1_MT_SYAHRUL RAMADAN" },
    ]);
    assert.strictEqual(g.length, 1, "FS1 GT+MT tetap jadi kandidat konfirmasi");
}

// --- tidak ada kolisi → tidak ada kandidat ---
assert.strictEqual(groupByPrefix([{ salesCode: "M-LKM", salesName: "MS1_LUKMAN" }]).length, 0, "tunggal → kosong");

// --- peta merge: langsung, berantai, tanpa aturan, dan siklus tidak menggantung ---
assert.strictEqual(applyMergeMap("M-ISK", new Map([["M-ISK", "M-TNS"]])), "M-TNS", "merge langsung");
assert.strictEqual(applyMergeMap("A", new Map([["A", "B"], ["B", "C"]])), "C", "merge berantai");
assert.strictEqual(applyMergeMap("M-LKM", new Map()), "M-LKM", "tanpa aturan → kode asli");
assert.strictEqual(applyMergeMap("A", new Map([["A", "A"]])), "A", "self-map aman");
{
    const cyc = new Map([["A", "B"], ["B", "A"]]);
    const r = applyMergeMap("A", cyc);
    assert.ok(r === "A" || r === "B", "siklus berhenti, tidak hang");
}

console.log("OK sales-code-merge");
