/*
 * Guard pembedah kode+nama: kerangka dari kode, label dari nama, dan TIDAK ADA KATA YANG HILANG
 * (hasil bedah harus bisa menyusun ulang nama aslinya).
 * Jalankan: npx tsx lib/master-barang/breakdown.test.ts
 */
import assert from "node:assert";
import { breakdownByCode, isWinCode, type BreakdownResult } from "@/lib/master-barang/breakdown";
import { generateMasterBarang } from "@/lib/master-barang/engine";

const rebuild = (r: BreakdownResult, pcpl: string) =>
    [pcpl, r.klp, r.subKlp, r.subKlp2, r.aroma, r.gramasi, r.isiCtn ? "X" : "", r.isiCtn, r.kemasan]
        .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

// Batas KLP/aroma disimpulkan lintas baris: 3 baris ber-KLP 01 tapi beda kode aroma
// -> awalan bersama "ABSOLUTE" = KLP, sisanya aroma.
const knf = [
    { kode: "K1010001006010", nama: "KNF ABSOLUTE CHAMOMILE 60ML X 36 BTL" },
    { kode: "K1010001015010", nama: "KNF ABSOLUTE CHAMOMILE 150ML X 36 BTL" },
    { kode: "K1010002006010", nama: "KNF ABSOLUTE ETERNITY 60ML X 36 BTL" },
];
const out = breakdownByCode(knf, "KNF");
assert.strictEqual(out[0].klp, "ABSOLUTE");
assert.strictEqual(out[0].aroma, "CHAMOMILE");
assert.strictEqual(out[0].gramasi, "60ML");
assert.strictEqual(out[0].isiCtn, "36");
assert.strictEqual(out[0].kemasan, "BTL");
assert.strictEqual(out[2].aroma, "ETERNITY");
knf.forEach((item, i) => assert.strictEqual(rebuild(out[i], "KNF"), item.nama, `rekonstruksi baris ${i}`));

// Sub KLP terpakai (segmen sub != 0) -> label ikut terpisah, bukan menempel di KLP.
const sub = breakdownByCode([
    { kode: "K1046007001010", nama: "KNF B&B SHAMPOO JUSTICE LEAGUE 10ML X 24 AMP" },
    { kode: "K1046008001010", nama: "KNF B&B SHAMPOO BATMAN 10ML X 24 AMP" },
    { kode: "K1041001001010", nama: "KNF B&B LOTION ROSE 10ML X 24 AMP" },
], "KNF");
assert.strictEqual(sub[0].klp, "B&B");
assert.strictEqual(sub[0].subKlp, "SHAMPOO");
assert.strictEqual(sub[0].aroma, "JUSTICE LEAGUE");
assert.strictEqual(sub[2].subKlp, "LOTION");

// Kemasan tidak boleh bocor ke aroma (regresi nyata: "STRAWBERRY JRG").
const jrg = breakdownByCode([
    { kode: "K1480003100420", nama: "KNF SLEEK HAND WASH STRAWBERRY 4L X 4 JRG" },
    { kode: "K1480001050010", nama: "KNF SLEEK HAND WASH APPLE 500ML X 12 BTL" },
], "KNF");
assert.strictEqual(jrg[0].aroma, "STRAWBERRY");
assert.strictEqual(jrg[0].gramasi, "4L");
assert.strictEqual(jrg[0].kemasan, "JRG");

// Kode aroma "00" = baris ini tanpa aroma; sisa kata milik KLP, bukan dipaksa jadi aroma.
const noAroma = breakdownByCode([
    { kode: "K1370000005010", nama: "KNF RESIK V MANJAKANI 50ML X 72 BTL" },
    { kode: "K1370001005010", nama: "KNF RESIK V SIRIH 50ML X 72 BTL" },
], "KNF");
assert.strictEqual(noAroma[0].klp, "RESIK V MANJAKANI");
assert.strictEqual(noAroma[0].aroma, "");
assert.strictEqual(noAroma[1].aroma, "SIRIH");

// Produk tanpa gramasi (bulu mata) tetap dapat isi & kemasan.
const noGram = breakdownByCode([
    { kode: "K1520001000010", nama: "KNF ABSTRACT EYELASH F01 VIBRANT X 100 BOX" },
    { kode: "K1520002000010", nama: "KNF ABSTRACT EYELASH F02 EXOTIC X 100 BOX" },
], "KNF");
assert.strictEqual(noGram[0].klp, "ABSTRACT EYELASH");
assert.strictEqual(noGram[0].gramasi, "");
assert.strictEqual(noGram[0].isiCtn, "100");
assert.strictEqual(noGram[0].kemasan, "BOX");

// Kode bukan kode Win -> jangan dibedah diam-diam, beri catatan.
const bukan = breakdownByCode([{ kode: "FG10101.470.0060.C", nama: "ABS CHAMOMILE 60ML" }], "KNF");
assert.ok(bukan[0].notes.some((n) => n.includes("bukan Kode Barang Win")), "kode non-Win harus bercatatan");
assert.strictEqual(isWinCode("K1010001006010"), true, "14 digit sah");
assert.strictEqual(isWinCode("K10100010060100"), true, "15 digit (dengan revisi) sah");
assert.strictEqual(isWinCode("FG10101.470.0060.C"), false);

// Integrasi ke engine: item ber-kode Win yang SUDAH punya label struktur tidak boleh ditambal
// sebagian — dulu ini bikin kata dobel ("KECAP MANIS" + aroma "MANIS PCH"). Isi & kemasan tetap
// boleh diisi karena bukan bagian dari label.
const campur = generateMasterBarang("HEINZ", "H1", [
    { kodePcpl: "H1010001006210", namaBarang: "HEINZ KECAP MANIS PCH 62GR X 48 PCH", klp: "KECAP MANIS", gramasi: "62GR" },
    { kodePcpl: "H1010002006210", namaBarang: "HEINZ KECAP ASIN PCH 62GR X 48 PCH", klp: "KECAP ASIN", gramasi: "62GR" },
]);
const kataDobel = (s: string) => s.split(" ").some((w, i, all) => i > 0 && w === all[i - 1]);
assert.ok(!kataDobel(campur.formRows[0].namaWin), `kata dobel: ${campur.formRows[0].namaWin}`);
assert.strictEqual(campur.formRows[0].isiCtn, "48", "isi tetap dipanen dari nama");

// "X" menempel di nama sumber: "200G X12 JAR" dan "48MLX36 BTL" harus tetap terbaca isi & kemasan.
const nempel = breakdownByCode([
    { kode: "K1080001020010", nama: "KNF ELLIPS HAIR MASK VIT. H.TREATMENT 200G X12 JAR" },
    { kode: "K1080002020010", nama: "KNF ELLIPS HAIR MASK VIT. NUTRI COLOR 200G X12 JAR" },
], "KNF");
assert.strictEqual(nempel[0].isiCtn, "12", `isi dari "X12", dapat "${nempel[0].isiCtn}"`);
assert.strictEqual(nempel[0].kemasan, "JAR");
assert.strictEqual(nempel[0].gramasi, "200G");

const nempel2 = breakdownByCode([
    { kode: "K1103001004810", nama: "KNF ELLIPS HAIR SERUM ULTRA TREATMENT 48MLX36 BTL" },
    { kode: "K1103002004810", nama: "KNF ELLIPS HAIR SERUM HAIR REPAIR 48MLX36 BTL" },
], "KNF");
assert.strictEqual(nempel2[0].gramasi, "48ML");
assert.strictEqual(nempel2[0].isiCtn, "36");
assert.strictEqual(nempel2[0].kemasan, "BTL");

// Notasi isi bertingkat di tengah nama tidak boleh ikut dipecah.
const bertingkat = breakdownByCode([{ kode: "D1010001003010", nama: "DOLPHIN GARIBON COOL MINT BOX 20X10X30GR X 200 BOX" }], "DOLPHIN");
assert.strictEqual(bertingkat[0].isiCtn, "200", `dapat "${bertingkat[0].isiCtn}"`);

assert.strictEqual(isWinCode("K1111002005010B"), true, "digit ke-15 boleh huruf");

console.log("OK — bedah kode+nama: label lintas baris, kemasan tak bocor, rekonstruksi utuh, X menempel & kode berakhiran huruf terbaca.");

// Sampah ekstraksi menempel di depan ("B>KNF ...") dibuang, bukan bikin baris ini merusak
// kesimpulan awalan sekelompoknya.
const sampah = breakdownByCode([
    { kode: "K1111001005010", nama: "KNF ESKULIN COLOGNE ROMANTIC PURPLE 50ML X 36 BTL" },
    { kode: "K1111003005010B", nama: "B>KNF ESKULIN COLOGNE ADORABEL PINK 50ML X 36 BTL" },
    { kode: "K1112001003010", nama: "KNF ESKULIN EDP MIDNIGHT BLOOM 30ML X 36 BTL" },
], "KNF");
assert.strictEqual(sampah[1].klp, "ESKULIN", `dapat "${sampah[1].klp}"`);
assert.strictEqual(sampah[1].subKlp, "COLOGNE");
assert.strictEqual(sampah[1].aroma, "ADORABEL PINK");
assert.strictEqual(sampah[0].klp, "ESKULIN", "baris bersih tidak ikut rusak");
