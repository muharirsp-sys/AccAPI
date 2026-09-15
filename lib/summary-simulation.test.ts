/* Kunci: simulasi ini yang dilihat orang SEBELUM ia menyatakan "program ini sudah benar dan bisa
   berjalan". Simulasi yang berbohong lebih buruk daripada tidak punya simulasi sama sekali — ia
   membuat orang menandatangani sesuatu dengan percaya diri yang tidak punya dasar. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateLetter, type TrialLine } from "./summary-simulation.ts";
import type { PublishedLetter, SummaryProgram } from "./summary-bridge.ts";

const program = (over: Partial<SummaryProgram> = {}): SummaryProgram => ({
    id: "row-1-1", name: "DISKON B&B", start: "2026-10-01", end: "2026-10-31",
    codes: ["K1041101030010", "K1090003005010"], channel: "ALL",
    outlet_mode: "all", outlet_classes: [], unit: "PCS", mix: false,
    threshold: "quantity", value_scope: "eligible", basis: "gross", stacking: false, priority: 1,
    tiers: [{ minimum: "1", percentages: ["3"] }],
    source_page: 1, source_quote: "DISKON 3% ON FAKTUR", ...over,
});

const letter = (over: Partial<PublishedLetter> = {}): PublishedLetter => ({
    draftId: "0c70be12-0000-0000-0000-00000000000a", principal: "KINO NON FOOD",
    suratProgram: "BP2610001234", promoLabel: "PROMO OKTOBER", promoGroup: "B&B ALL VARIANT",
    programs: [program()], itemNames: {},
    settlement: "on_invoice", beban: "PRINCIPAL", outletCodes: [], ...over,
});

const line = (over: Partial<TrialLine> = {}): TrialLine => ({
    soNo: "SO-1", itemCode: "K1041101030010", quantity: 24, gross: 172_972.97,
    discounts: [{ position: 4, percent: 3 }], ...over,
});

test("pertanyaan 1: surat ini jadi aturan apa saja", () => {
    const hasil = simulateLetter(letter());
    assert.equal(hasil.ok, true);
    assert.equal(hasil.ruleCount, 2, "dua barang, satu strata");
    assert.equal(hasil.groups.length, 1, "bentuk yang sama dikelompokkan supaya bisa dibaca mata");
    assert.deepEqual(hasil.groups[0].itemCodes, ["K1041101030010", "K1090003005010"]);
    assert.equal(hasil.groups[0].benefitValue, "3");
    assert.equal(hasil.groups[0].periodStart, "2026-10-01");
});

test("pertanyaan 2: yang tidak terbaca disebut, bukan didiamkan", () => {
    // Rafaksi tidak memotong faktur sama sekali.
    const rafaksi = simulateLetter(letter({ settlement: "rafaksi" }));
    assert.equal(rafaksi.ok, false);
    assert.equal(rafaksi.ruleCount, 0);
    assert.equal(rafaksi.refused.length, 1);
    assert.match(rafaksi.warnings[0], /TIDAK menghasilkan satu aturan pun/);
});

test("pertanyaan 3: diadu dengan faktur nyata, dan yang cocok dihitung cocok", () => {
    const hasil = simulateLetter(letter(), [line(), line({ soNo: "SO-2", itemCode: "K1090003005010" })]);
    assert.equal(hasil.trial.lines, 2);
    assert.equal(hasil.trial.explained, 2);
    assert.deepEqual(hasil.trial.unexplained, []);
});

test("potongan yang persennya beda dilaporkan beserta sebabnya, bukan cuma dihitung", () => {
    const hasil = simulateLetter(letter(), [line({ discounts: [{ position: 4, percent: 5 }] })]);
    assert.equal(hasil.trial.explained, 0);
    assert.equal(hasil.trial.unexplained.length, 1);
    assert.match(hasil.trial.unexplained[0].reason, /tidak sama dengan aturan surat ini/);
    assert.match(hasil.warnings.join(" "), /TIDAK dijelaskan aturan ini/);
});

test("potongan di posisi DISTRIBUTOR tidak disahkan aturan berbeban PRINCIPAL", () => {
    // Posisi menyatakan siapa yang DIMAKSUD menanggung; aturan menyatakan apakah maksud itu sah.
    const hasil = simulateLetter(letter(), [line({ discounts: [{ position: 1, percent: 3 }] })]);
    assert.equal(hasil.trial.explained, 0);
    assert.equal(hasil.trial.unexplained.length, 1);
});

test("ambang diuji dengan cara yang SAMA dengan gerbangnya: per SO, per kelompok", () => {
    const surat = letter({ programs: [program({ tiers: [{ minimum: "30", percentages: ["3"] }] })] });

    // Satu SO, dua varian satu kelompok: 20 + 15 = 35, memenuhi ambang 30 walau tidak satu pun
    // mencapainya sendiri. Kalau simulasi menghitung per baris, ia akan menakut-nakuti tanpa dasar.
    const cukup = simulateLetter(surat, [
        line({ soNo: "SO-9", quantity: 20 }),
        line({ soNo: "SO-9", itemCode: "K1090003005010", quantity: 15 }),
    ]);
    assert.equal(cukup.trial.explained, 2);

    // SO lain yang belanjanya kurang tetap tertahan, dengan angka sebenarnya di kalimatnya.
    const kurang = simulateLetter(surat, [line({ soNo: "SO-8", quantity: 5 })]);
    assert.equal(kurang.trial.explained, 0);
    assert.match(kurang.trial.unexplained[0].reason, /5 PCS, belum mencapai ambang 30 PCS/);
});

test("baris tanpa potongan dihitung terpisah, bukan dianggap gagal", () => {
    // Barangnya memang disebut surat, tetapi fakturnya tidak memberi potongan apa pun. Itu bukan
    // kesalahan siapa-siapa, dan melaporkannya sebagai "tidak dijelaskan" akan mengubur yang nyata.
    const hasil = simulateLetter(letter(), [line({ discounts: [] }), line({ soNo: "SO-3" })]);
    assert.equal(hasil.trial.noDiscount, 1);
    assert.equal(hasil.trial.explained, 1);
    assert.deepEqual(hasil.trial.unexplained, []);
});

test("tanpa baris uji, simulasi MENGAKU pertanyaan ketiga belum terjawab", () => {
    // Diam soal ini akan membuat orang mengira aturannya sudah terbukti atas data sungguhan.
    const hasil = simulateLetter(letter());
    assert.match(hasil.warnings.join(" "), /yang terbukti baru bentuk aturannya/);
});

test("ambang bersatuan KRT diperingatkan SEBELUM diterbitkan, bukan setelah faktur tertahan", () => {
    const hasil = simulateLetter(letter({
        programs: [program({ unit: "KRT", tiers: [{ minimum: "5", percentages: ["3"] }] })],
    }));
    assert.match(hasil.warnings.join(" "), /satuan terkecil \(PCS\)/);
});
