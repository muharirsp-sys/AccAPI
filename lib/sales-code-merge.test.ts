/*
 * Self-check deteksi kandidat merge kode sales.
 * Jalankan: node --experimental-strip-types lib/sales-code-merge.test.ts
 */
import assert from "node:assert";
import { namePrefix, personName, groupByPrefix, groupByPerson, mergeCandidates, applyMergeMap } from "./sales-code-merge.ts";

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

// --- nama orang: prefiks rute dibuang ---
assert.strictEqual(personName("FRN5_BASRI YUSUF"), "BASRI YUSUF", "FRN5 dibuang");
assert.strictEqual(personName("M2_1_BASRI YUSUF"), "BASRI YUSUF", "M2_1 dibuang — orang yang sama");
assert.strictEqual(personName("GDI3_MT_DINI PRATIWI"), "DINI PRATIWI", "penanda MT ikut dibuang");
assert.strictEqual(personName("MS10_TANSI"), "TANSI", "prefiks tanpa tingkat");
assert.strictEqual(personName("HEINZ13_SAENAL"), "SAENAL", "prefiks berhuruf panjang");
assert.strictEqual(personName("CS5_JUSNIATI"), "JUSNIATI", "CS5");
// bukan orang
assert.strictEqual(personName("EN_OFFICE"), null, "OFFICE bukan orang");
assert.strictEqual(personName("FRN_OFFICE"), null, "FRN_OFFICE bukan orang");
assert.strictEqual(personName("TANPAGARIS"), null, "tanpa underscore → null");
assert.strictEqual(personName(""), null, "kosong → null");

// --- kasus nyata Juli 2026: satu orang, dua rute, prefiks BEDA ---
// groupByPrefix buta terhadap ini; itulah sebabnya Rp 271,5 jt BASRI tidak berinsentif.
{
    const pasangan = [
        { salesCode: "M-BSR", salesName: "M2_1_BASRI YUSUF" },
        { salesCode: "M-BSR2", salesName: "FRN5_BASRI YUSUF" },
    ];
    assert.strictEqual(groupByPrefix(pasangan).length, 0, "prefiks beda → tidak terdeteksi (bug lama)");
    const g = groupByPerson(pasangan);
    assert.strictEqual(g.length, 1, "nama sama → terdeteksi");
    assert.strictEqual(g[0].prefix, "BASRI YUSUF", "label kelompok = nama orang");
    assert.deepStrictEqual(g[0].members.map((m) => m.salesCode), ["M-BSR", "M-BSR2"], "dua kode terkumpul");
}

// --- JUSNIATI: arah prefiksnya terbalik, tetap harus tertangkap ---
{
    const g = groupByPerson([
        { salesCode: "M-JUS", salesName: "FRN5_JUSNIATI" },
        { salesCode: "M-JUS2", salesName: "M2_1_JUSNIATI" },
    ]);
    assert.strictEqual(g.length, 1, "JUSNIATI terdeteksi");
}

// --- gabungan: kelompok yang anggotanya identik tidak muncul dua kali ---
{
    // MS10 kolisi prefiks (dua ORANG berbeda) + BASRI kolisi nama (dua RUTE satu orang)
    const semua = mergeCandidates([
        { salesCode: "M-ISK", salesName: "MS10_ISMAIL KADIR" },
        { salesCode: "M-TNS", salesName: "MS10_TANSI" },
        { salesCode: "M-BSR", salesName: "M2_1_BASRI YUSUF" },
        { salesCode: "M-BSR2", salesName: "FRN5_BASRI YUSUF" },
    ]);
    assert.strictEqual(semua.length, 2, "dua kelompok: MS10 dan BASRI YUSUF");
    assert.deepStrictEqual(semua.map((g) => g.prefix).sort(), ["BASRI YUSUF", "MS10"], "label keduanya");
}
{
    // prefiks sama DAN nama sama → satu kelompok saja, bukan dua
    const semua = mergeCandidates([
        { salesCode: "M-A", salesName: "MS10_TANSI" },
        { salesCode: "M-B", salesName: "MS10_TANSI" },
    ]);
    assert.strictEqual(semua.length, 1, "anggota identik tidak ditanya dua kali");
}

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
