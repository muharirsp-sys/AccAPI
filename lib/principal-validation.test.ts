/* Kunci: setiap temuan di sini berakhir sebagai angka pada faktur, jadi tidak ada yang
   "cuma warning". Toleransi Rp 1 hanya menyerap pembulatan, bukan selisih aturan. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLine, checkSoPromo, splitDiscounts, type LineInput, type PublishedRule } from "./principal-validation.ts";

const line = (over: Partial<LineInput> = {}): LineInput => ({
    productCode: "106052", itemCode: "K1010001006010", itemExists: true,
    customerCode: "16710223162", customerNo: "C-GAL006-KN", customerExists: true,
    salesmanCode: "1671GR4102", salesmanInternal: "M-SIT",
    unit: "BTL", knownUnits: ["BTL", "KRT"],
    price: 13513.51, expectedPrice: 13513.51,
    gross: 324324.32, reportDiscount: 0, discounts: [], bonus: false,
    rules: [], ...over,
});

test("diskon bertingkat cocok dengan angka nyata Kino", () => {
    // ALFAMART 3 Sep 2026: DISC_1 4% lalu DISC_4 2,25% atas Rp 345.945,95.
    const split = splitDiscounts(345945.95, [{ position: 1, percent: 4 }, { position: 4, percent: 2.25 }]);
    assert.deepEqual(split, { distributor: 13837.84, principal: 7472.43, unowned: 0, total: 21310.27 });
    // Dijumlah rata 6,25% akan meleset dari TOTAL_DISC yang dilaporkan.
    assert.notEqual(splitDiscounts(345945.95, [{ position: 1, percent: 6.25 }]).total, 21310.27);
    // Urutan masukan tidak boleh mengubah hasil; posisi yang menentukan.
    assert.deepEqual(splitDiscounts(345945.95, [{ position: 4, percent: 2.25 }, { position: 1, percent: 4 }]).total, 21310.27);
});

test("posisi di luar 1-5 jadi diskon tak bertuan", () => {
    const split = splitDiscounts(100000, [{ position: 7, percent: 5 }]);
    assert.equal(split.unowned, 5000);
    assert.equal(split.distributor + split.principal, 0);
});

test("baris lengkap dan cocok lolos tanpa temuan", () => {
    const result = checkLine(line());
    assert.equal(result.status, "ok", result.findings.join(" | "));
});

test("selisih harga sampai Rp 1 lolos, di atas itu ditahan dua arah", () => {
    assert.equal(checkLine(line({ price: 13514.51 })).status, "ok");
    assert.equal(checkLine(line({ price: 13512.51 })).status, "ok");
    const tinggi = checkLine(line({ price: 13600 }));
    assert.equal(tinggi.status, "review");
    assert.match(tinggi.findings[0], /lebih tinggi/);
    assert.match(checkLine(line({ price: 13000 })).findings[0], /lebih rendah/);
});

test("mapping dan master yang hilang ditahan, masing-masing dengan sebabnya", () => {
    assert.match(checkLine(line({ itemCode: null })).findings[0], /belum ada di mapping/);
    assert.match(checkLine(line({ itemExists: false })).findings[0], /tidak ada di master Accurate/);
    assert.match(checkLine(line({ customerNo: null })).findings[0], /outlet .* belum ada di mapping/);
    assert.match(checkLine(line({ customerExists: false })).findings[0], /tidak ada di master Accurate/);
    assert.match(checkLine(line({ salesmanInternal: null })).findings[0], /salesman .* belum ada di mapping/);
    assert.match(checkLine(line({ expectedPrice: null })).findings[0], /Harga Accurate .* tidak ditemukan/);
    assert.match(checkLine(line({ unit: "LSN" })).findings[0], /Satuan LSN tidak ada pada daftar harga/);
});

test("klaim principal tanpa aturan terbit dan diskon tak bertuan ditahan", () => {
    const tanpaAturan = checkLine(line({ discounts: [{ position: 4, percent: 2.25 }], reportDiscount: 7297.3 }));
    assert.equal(tanpaAturan.status, "review");
    assert.match(tanpaAturan.findings.join(" "), /belum punya aturan promo terbit/);
    // Begitu aturannya terbit DAN angkanya cocok, klaim yang sama tidak lagi ditahan.
    const adaAturan = checkLine(line({
        discounts: [{ position: 4, percent: 2.25 }], reportDiscount: 7297.3,
        rules: [{ suratProgram: "BP26", promoGroup: "X", itemCode: "K1010001006010", tierNo: 1,
                  triggerQty: 0, triggerUnit: "PCS", benefitType: "DISC_PCT", benefitValue: "2.25",
                  benefitBeban: "PRINCIPAL" }],
    }));
    assert.deepEqual(adaAturan.findings, []);

    const liar = checkLine(line({ discounts: [{ position: 7, percent: 5 }], reportDiscount: 16216.22 }));
    assert.match(liar.findings.join(" "), /tak bertuan .* DISC_7/);
});

test("total diskon kami harus sama dengan laporan principal", () => {
    const beda = checkLine(line({ discounts: [{ position: 1, percent: 4 }], reportDiscount: 0 }));
    assert.match(beda.findings.join(" "), /berbeda dari laporan principal/);
    const sama = checkLine(line({ discounts: [{ position: 1, percent: 4 }], reportDiscount: 12972.97 }));
    assert.equal(sama.findings.filter((f) => f.includes("berbeda dari laporan")).length, 0, sama.findings.join(" | "));
});

test("baris bonus tetap diperiksa harganya", () => {
    const bonus = checkLine(line({ bonus: true, price: 99999, discounts: [{ position: 1, percent: 100 }], reportDiscount: 324324.32 }));
    assert.equal(bonus.status, "review");
    assert.match(bonus.findings.join(" "), /Harga laporan/);
});

test("toleransi harga berlaku pada satuan terkecil, bukan pada harga karton", () => {
    // Angka nyata 11 Sep 2026, item K1351003030010: Accurate menyimpan BTL 29.189 (bulat) dan
    // KRT 700.536 = 29.189 x 24, sedangkan laporan Kino membawa DPP 29.189,1892 (32.400/1,11).
    // Beda Rp 0,19 per botol menjadi Rp 4,54 per karton — pembulatan yang sama, dikali ISI.
    const karton = line({ unit: "KRT", knownUnits: ["BTL", "KRT"], price: 700540.5408, expectedPrice: 700536, unitRatio: 24 });
    assert.deepEqual(checkLine(karton).findings, []);

    // Tanpa ISI, selisih yang sama persis tetap ditahan: itu memang di atas Rp 1 per satuan.
    assert.match(checkLine({ ...karton, unitRatio: 1 }).findings[0], /berbeda lebih tinggi/);

    // Salah harga yang sungguhan (Rp 500 per botol = Rp 12.000 per karton) tetap tertahan.
    const salah = checkLine(line({ unit: "KRT", price: 712536, expectedPrice: 700536, unitRatio: 24 }));
    assert.match(salah.findings[0], /setara 500 per satuan terkecil dari 24/);
});

const aturan = (over: Partial<PublishedRule> = {}): PublishedRule => ({
    suratProgram: "BP2609007909", promoGroup: "SLEEK BABY BABY BOTTLE NIPPLE",
    itemCode: "K1010001006010", tierNo: 1, triggerQty: 0, triggerUnit: "PCS",
    benefitType: "DISC_PCT", benefitValue: "3", benefitBeban: "PRINCIPAL", ...over,
});

test("klaim principal yang COCOK aturan terbit tidak lagi ditahan", () => {
    // Kasus nyata 12 Sep 2026, SO 1671-SOP-260013044: 3% di posisi 4 atas barang yang memang
    // masuk BP2609007909. Sebelum perbaikan ini gerbang menahannya karena tidak pernah membaca
    // aturan terbit sama sekali — gerbang yang menahan segalanya sama tidak bergunanya dengan
    // gerbang yang meloloskan segalanya.
    const hasil = checkLine(line({
        discounts: [{ position: 4, percent: 3 }], reportDiscount: 9729.73, rules: [aturan()],
    }));
    assert.equal(hasil.status, "ok");
    assert.deepEqual(hasil.findings, []);
    assert.equal(hasil.split.principal, 9729.73);
});

test("klaim principal yang BEDA dari aturan terbit tetap ditahan, dengan angkanya disebut", () => {
    const hasil = checkLine(line({
        discounts: [{ position: 4, percent: 5 }], reportDiscount: 16216.22, rules: [aturan()],
    }));
    assert.equal(hasil.status, "review");
    assert.ok(hasil.findings.some((f) => f.includes("5%") && f.includes("3%")));
});

test("klaim principal tanpa aturan terbit tetap uang yang tidak bisa dipertanggungjawabkan", () => {
    const hasil = checkLine(line({ discounts: [{ position: 4, percent: 3 }], reportDiscount: 9729.73 }));
    assert.ok(hasil.findings.some((f) => f.includes("belum punya aturan promo terbit")));
});

test("diskon distributor tidak pernah butuh aturan terbit", () => {
    // SS DIAPERS 12 Sep 2026: 2% di posisi 1. Itu tanggungan kita sendiri (Satu Sama Group),
    // bukan klaim ke principal, jadi tidak ada yang perlu dijelaskan surat program.
    const hasil = checkLine(line({ discounts: [{ position: 1, percent: 2 }], reportDiscount: 6486.49 }));
    assert.equal(hasil.status, "ok");
    assert.equal(hasil.split.distributor, 6486.49);
    assert.equal(hasil.split.principal, 0);
});

const msg = (over: Partial<PublishedRule> = {}): PublishedRule => ({
    suratProgram: "BP2609006016", promoGroup: "ALL BRAND HPC", itemCode: "",
    tierNo: 1, triggerQty: 1_000_000, triggerUnit: "RP",
    benefitType: "DISC_RP", benefitValue: "20000", benefitBeban: "PRINCIPAL", ...over,
});

test("potongan tingkat faktur (MSG) dicocokkan se-SO, dengan PPN dikembalikan", () => {
    // Kasus nyata RISKA TK 12 Sep 2026: bruto 1.198.378 melampaui ambang Rp 1 juta -> tier 1
    // Rp 20.000. Laporan membawa DPP 18.016,22; 18.016,22 x 1,11 = 19.998 — beda Rp 2 saja.
    const verdict = checkSoPromo({ gross: 1_198_378, principalClaim: 18_016.22, lineCount: 18 },
        [msg(), msg({ tierNo: 2, triggerQty: 2_000_000, benefitValue: "40000" })]);
    assert.match(verdict.explained, /BP2609006016 tier 1/);
    assert.deepEqual(verdict.findings, []);
});

test("MSG: tier yang diambil adalah yang TERTINGGI yang ambangnya terlampaui", () => {
    const verdict = checkSoPromo({ gross: 2_500_000, principalClaim: 36_036.04, lineCount: 10 },
        [msg(), msg({ tierNo: 2, triggerQty: 2_000_000, benefitValue: "40000" })]);
    assert.match(verdict.explained, /tier 2/);
});

test("MSG: nominal yang tidak sesuai tier tetap ditahan", () => {
    const verdict = checkSoPromo({ gross: 1_198_378, principalClaim: 45_000, lineCount: 18 }, [msg()]);
    assert.equal(verdict.explained, "");
    assert.ok(verdict.findings[0].includes("20.000"));
});

test("MSG: belanja di bawah ambang tidak menjelaskan apa pun", () => {
    const verdict = checkSoPromo({ gross: 500_000, principalClaim: 9_000, lineCount: 5 }, [msg()]);
    assert.equal(verdict.explained, "");
    assert.deepEqual(verdict.findings, []);
});

test("baris yang klaimnya dijelaskan MSG tidak perlu punya aturan barangnya sendiri", () => {
    // 7 barang ESK Cologne pada SO RISKA sama sekali tidak masuk program mana pun, tetapi
    // ikut kebagian potongan faktur yang dibagi rata. Memeriksanya per barang akan menuduh
    // baris yang sebenarnya benar.
    const hasil = checkLine(line({
        discounts: [{ position: 5, percent: 1.5033, amount: 4875.45 }],
        reportDiscount: 4875.45, gross: 324324.32, fakturPromo: "BP2609006016 tier 1",
    }));
    assert.equal(hasil.status, "ok");
});

