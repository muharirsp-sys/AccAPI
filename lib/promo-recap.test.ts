/* Kunci: rekap ini menentukan berapa uang yang ditagihkan ke principal dan berapa yang
   ditanggung sendiri. Dua angka tidak boleh pernah "nol karena tidak dihitung": diskon
   tak bertuan (posisi 6+) dan klaim principal tanpa aturan terbit. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakturRuleFor, invoiceLines, isoDate, kunciNormalisasi, NORMALISASI, parseTariff, pemberianPertama, recap, ruleFor, temuanPoPertama, type PromoRule, type Putusan } from "./promo-recap.ts";

const aturan = (over: Partial<PromoRule> = {}): PromoRule => ({
    principal: "KINO NON FOOD", suratProgram: "BP2609007909", promoLabel: "MTI - HPC CONSUMER PROMO ON PO",
    promoGroup: "ELLIPS HAIR MIST", itemCode: "K1010001006010", customerCode: "",
    periodStart: "2026-09-01", periodEnd: "2026-09-30",
    benefitType: "DISC_PCT", benefitValue: "3", benefitUnit: "%",
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

    // NOVA COSMETIK 7 Sep 2026 (produksi): DPP 2.817.305 = 3.127.208 dengan PPN -> tier 3.
    // Ambangnya wajib dibaca termasuk PPN, sama seperti manfaatnya; dengan DPP mentah faktur
    // ini jatuh ke tier 2 dan Rp 54.058 yang sah ikut tercatat tak bertuan.
    const tier3 = { ...tier, tierNo: 3, triggerQty: 3_000_000, benefitValue: "60000" };
    assert.equal(fakturRuleFor([tier, tier3], "PRINCIPAL", "2026-09-07", 2_817_304.8, 54_058, 19)?.tierNo, 3);

    // Lantai Rp 100 seperti gerbang. IKSAN 24 Sep 2026 (produksi): 17 baris, Rp 180.218 =
    // Rp 200.041,98 dengan PPN lawan tier 10 Rp 200.000 — selisih Rp 42 melewati 17 x Rp 1,
    // padahal gerbang meloloskannya.
    const tier10 = { ...tier, tierNo: 10, triggerQty: 10_000_000, benefitValue: "200000" };
    assert.equal(fakturRuleFor([tier, tier10], "PRINCIPAL", "2026-09-24", 9_514_143.1, 180_218, 17)?.tierNo, 10);
    // Lantainya bukan pintu belakang: A3 KOSMETIK kurang Rp 2.937 dari tier tetap ditolak.
    assert.equal(fakturRuleFor([tier, tier10], "PRINCIPAL", "2026-09-08", 9_222_445.5, 177_534, 52), null);
});

test("PER POSISI: yang cocok aturan diakui, hanya sisanya tak bertuan", () => {
    // PT SUPRA BOGA INV/2609/KN00760 (21 Sep 2026, produksi): `3+0.5` di posisi 1-2, tarifnya 3%
    // posisi 1 (distributor) dan 0,5% posisi 4 (principal). Digabung, 3,5% seluruhnya tak bertuan.
    const tarif = (tierNo: number, value: string, beban: string) => aturan({ suratProgram: "DISCOUNT REGULER",
        promoGroup: "PT. SUPRA BOGA", itemCode: "", customerCode: "C-PT0029", tierNo, benefitValue: value, benefitBeban: beban });
    const aturanSupra = [tarif(1, "3", "DISTRIBUTOR"), tarif(4, "0.5", "PRINCIPAL")];
    const supra = {
        id: 1, number: "INV/2609/KN00760", transDate: "21/09/2026", customer: { customerNo: "C-PT0029-KN", name: "PT. SUPRA BOGA LESTARI {C-PT0029}" },
        detailItem: [{ id: 11, itemNo: "K1010001015010", item: { name: "KNF ABSOLUTE CHAMOMILE" }, quantity: 12, unitPrice: 51261.3,
            itemDiscPercent: "3+0.5", itemCashDiscount: 21437.48 }],
    };
    const hasil = recap(invoiceLines(supra), aturanSupra);
    assert.equal(hasil.distributor, 18454.07);
    assert.equal(hasil.unowned, 2983.41);
    const tak = hasil.rows.find((row) => row.bucket === "unowned")!;
    assert.equal(tak.positions, "2");
    // Bahan keputusannya ikut disebut: nilai yang sama ada di tarif, hanya kolomnya lain.
    assert.match(tak.reason, /0\.5% ada di tarif outlet posisi 4 \(principal\)/);
    // Dan menu Normalisasi kini bisa memutuskan 0,5%-nya SAJA.
    const putusan = new Map<string, Putusan>([[kunciNormalisasi(tak), { bucket: "principal", amount: 2983.41, by: "admin" }]]);
    const diputuskan = recap(invoiceLines(supra), aturanSupra, [], putusan);
    assert.equal(diputuskan.unowned, 0);
    assert.equal(diputuskan.principal, 2983.41);
    assert.equal(diputuskan.distributor, 18454.07);
});

test("jaringan: posisi dimaklumi, nilai tidak — surat principal terbaca walau di kolom distributor", () => {
    // INDOMARET INV/2609/KN01059 (25 Sep 2026, produksi): `3.96+3+3.1`, tarifnya 3,96 + 3,1.
    const tarif = (tierNo: number, value: string) => aturan({ suratProgram: "DISCOUNT REGULER", promoGroup: "Indomaret",
        itemCode: "", customerCode: "C-IN0050", tierNo, benefitValue: value, benefitBeban: "DISTRIBUTOR" });
    const indomaret = {
        id: 2, number: "INV/2609/KN01059", transDate: "25/09/2026", customer: { customerNo: "C-IN0050-KN", name: "INDOMARET {C-IN0050}" },
        detailItem: [{ id: 21, itemNo: "K1531001003011", item: { name: "KNF SASHA SHAMPOO COLOR NATURA" }, quantity: 61,
            unitPrice: 603243.2, itemDiscPercent: "3.96+3+3.1", itemCashDiscount: 3580106.57 }],
    };
    const tanpaSurat = recap(invoiceLines(indomaret), [tarif(1, "3.96"), tarif(2, "3.1")]);
    // 3,1% di posisi 3 dipasangkan ke slot tarif posisi 2; 3% tidak punya pasangan. Rupiahnya
    // menurut URUTAN FAKTUR: 3% dihitung atas sisa sesudah 3,96%, bukan sesudah 3,1%.
    assert.equal(tanpaSurat.distributor, 2519887.34);
    assert.equal(tanpaSurat.unowned, 1060219.23);
    assert.equal(tanpaSurat.rows.find((row) => row.bucket === "unowned")?.positions, "2");

    // Surat BP2609008707 untuk barang itu. Fakturnya diketik langsung di Accurate dengan 3% di kolom 2.
    const surat = aturan({ suratProgram: "SURAT-INDOMARET", itemCode: "K1531001003011", benefitValue: "3" });
    const denganSurat = recap(invoiceLines(indomaret), [tarif(1, "3.96"), tarif(2, "3.1"), surat]);
    assert.equal(denganSurat.unowned, 0);
    assert.equal(denganSurat.principal, 1060219.23);
    assert.equal(denganSurat.programs.find((program) => program.suratProgram === "SURAT-INDOMARET")?.amount, 1060219.23);

    // Outlet BUKAN jaringan tetap dinilai per posisi apa adanya: kolom distributor tidak
    // dibenarkan surat principal, dan 3,1% di posisi 3 tidak dipindah ke slot posisi 2.
    const biasa = { ...indomaret, customer: { customerNo: "C-IN0050-KN", name: "TOKO BIASA" } };
    assert.equal(recap(invoiceLines(biasa), [tarif(1, "3.96"), tarif(2, "3.1"), surat]).unowned, 2122912.3);

    // Lintas beban: Alfamart dengan 2,25% tarif distributor yang dilaporkan di kolom 4.
    const alfa = (tierNo: number, value: string) => ({ ...tarif(tierNo, value), customerCode: "C-AL0063" });
    const alfamart = { ...indomaret, customer: { customerNo: "C-AL0063-KN", name: "ALFAMART {C-AL0063}" },
        detailItem: [{ ...indomaret.detailItem[0], quantity: 1, unitPrice: 345945.95, itemDiscPercent: "4+0+0+2.25", itemCashDiscount: 21310.27 }] };
    const hasilAlfa = recap(invoiceLines(alfamart), [alfa(1, "4"), alfa(2, "2.25")]);
    assert.equal(hasilAlfa.unowned, 0);
    assert.equal(hasilAlfa.distributor, 21310.27);
});

test("first PO: hanya faktur PERTAMA per outlet x barang yang dibenarkan surat listing", () => {
    // BP2609008707: "DISC 3% (FIRST PO)" SASHA NATURAL BLACK 30ML untuk Indomaret, 15 Sep - 31 Des.
    const listing = aturan({ suratProgram: "BP2609008707", promoGroup: "SASHA SHAMPOO - COLOR", itemCode: "K1531001003011",
        periodStart: "2026-09-15", periodEnd: "2026-12-31", firstPo: true });
    const faktur = (id: number, no: string, tanggal: string, outlet = "C-IN0050-KN") => ({
        id, number: no, transDate: tanggal, customer: { customerNo: outlet, name: "INDOMARET {C-IN0050}" },
        detailItem: [{ id: id * 10, itemNo: "K1531001003011", item: { name: "KNF SASHA SHAMPOO COLOR NATURAL BLACK 30ML" },
            quantity: 1, unitPrice: 100000, itemDiscPercent: "0+0+0+3", itemCashDiscount: 3000 }],
    });
    const baris = [faktur(2, "INV/2609/KN01100", "30/09/2026"), faktur(1, "INV/2609/KN01059", "25/09/2026"),
        faktur(3, "INV/2609/KN01101", "30/09/2026", "C-IN0086-KN")].flatMap((f) => invoiceLines(f));
    const hasil = recap(baris, [listing]);
    // Urutan masukan tidak menentukan: yang pertama menurut TANGGAL faktur yang berhak.
    const milik = (no: string) => hasil.rows.find((row) => row.invoiceNo === no)!;
    assert.equal(milik("INV/2609/KN01059").bucket, "principal");
    assert.equal(milik("INV/2609/KN01100").bucket, "unowned");
    assert.match(milik("INV/2609/KN01100").reason, /hanya untuk PO PERTAMA.*INV\/2609\/KN01059 \(2026-09-25\)/);
    // Outlet lain punya PO pertamanya sendiri.
    assert.equal(milik("INV/2609/KN01101").bucket, "principal");
    assert.equal(hasil.principal, 6000);
    assert.equal(hasil.unowned, 3000);

    // Riwayat dari luar rentang rekap (dihitung pemanggil sejak awal periode aturan): PO Oktober
    // bukan "pertama" hanya karena rekapnya dibuka per Oktober.
    const oktober = invoiceLines(faktur(4, "INV/2610/KN00001", "02/10/2026"));
    const riwayat = pemberianPertama([...baris, ...oktober], [listing]);
    assert.equal(recap(oktober, [listing], [], new Map(), riwayat).unowned, 3000);
    assert.equal(recap(oktober, [listing]).principal, 3000, "tanpa riwayat, rekap bulannya sendiri mengira pertama");

    // Aturan tanpa first PO tidak tersentuh: kedua faktur outlet yang sama tetap sah.
    const biasa = recap(baris, [{ ...listing, firstPo: false }]);
    assert.equal(biasa.unowned, 0);
    assert.equal(biasa.principal, 9000);
});

test("first PO di GERBANG: SO yang outletnya sudah mendapatkannya ditahan, dengan sebabnya", () => {
    const listing = { suratProgram: "BP2609008707", itemCode: "K1531001003011", benefitType: "DISC_PCT", benefitValue: "3",
        periodStart: "2026-09-15", periodEnd: "2026-12-31", firstPo: true };
    const so = (key: string, soNo: string, soDate: string, customerNo = "C-IN0050-KN", percent = 3) => ({
        key, soNo, soDate, customerNo, itemCode: "K1531001003011",
        discounts: [{ position: 1, percent: 3.96 }, { position: 2, percent: 3.1 }, { position: 4, percent }],
    });
    const sudahDiberikan = new Map([["C-IN0050-KN|K1531001003011|BP2609008707",
        { invoiceId: "335001", invoiceNo: "INV/2609/KN01059", transDate: "2026-09-25" }]]);

    // Riwayat faktur lain -> ditahan, dengan nomor fakturnya.
    const tahan = temuanPoPertama([so("1", "SO-2", "2026-10-02")], [listing], sudahDiberikan, new Set());
    assert.match(tahan.get("1") ?? "", /hanya untuk PO PERTAMA.*INV\/2609\/KN01059 \(2026-09-25\)/);
    // Faktur itu milik SO ini sendiri (validasi ulang sesudah terbit) -> tidak menahan dirinya.
    assert.equal(temuanPoPertama([so("1", "SO-1", "2026-09-25")], [listing], sudahDiberikan, new Set(["335001"])).size, 0);
    // Belum pernah diberikan: dari dua SO di batch yang sama, hanya yang LEBIH AWAL yang pertama.
    const dua = temuanPoPertama([so("7", "SO-B", "2026-09-26"), so("3", "SO-A", "2026-09-25")], [listing], new Map(), new Set());
    assert.equal(dua.has("3"), false);
    assert.match(dua.get("7") ?? "", /SO SO-A yang lebih awal/);
    // Outlet lain, SO tanpa potongan itu, dan aturan tanpa first PO tidak tersentuh.
    assert.equal(temuanPoPertama([so("1", "SO-2", "2026-10-02", "C-IN0086-KN")], [listing], sudahDiberikan, new Set()).size, 0);
    assert.equal(temuanPoPertama([so("1", "SO-2", "2026-10-02", "C-IN0050-KN", 2)], [listing], sudahDiberikan, new Set()).size, 0);
    assert.equal(temuanPoPertama([so("1", "SO-2", "2026-10-02")], [{ ...listing, firstPo: false }], sudahDiberikan, new Set()).size, 0);
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

test("tarif PRINCIPAL di posisi 4 juga diakui rekap, sama seperti gerbang", () => {
    // PT SUPRA BOGA: tarifnya 3% distributor di posisi 1 dan 0,5% PRINCIPAL di posisi 4. Sampai
    // 2026-09-24 rekap hanya mencocokkan sisi distributor, jadi klaim 0,5%-nya tak bertuan.
    const tarif = (over: Partial<PromoRule>) => aturan({ suratProgram: "DISCOUNT REGULER", promoGroup: "TANGGUNGAN DISTRIBUTOR",
        itemCode: "", customerCode: "C-TRU001", ...over });
    const supra = { ...faktur, detailItem: [{ ...faktur.detailItem[0], itemDiscPercent: "3+0+0+0.5+0" }] };
    const hasil = recap(invoiceLines(supra), [
        tarif({ tierNo: 1, benefitValue: "3", benefitBeban: "DISTRIBUTOR" }),
        tarif({ tierNo: 4, benefitValue: "0.5", benefitBeban: "PRINCIPAL" }),
    ]);
    assert.equal(hasil.distributor, 30000);
    assert.equal(hasil.principal, 4850);
    assert.equal(hasil.unowned, 0);
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

test("baris bonus: potongan 100% dijelaskan aturan BONUS_QTY dan diakui klaim principal", () => {
    // KOSMETIK MUNAWARAH 15 Sep 2026 (produksi, INV/2609/KN00531): surat BP2609007713 memberi
    // "beli 30 PCS gratis 1 PCS harga sama", dan Accurate mencatatnya sebagai baris tambahan
    // berdiskon 100% di POSISI 1 — kolom distributor. Tanpa pembacaan ini seluruh Rp 2,61 juta
    // bonus September jatuh ke tak bertuan, padahal suratnya jelas ada.
    const bonus = {
        number: "INV/2609/KN00531", id: 9, transDate: "15/09/2026", branchName: "KINO NON FOOD",
        customer: { customerNo: "C-KOS005-KN", name: "KOSMETIK MUNAWARAH" },
        detailItem: [
            // Baris PEMBELIAN: 30 pcs, yang membuat satu bonus berhak. Tanpa baris ini kuotanya
            // nol — dan memang seharusnya begitu.
            { itemNo: "K1390001009010", item: { name: "KNF RESIK V RAMUAN MADURA WHITENING 90ML" },
              quantity: 30, unitPrice: 35135.2, itemDiscPercent: "", itemCashDiscount: 0 },
            { itemNo: "K1390001009010", item: { name: "KNF RESIK V RAMUAN MADURA WHITENING 90ML" },
              quantity: 1, unitPrice: 35135.2, itemDiscPercent: "100", itemCashDiscount: 35135.2 },
        ],
    };
    const bonusRule = aturan({
        suratProgram: "BP2609007713", promoGroup: "RESIK V KHASIAT RAMUAN MADURA WHITENING",
        itemCode: "K1390001009010", benefitType: "BONUS_QTY", benefitValue: "1", benefitUnit: "PCS",
        triggerQty: 30, triggerUnit: "PCS",
    });
    const hasil = recap(invoiceLines(bonus), [bonusRule]);
    assert.equal(hasil.principal, 35135.2);
    assert.equal(hasil.distributor, 0);
    assert.equal(hasil.unowned, 0);
    assert.equal(hasil.programs[0].suratProgram, "BP2609007713");
    assert.equal(hasil.rows[0].positions, "1");

    // Tanpa aturannya, baris yang sama TETAP tak bertuan — bukan disahkan oleh angka 100 saja.
    assert.equal(recap(invoiceLines(bonus), []).unowned, 35135.2);
    // Aturan bonus milik BARANG LAIN tidak boleh meloloskannya.
    assert.equal(recap(invoiceLines(bonus), [aturan({ ...bonusRule, itemCode: "K9999" })]).unowned, 35135.2);
    // Di luar periode juga tidak.
    assert.equal(recap(invoiceLines(bonus), [{ ...bonusRule, periodEnd: "2026-09-10" }]).unowned, 35135.2);
});

test("rekap menghormati daftar outlet peserta, per tanggal barisnya", () => {
    const bonus = (customerNo: string, transDate: string) => ({
        number: `INV/${customerNo}`, id: customerNo, transDate, branchName: "KINO NON FOOD",
        customer: { customerNo, name: customerNo },
        detailItem: [
            { itemNo: "K1390001009010", item: { name: "KNF RESIK V" },
                quantity: 30, unitPrice: 35135.2, itemDiscPercent: "", itemCashDiscount: 0 },
            { itemNo: "K1390001009010", item: { name: "KNF RESIK V" },
                quantity: 1, unitPrice: 35135.2, itemDiscPercent: "100", itemCashDiscount: 35135.2 }],
    });
    const rule = aturan({
        suratProgram: "BP2609007713", promoGroup: "RESIK V KHASIAT MANJAKANI",
        itemCode: "K1390001009010", benefitType: "BONUS_QTY", benefitValue: "1",
        triggerQty: 30, triggerUnit: "PCS", outletList: "LOYALTY", outletListMode: "INCLUDE",
    });
    const members = [{ listName: "LOYALTY", customerCode: "C-WIN013", periodStart: "2026-07-01", periodEnd: "2026-09-30" }];

    const peserta = recap(invoiceLines(bonus("C-WIN013-KN", "15/09/2026")), [rule], members);
    assert.equal(peserta.principal, 35135.2);
    assert.equal(peserta.unowned, 0);

    // Outlet yang bukan peserta: bonusnya TETAP tertahan meski barang dan persennya cocok.
    const bukan = recap(invoiceLines(bonus("C-NOV009-KN", "15/09/2026")), [rule], members);
    assert.equal(bukan.principal, 0);
    assert.equal(bukan.unowned, 35135.2);

    // Keanggotaan berperiode: outlet yang sama, bulan berikutnya, sudah bukan peserta lagi.
    const oktober = recap(invoiceLines(bonus("C-WIN013-KN", "01/10/2026")), [{ ...rule, periodEnd: "2026-10-31" }], members);
    assert.equal(oktober.unowned, 35135.2);
});

test("bonus yang MELEWATI KUOTA ditolak, meski aturannya ada dan barangnya benar", () => {
    // Ketakutan yang disebut pengguna: beli 10 pcs, dapat bonus 1 pcs. Aturannya ada, barangnya
    // benar, persennya benar — dan justru itu yang membuatnya berbahaya: semua tampak sah.
    const bonusRule = aturan({
        suratProgram: "BP2609007713", promoGroup: "RESIK V KHASIAT MANJAKANI",
        itemCode: "K1390001009010", benefitType: "BONUS_QTY", benefitValue: "1", benefitUnit: "PCS",
        triggerQty: 30, triggerUnit: "PCS",
    });
    const faktur = (beli: number) => ({
        number: "INV/2609/KN09999", id: 99, transDate: "15/09/2026", branchName: "KINO NON FOOD",
        customer: { customerNo: "C-KOS005-KN", name: "KOSMETIK MUNAWARAH" },
        detailItem: [
            { itemNo: "K1390001009010", item: { name: "KNF RESIK V" }, quantity: beli,
              unitPrice: 35135.2, itemDiscPercent: "", itemCashDiscount: 0 },
            { itemNo: "K1390001009010", item: { name: "KNF RESIK V" }, quantity: 1,
              unitPrice: 35135.2, itemDiscPercent: "100", itemCashDiscount: 35135.2 },
        ],
    });

    const kurang = recap(invoiceLines(faktur(10)), [bonusRule]);
    assert.equal(kurang.principal, 0);
    assert.equal(kurang.unowned, 35135.2);
    assert.match(kurang.rows.find((r) => r.bucket === "unowned")!.reason, /melewati kuota/);
    assert.match(kurang.rows.find((r) => r.bucket === "unowned")!.reason, /beli 10 berhak 0, diberi 1/);

    // Tepat 30 berhak satu: yang sah tidak ikut tertahan.
    assert.equal(recap(invoiceLines(faktur(30)), [bonusRule]).principal, 35135.2);

    // Satuan diseragamkan: 1 KRT isi 36 adalah 36 pcs, bukan 1.
    const karton = {
        ...faktur(1),
        detailItem: [
            { itemNo: "K1390001009010", item: { name: "KNF RESIK V" }, quantity: 1, quantityDefault: 36,
              unitRatio: 36, unitPrice: 1264867, itemDiscPercent: "", itemCashDiscount: 0 },
            { itemNo: "K1390001009010", item: { name: "KNF RESIK V" }, quantity: 1,
              unitPrice: 35135.2, itemDiscPercent: "100", itemCashDiscount: 35135.2 },
        ],
    };
    assert.equal(recap(invoiceLines(karton), [bonusRule]).principal, 35135.2);
});

test("normalisasi manual: potongan tak bertuan di faktur luar web digolongkan sesuai keputusan", () => {
    // Faktur Alfamart lama yang diketik langsung di Accurate: "2,25" di posisi 1, tanpa tarif
    // yang cocok. Pengguna memutuskannya lewat menu Normalisasi Diskon.
    const lama = { ...faktur, detailItem: [{ ...faktur.detailItem[0], id: 777, itemDiscPercent: "2,25" }] };
    const lines = invoiceLines(lama);
    assert.equal(lines[0].lineId, "777");
    const sebelum = recap(lines, []);
    assert.equal(sebelum.unowned, 22500);
    const row = sebelum.rows.find((entry) => entry.bucket === "unowned")!;
    assert.equal(kunciNormalisasi(row), "777|1");

    const keputusan = (over: Partial<Putusan>) => new Map([[kunciNormalisasi(row), { bucket: "distributor", amount: 22500, by: "ari", ...over } as Putusan]]);
    const distributor = recap(lines, [], [], keputusan({}));
    assert.equal(distributor.unowned, 0);
    assert.equal(distributor.distributor, 22500);
    assert.equal(distributor.rows[0].suratProgram, NORMALISASI);
    assert.deepEqual(distributor.programs, [], "tanggungan sendiri bukan program klaim");

    // Disc claim masuk daftar program tersendiri — tidak dicampur dengan program surat.
    const klaim = recap(lines, [], [], keputusan({ bucket: "principal" }));
    assert.equal(klaim.principal, 22500);
    assert.equal(klaim.programs[0].suratProgram, NORMALISASI);
    assert.equal(klaim.programs[0].amount, 22500);

    // Faktur diubah sesudah diputuskan -> keputusan tidak dipakai, dan sebabnya disebut.
    const berubah = recap(lines, [], [], keputusan({ amount: 30000 }));
    assert.equal(berubah.unowned, 22500);
    assert.match(berubah.rows[0].reason, /TIDAK dipakai: diputuskan atas Rp 30\.000/);

    // Aturan terbit selalu didahulukan: baris yang dijelaskan aturan tidak disentuh keputusan.
    const tarif = aturan({ suratProgram: "DISCOUNT REGULER", itemCode: "", customerCode: "C-TRU001",
        benefitBeban: "DISTRIBUTOR", benefitValue: "2.25" });
    const beraturan = recap(lines, [tarif], [], keputusan({ bucket: "principal" }));
    assert.equal(beraturan.principal, 0);
    assert.equal(beraturan.distributor, 22500);
    assert.equal(beraturan.rows[0].suratProgram, "DISCOUNT REGULER");
});
