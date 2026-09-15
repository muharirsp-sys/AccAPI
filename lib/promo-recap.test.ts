/* Kunci: rekap ini menentukan berapa uang yang ditagihkan ke principal dan berapa yang
   ditanggung sendiri. Dua angka tidak boleh pernah "nol karena tidak dihitung": diskon
   tak bertuan (posisi 6+) dan klaim principal tanpa aturan terbit. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakturRuleFor, invoiceLines, isoDate, parseTariff, recap, ruleFor, type PromoRule } from "./promo-recap.ts";

const aturan = (over: Partial<PromoRule> = {}): PromoRule => ({
    principal: "KINO NON FOOD", suratProgram: "BP2609007909", promoLabel: "MTI - HPC CONSUMER PROMO ON PO",
    promoGroup: "ELLIPS HAIR MIST", itemCode: "K1010001006010", customerCode: "",
    periodStart: "2026-09-01", periodEnd: "2026-09-30",
    benefitType: "DISC_PCT", benefitValue: "3", benefitUnit: "%", onFaktur: false,
    benefitBeban: "PRINCIPAL", tierNo: 1, triggerQty: 0, triggerUnit: "PCS", ...over,
});

const faktur = {
    id: 331710, number: "SI.2026.09.0001", transDate: "11/09/2026",
    customer: { customerNo: "C-TRU001-KN" },
    detailItem: [
        // Distributor 4% lalu klaim principal 3% — persis bentuk rantai persen Accurate.
        { itemNo: "K1010001006010", item: { name: "KNF ELLIPS HAIR MIST 100ML" },
          quantity: 10, unitPrice: 100000, itemDiscPercent: "4+0+0+3", itemCashDiscount: 0 },
        // Tanpa diskon sama sekali.
        { itemNo: "K9999999999999", item: { name: "BARANG LAIN" },
          quantity: 2, unitPrice: 50000, itemDiscPercent: "", itemCashDiscount: 0 },
    ],
};

test("tanggal Accurate dd/MM/yyyy dibaca jadi ISO, bukan dipotong begitu saja", () => {
    assert.equal(isoDate("11/09/2026"), "2026-09-11");
    assert.equal(isoDate("2026-09-11"), "2026-09-11");
});

test("baris faktur dibongkar dari raw_data webhook, posisi persen dipertahankan", () => {
    const lines = invoiceLines(faktur);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].transDate, "2026-09-11");
    assert.equal(lines[0].customerNo, "C-TRU001-KN");
    assert.equal(lines[0].gross, 1000000);
    // "4+0+0+3": nol dibuang, tetapi POSISI tidak boleh bergeser — 3% harus tetap posisi 4,
    // karena posisi 4 berarti klaim principal sedangkan posisi 2 berarti tanggungan distributor.
    assert.deepEqual(lines[0].discounts, [{ position: 1, percent: 4 }, { position: 4, percent: 3 }]);
});

test("aturan hanya berlaku bila barang, BEBAN, dan tanggal semuanya cocok", () => {
    const line = invoiceLines(faktur)[0];
    assert.ok(ruleFor(line, [aturan()], "PRINCIPAL", 3));
    assert.equal(ruleFor(line, [aturan({ periodStart: "2026-10-01", periodEnd: "2026-10-31" })], "PRINCIPAL", 3), null);
    assert.equal(ruleFor(line, [aturan({ itemCode: "LAIN" })], "PRINCIPAL", 3), null);
    // Beban IKUT dicocokkan: aturan principal tidak boleh membenarkan potongan yang duduk di
    // posisi distributor. Posisi menyatakan siapa yang DIMAKSUD menanggung; aturan menyatakan
    // apakah maksud itu sah.
    assert.equal(ruleFor(line, [aturan()], "DISTRIBUTOR", 3), null);
    // Persen yang berbeda dari surat tidak dibenarkan aturan mana pun.
    assert.equal(ruleFor(line, [aturan()], "PRINCIPAL", 5), null);
});

test("tak bertuan = TIDAK SESUAI aturan, bukan posisi 6 ke atas", () => {
    // Keputusan pengguna 2026-09-12. Tiga potongan, tiga sebab berbeda, semuanya tak bertuan.
    const nakal = {
        ...faktur,
        detailItem: [
            // Posisi 6: memang di luar 1-5, tidak ada yang mengaku menanggung.
            { itemNo: "K1010001006010", item: { name: "X" }, quantity: 1, unitPrice: 100000,
              itemDiscPercent: "0+0+0+0+0+5", itemCashDiscount: 5000 },
            // Posisi 4 (klaim principal) untuk barang yang tidak punya aturan terbit.
            { itemNo: "TANPA-ATURAN", item: { name: "Y" }, quantity: 1, unitPrice: 200000,
              itemDiscPercent: "0+0+0+2", itemCashDiscount: 4000 },
            // Posisi 1 (distributor) TANPA aturan berbeban DISTRIBUTOR: dulu lolos begitu saja
            // sebagai "beban sendiri", sekarang wajib divalidasi dulu.
            { itemNo: "K1010001006010", item: { name: "X" }, quantity: 1, unitPrice: 300000,
              itemDiscPercent: "2", itemCashDiscount: 6000 },
        ],
    };
    const hasil = recap(invoiceLines(nakal), [aturan()]);
    assert.equal(hasil.unowned, 15000);
    assert.equal(hasil.principal, 0);
    assert.equal(hasil.distributor, 0);
    assert.equal(hasil.programs.length, 0);
    assert.equal(hasil.rows.filter((r) => r.bucket === "unowned").length, 3);
    assert.ok(hasil.rows.some((r) => r.reason.includes("tidak ada aturan distributor")));
    assert.ok(hasil.rows.some((r) => r.reason.includes("di luar 1-5")));
});

test("potongan distributor DIAKUI hanya bila ada aturan berbeban DISTRIBUTOR yang cocok", () => {
    const line = {
        ...faktur,
        detailItem: [{ itemNo: "K1010001006010", item: { name: "X" }, quantity: 1, unitPrice: 100000,
                       itemDiscPercent: "2", itemCashDiscount: 2000 }],
    };
    const tanpa = recap(invoiceLines(line), [aturan()]);
    assert.equal(tanpa.distributor, 0);
    assert.equal(tanpa.unowned, 2000);

    const dengan = recap(invoiceLines(line), [aturan({ benefitBeban: "DISTRIBUTOR", benefitValue: "2" })]);
    assert.equal(dengan.distributor, 2000);
    assert.equal(dengan.unowned, 0);
});

test("rekap per program: yang cocok masuk programnya, yang tidak masuk tak bertuan", () => {
    const rules = [aturan(), aturan({ benefitBeban: "DISTRIBUTOR", benefitValue: "4" })];
    const hasil = recap(invoiceLines(faktur), rules);
    assert.equal(hasil.invoices, 1);
    assert.equal(hasil.gross, 1100000);
    // 4% atas 1.000.000 = 40.000 (distributor), lalu 3% atas sisanya = 28.800 (principal).
    assert.equal(hasil.distributor, 40000);
    assert.equal(hasil.principal, 28800);
    assert.equal(hasil.unowned, 0);
    assert.equal(hasil.programs[0].promoGroup, "ELLIPS HAIR MIST");
    assert.equal(hasil.programs[0].amount, 28800);
    assert.equal(hasil.programs[0].invoices, 1);
    // Rincian per potongan: bahan kartu, layar, dan CSV sekaligus.
    const principalRow = hasil.rows.find((r) => r.bucket === "principal")!;
    assert.equal(principalRow.positions, "4");
    assert.equal(principalRow.suratProgram, "BP2609007909");

    // Surat bilang 5%, faktur memberi 3% -> tidak cocok, jadi tak bertuan.
    const beda = recap(invoiceLines(faktur), [aturan({ benefitValue: "5" }), rules[1]]);
    assert.equal(beda.principal, 0);
    assert.equal(beda.unowned, 28800);
    assert.ok(beda.rows.some((r) => r.reason.includes("tidak sama dengan aturan principal")));
});

test("potongan tingkat faktur (MSG) dicocokkan per FAKTUR, dengan PPN dikembalikan", () => {
    // RISKA TK 12 Sep 2026: bruto 1.198.378 -> tier 1 Rp 20.000; faktur membawa DPP 18.016,22.
    const msg = {
        number: "INV/2609/KN00451", id: 1, transDate: "12/09/2026", branchName: "KINO NON FOOD",
        customer: { customerNo: "C-RIS035-KN", name: "RISKA TK" },
        detailItem: [
            { itemNo: "A", item: { name: "A" }, quantity: 1, unitPrice: 1_198_378,
              itemDiscPercent: "", itemCashDiscount: 18016.22 },
        ],
    };
    const tier = aturan({
        suratProgram: "BP2609006016", promoGroup: "ALL BRAND HPC", itemCode: "",
        benefitType: "DISC_RP", benefitValue: "20000", triggerQty: 1_000_000, triggerUnit: "RP",
    });
    // Nilai persis: 18.018,018018 x 1,11 = 20.000.
    const pas = { ...msg, detailItem: [{ ...msg.detailItem[0], itemCashDiscount: 18018.02 }] };
    const hasil = recap(invoiceLines(pas), [tier]);
    assert.equal(hasil.principal, 18018.02);
    assert.equal(hasil.unowned, 0);
    assert.equal(hasil.rows[0].positions, "faktur");
    assert.equal(hasil.programs[0].suratProgram, "BP2609006016");

    // Nominal yang tidak sesuai tier tidak boleh diakui sebagai klaim.
    const meleset = { ...msg, detailItem: [{ ...msg.detailItem[0], itemCashDiscount: 45000 }] };
    assert.equal(recap(invoiceLines(meleset), [tier]).unowned, 45000);

    // Angka RISKA yang sesungguhnya: Rp 18.016,22 atas 18 baris. Selisihnya Rp 2 dari tier —
    // principal membulatkan pembagiannya sendiri, dan toleransi Rp 1 PER BARIS menyerapnya.
    assert.ok(fakturRuleFor([tier], "PRINCIPAL", "2026-09-12", 1_198_378, 18_016.22, 18));
    // Toleransi itu tidak boleh jadi pintu belakang: selisih yang sungguhan tetap ditolak.
    assert.equal(fakturRuleFor([tier], "PRINCIPAL", "2026-09-12", 1_198_378, 17_000, 18), null);
    // Belanja di bawah ambang tidak menjelaskan apa pun.
    assert.equal(fakturRuleFor([tier], "PRINCIPAL", "2026-09-12", 500_000, 18_016.22, 18), null);
});

test("raw_data yang tersimpan sebagai TEKS JSON tetap terbaca", () => {
    // Bentuk nyata di produksi: lib/sync menyimpan lewat JSON.stringify, jadi kolom jsonb-nya
    // berisi string. Kalau ini tidak diurai, rekap melaporkan nol diskon untuk faktur yang
    // penuh diskon — salah, dan terlihat menenangkan.
    const teks = JSON.stringify(faktur);
    assert.equal(invoiceLines(teks).length, 2);
    assert.equal(invoiceLines(teks)[0].invoiceNo, "SI.2026.09.0001");
    assert.deepEqual(invoiceLines(JSON.stringify(teks))[0].discounts, [{ position: 1, percent: 4 }, { position: 4, percent: 3 }]);
    assert.deepEqual(invoiceLines("bukan json"), []);
});

test("tarif Discount Reguler outlet menjelaskan potongan distributor di rekap", () => {
    // Kode outlet pada faktur Accurate ber-akhiran cabang (`C-TRU001-KN`) sedangkan tarifnya
    // tercetak dengan kode internal (`C-TRU001`). Kalau akhirannya tidak dijembatani, seluruh
    // potongan yang sah akan terhitung tak bertuan di laporan uang akhir bulan.
    const tarif = aturan({
        suratProgram: "DISCOUNT REGULER", promoGroup: "TANGGUNGAN DISTRIBUTOR",
        itemCode: "", customerCode: "C-TRU001", tierNo: 1,
        benefitBeban: "DISTRIBUTOR", benefitValue: "4", periodStart: null, periodEnd: null,
    });
    const hasil = recap(invoiceLines(faktur), [aturan(), tarif]);
    assert.equal(hasil.distributor, 40000);
    assert.equal(hasil.unowned, 0);

    // Outlet LAIN tidak ikut kecipratan tarif ini.
    const lain = recap(invoiceLines({ ...faktur, customer: { customerNo: "C-XXX999-KN" } }), [aturan(), tarif]);
    assert.equal(lain.distributor, 0);
    assert.equal(lain.unowned, 40000);
});

test("sheet Discount Reguler dipecah jadi satu aturan per (outlet x posisi)", () => {
    const issues: string[] = [];
    const hasil = parseTariff([
        // Bentuk tabel aslinya: satu baris per outlet, satu kolom per posisi.
        { "PAKAI": "YA", "PELANGGAN": "ALFAMART", "KODE_OUTLET": "c-al0063", "POSISI 1": 4, "POSISI 2": "", "POSISI 3": "", "POSISI 4": "2.25", "POSISI 5": "" },
        { "PAKAI": "ya", "PELANGGAN": "SS DIAPERS MESJID RAYA", "KODE_OUTLET": "C-SAT016", "POSISI 1": "2%", "POSISI 2": "1,5" },
        // Tiga baris tabel aslinya tidak terbaca dari foto: harus muncul sebagai lubang.
        { "PAKAI": "YA", "PELANGGAN": "HYPERMART", "KODE_OUTLET": "", "POSISI 1": "" },
        // Outlet berkode tetapi tanpa satu posisi pun -> dilaporkan, tidak dimuat diam-diam.
        { "PAKAI": "YA", "PELANGGAN": "PANEN SELARAS", "KODE_OUTLET": "C-PAN001" },
        // Posisinya BELUM dinyatakan pasti -> tidak dimuat, dan itu dilaporkan.
        { "PAKAI": "", "PELANGGAN": "RAMAYANA", "KODE_OUTLET": "C-RAM001", "POSISI 1": 3 },
    ], { principal: "KINO NON FOOD", importedBy: "uji@surya", issues });

    assert.deepEqual(hasil.map((r) => [r.customerCode, r.tierNo, r.benefitValue, r.benefitBeban]), [
        // Beban diturunkan dari POSISI, seperti header tabel principalnya: 1-3 distributor,
        // 4-5 principal. Alfamart 2,25% di posisi 4 itu klaim principal, bukan beban sendiri.
        ["C-AL0063", 1, "4", "DISTRIBUTOR"],
        ["C-AL0063", 4, "2.25", "PRINCIPAL"],
        ["C-SAT016", 1, "2", "DISTRIBUTOR"],
        ["C-SAT016", 2, "1.5", "DISTRIBUTOR"],
    ]);
    assert.ok(hasil.every((r) => r.periodStart === null && r.periodEnd === null
        && r.benefitType === "DISC_PCT" && r.itemCode === ""));
    assert.equal(issues.length, 3);
    assert.match(issues.join(" "), /HYPERMART/);
    assert.match(issues.join(" "), /C-PAN001/);
    // Yang belum dicentang PAKAI tidak boleh ikut, dan harus terlihat kenapa.
    assert.match(issues.join(" "), /C-RAM001: kolom PAKAI belum diisi/);
});

test("outlet yang tertulis dua kali tidak menggagalkan seluruh muatan", () => {
    // Kasus nyata 14 Sep 2026: C-SAT017 tertulis pada baris 27 dan 42 daftar yang disusun
    // tangan. Kunci uniknya sama persis, jadi menyerahkannya ke database berarti 90 aturan
    // hilang gara-gara satu baris kembar.
    const sama: string[] = [];
    const hasilSama = parseTariff([
        { "PAKAI": "YA", "PELANGGAN": "SATU SAMA JAYA", "KODE_OUTLET": "C-SAT017", "POSISI 1": 2 },
        { "PAKAI": "YA", "PELANGGAN": "SATU SAMA JAYA", "KODE_OUTLET": "C-SAT017", "POSISI 1": 2 },
    ], { principal: "KINO NON FOOD", importedBy: "uji", issues: sama });
    assert.equal(hasilSama.length, 1);
    assert.match(sama.join(" "), /tertulis 2x dengan isi yang sama/);

    // Kembar yang isinya BERBEDA adalah pernyataan yang saling bertentangan tentang outlet dan
    // posisi yang sama. Memilih salah satunya berarti menebak tarif mana yang benar.
    const beda: string[] = [];
    const hasilBeda = parseTariff([
        { "PAKAI": "YA", "PELANGGAN": "X", "KODE_OUTLET": "C-XX0001", "POSISI 1": 2 },
        { "PAKAI": "YA", "PELANGGAN": "X", "KODE_OUTLET": "C-XX0001", "POSISI 1": 3 },
    ], { principal: "KINO NON FOOD", importedBy: "uji", issues: beda });
    assert.equal(hasilBeda.length, 0);
    assert.match(beda.join(" "), /isi BERBEDA \(2% DISTRIBUTOR vs 3% DISTRIBUTOR\)/);
});

test("pemeriksaan tarif: yang menganggur dan outlet yang potongannya tanpa aturan", () => {
    const tarifCocok = aturan({
        suratProgram: "DISCOUNT REGULER", promoGroup: "TANGGUNGAN DISTRIBUTOR", promoLabel: "TRUFARM",
        itemCode: "", customerCode: "C-TRU001", tierNo: 1,
        benefitBeban: "DISTRIBUTOR", benefitValue: "4", periodStart: null, periodEnd: null,
    });
    // Outlet ini memang bertransaksi, tetapi tarifnya di kolom yang salah — persis gejala yang
    // laporan ini dicari: terdaftar, outletnya belanja, tapi tidak pernah menjelaskan apa pun.
    const tarifSalahKolom = aturan({
        suratProgram: "DISCOUNT REGULER", promoGroup: "TANGGUNGAN DISTRIBUTOR", promoLabel: "TRUFARM",
        itemCode: "", customerCode: "C-TRU001", tierNo: 2,
        benefitBeban: "DISTRIBUTOR", benefitValue: "9", periodStart: null, periodEnd: null,
    });
    // Outlet yang tidak muncul sama sekali pada periode ini — wajar menganggur.
    const tarifOutletDiam = aturan({
        suratProgram: "DISCOUNT REGULER", promoGroup: "TANGGUNGAN DISTRIBUTOR", promoLabel: "DIAM",
        itemCode: "", customerCode: "C-ZZZ999", tierNo: 1,
        benefitBeban: "DISTRIBUTOR", benefitValue: "2", periodStart: null, periodEnd: null,
    });

    const hasil = recap(invoiceLines(faktur), [tarifCocok, tarifSalahKolom, tarifOutletDiam]);

    const menganggur = hasil.tarifMenganggur.map((t) => `${t.customerCode}/${t.tierNo}/${t.outletBertransaksi}`);
    assert.deepEqual(menganggur, ["C-TRU001/2/true", "C-ZZZ999/1/false"]);

    // Klaim principal 3% tidak punya aturan -> tak bertuan, dan diringkas per outlet.
    assert.equal(hasil.outletTanpaAturan.length, 1);
    const [outlet] = hasil.outletTanpaAturan;
    assert.equal(outlet.customerNo, "C-TRU001-KN");
    assert.equal(outlet.amount, hasil.unowned);
    assert.deepEqual(outlet.positions, ["4"]);
    assert.deepEqual(outlet.percents, [3]);
});
