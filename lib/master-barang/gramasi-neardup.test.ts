/*
 * Guard deteksi gramasi mirip: item nama sama beda gramasi <30% -> GRAMASI_NEAR_DUP (konfirmasi),
 * beda >=30% -> tidak diflag. Jalankan: npx tsx lib/master-barang/gramasi-neardup.test.ts
 */
import assert from "node:assert";
import { generateMasterBarang, type SourceItem } from "@/lib/master-barang/engine";

const item = (namaBarang: string, gramasi: string): SourceItem => ({ namaBarang, gramasi, klp: "SUSU", confidence: 1 });

// 850 vs 825 GR -> beda ~2.9% -> flag
const near = generateMasterBarang("ANLENE", "AN", [item("ANLENE GOLD", "850 GR"), item("ANLENE GOLD", "825 GR")]);
assert.strictEqual(near.qc.gramasiNearDup, 1, `850 vs 825 harus flag, dapat ${near.qc.gramasiNearDup}`);

// 75 vs 68 GR -> beda ~9.3% -> flag
const near2 = generateMasterBarang("X", "XX", [item("KOPI SASET", "75 GR"), item("KOPI SASET", "68 GR")]);
assert.strictEqual(near2.qc.gramasiNearDup, 1, `75 vs 68 harus flag, dapat ${near2.qc.gramasiNearDup}`);

// 100 vs 500 GR -> beda 80% -> TIDAK flag
const far = generateMasterBarang("Y", "YY", [item("SABUN", "100 GR"), item("SABUN", "500 GR")]);
assert.strictEqual(far.qc.gramasiNearDup, 0, `100 vs 500 tidak boleh flag, dapat ${far.qc.gramasiNearDup}`);

// gramasi sama -> bukan near-dup (itu duplikat eksak, urusan lain)
const same = generateMasterBarang("Z", "ZZ", [item("TEH", "200 GR"), item("TEH", "200 GR")]);
assert.strictEqual(same.qc.gramasiNearDup, 0, `gramasi identik bukan near-dup, dapat ${same.qc.gramasiNearDup}`);

// beda unit family (GR vs ML) -> tidak dibandingkan
const cross = generateMasterBarang("W", "WW", [item("PRODUK", "250 GR"), item("PRODUK", "255 ML")]);
assert.strictEqual(cross.qc.gramasiNearDup, 0, `beda unit family tidak dibandingkan, dapat ${cross.qc.gramasiNearDup}`);

console.log("OK — deteksi gramasi mirip: flag <30%, lolos >=30% & beda-unit & identik.");
