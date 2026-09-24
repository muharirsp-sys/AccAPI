/* Kunci: setiap temuan di sini berakhir sebagai angka pada faktur, jadi tidak ada yang
   "cuma warning". Toleransi Rp 1 hanya menyerap pembulatan, bukan selisih aturan. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { aturanBerlaku, bonusQuota, channelAllowed, channelLaporan, channelOutlet, checkLine, checkSoPromo,
    daftarKosong, JARINGAN_POSISI_BEBAS, needsTriggerCheck, normalisasiJaringan, outletAllowed, outletListsOn, purchaseByGroup, splitDiscounts, triggerGroupKey,
    triggerReached,
    type LineInput, type PublishedRule } from "./principal-validation.ts";

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
    assert.match(tanpaAturan.findings.join(" "), /tidak punya aturan promo terbit/);
    // Begitu aturannya terbit DAN angkanya cocok, klaim yang sama tidak lagi ditahan.
    const adaAturan = checkLine(line({
        discounts: [{ position: 4, percent: 2.25 }], reportDiscount: 7297.3,
        rules: [{ suratProgram: "BP26", promoGroup: "X", itemCode: "K1010001006010", customerCode: "", tierNo: 1,
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
    itemCode: "K1010001006010", customerCode: "", tierNo: 1, triggerQty: 0, triggerUnit: "PCS",
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

test("ADA diskon tapi promonya tidak tersetting di web = WAJIB perlu ditinjau", () => {
    // Keputusan pengguna 2026-09-12: yang ditandai hanya ini — ada potongannya, tetapi tidak
    // ada suratnya dan tidak ada aturannya di web. Uang yang tidak bisa dipertanggungjawabkan.
    const hasil = checkLine(line({ discounts: [{ position: 4, percent: 3 }], reportDiscount: 9729.73 }));
    assert.equal(hasil.status, "review");
    assert.ok(hasil.findings.some((f) => f.includes("tidak punya aturan promo terbit")));

    // Posisi 5 sama saja: keduanya klaim principal.
    const posisi5 = checkLine(line({ discounts: [{ position: 5, percent: 2 }], reportDiscount: 6486.49 }));
    assert.equal(posisi5.status, "review");
});

test("promo yang TIDAK SESUAI aturan wajib muncul sebagai perlu ditinjau, bukan diloloskan", () => {
    // Keputusan pengguna 2026-09-12. Tiga bentuk ketidaksesuaian, semuanya harus tertahan.
    const lebihBesar = checkLine(line({
        discounts: [{ position: 4, percent: 5 }], reportDiscount: 16216.22, rules: [aturan()],
    }));
    assert.equal(lebihBesar.status, "review");

    const lebihKecil = checkLine(line({
        discounts: [{ position: 4, percent: 1 }], reportDiscount: 3243.24, rules: [aturan()],
    }));
    assert.equal(lebihKecil.status, "review");

    // Aturannya ada untuk barang LAIN dengan persen yang kebetulan SAMA: tidak boleh
    // meloloskan baris ini. Tertahan sebagai klaim tanpa aturan, bukan sebagai cocok.
    const barangLain = checkLine(line({
        discounts: [{ position: 4, percent: 3 }], reportDiscount: 9729.73,
        rules: [aturan({ itemCode: "K9999999999999" })],
    }));
    assert.equal(barangLain.status, "review");
    assert.ok(barangLain.findings.some((f) => f.includes("tidak punya aturan promo terbit")));

    // Yang TIDAK ditandai: tidak ada diskon sama sekali meski barangnya masuk program.
    // Kalau principal tidak memberikannya, itu bukan kesalahan yang perlu ditinjau.
    const tanpaDiskon = checkLine(line({ discounts: [], reportDiscount: 0, rules: [aturan()] }));
    assert.equal(tanpaDiskon.status, "ok");
    assert.deepEqual(tanpaDiskon.findings, []);
});

test("diskon distributor pun WAJIB punya aturan terbit", () => {
    // Keputusan pengguna 2026-09-12: "tidak boleh meloloskan apa pun tanpa aturan, harus ada
    // aturannya dulu baru bisa tembus ke faktur". Potongan yang tidak punya aturan bukan beban
    // sendiri — ia potongan yang belum jelas milik siapa, dan memberikannya lebih dulu lalu
    // bertanya kemudian adalah cara kehilangan uang tanpa jejak.
    const tanpa = checkLine(line({ discounts: [{ position: 1, percent: 2 }], reportDiscount: 6486.49 }));
    assert.equal(tanpa.status, "review");
    assert.ok(tanpa.findings.some((f) => f.includes("tanggungan distributor")));
    // Tanpa aturan, potongannya TIDAK diakui sebagai beban kita — ia tak bertuan sampai
    // aturannya ada (keputusan pengguna 2026-09-15).
    assert.equal(tanpa.split.distributor, 0);
    assert.equal(tanpa.split.unowned, 6486.49);

    // Begitu tarif distributornya terbit dan cocok, barisnya lolos.
    const dengan = checkLine(line({
        discounts: [{ position: 1, percent: 2 }], reportDiscount: 6486.49,
        rules: [aturan({ benefitBeban: "DISTRIBUTOR", benefitValue: "2" })],
    }));
    assert.equal(dengan.status, "ok");
    assert.deepEqual(dengan.findings, []);

    // Aturan berbeban PRINCIPAL tidak boleh membenarkan potongan di posisi distributor.
    const salahBeban = checkLine(line({
        discounts: [{ position: 1, percent: 2 }], reportDiscount: 6486.49,
        rules: [aturan({ benefitValue: "2" })],
    }));
    assert.equal(salahBeban.status, "review");
});

const msg = (over: Partial<PublishedRule> = {}): PublishedRule => ({
    suratProgram: "BP2609006016", promoGroup: "ALL BRAND HPC", itemCode: "", customerCode: "",
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

test("MSG: ambang tier dibaca TERMASUK PPN, sama seperti manfaatnya", () => {
    // NOVA COSMETIK 7 Sep 2026 (produksi): DPP 2.817.305 -> dengan PPN 3.127.208, jadi tier 3
    // Rp 60.000. Kino memang memberi Rp 60.000 (DPP 54.058 x 1,11 = 60.004). Membandingkan DPP
    // mentah dengan ambang menjatuhkannya ke tier 2 dan menuduh klaim yang benar.
    const tiers = [
        msg(), msg({ tierNo: 2, triggerQty: 2_000_000, benefitValue: "40000" }),
        msg({ tierNo: 3, triggerQty: 3_000_000, benefitValue: "60000" }),
    ];
    const verdict = checkSoPromo({ gross: 2_817_304.8, principalClaim: 54_058, lineCount: 19 }, tiers);
    assert.match(verdict.explained, /tier 3/);
    assert.deepEqual(verdict.findings, []);
    // Yang benar-benar di bawah ambang TETAP tidak dijelaskan: PPN bukan pintu belakang.
    assert.equal(checkSoPromo({ gross: 800_000, principalClaim: 18_016, lineCount: 5 }, tiers).explained, "");
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


const tarif = (over: Partial<PublishedRule> = {}): PublishedRule => ({
    suratProgram: "DISCOUNT REGULER", promoGroup: "TANGGUNGAN DISTRIBUTOR",
    itemCode: "", customerCode: "C-GAL006", tierNo: 1, triggerQty: 0, triggerUnit: "PCS",
    benefitType: "DISC_PCT", benefitValue: "2", benefitBeban: "DISTRIBUTOR", ...over,
});

test("tarif Discount Reguler per outlet menjelaskan potongan pada SEMUA barang", () => {
    // Kasus nyata 12 Sep 2026: SS DIAPERS MESJID RAYA memotong 2% di posisi 1 pada delapan
    // barang yang berbeda. Tarifnya melekat pada OUTLET, jadi satu aturan tanpa kode barang.
    const lolos = checkLine(line({
        discounts: [{ position: 1, percent: 2 }], reportDiscount: 6486.49, rules: [tarif()],
    }));
    assert.equal(lolos.status, "ok", lolos.findings.join(" | "));

    // Barang lain, outlet sama, tarif sama -> tetap lolos tanpa menambah satu aturan pun.
    const barangLain = checkLine(line({
        itemCode: "K9999999999999", discounts: [{ position: 1, percent: 2 }],
        reportDiscount: 6486.49, rules: [tarif()],
    }));
    assert.equal(barangLain.status, "ok", barangLain.findings.join(" | "));
});

test("tarif dicocokkan PER POSISI: nilai benar di posisi salah tetap ditahan", () => {
    // Posisi menentukan siapa menanggung. Tarif posisi 1 tidak boleh membenarkan potongan
    // yang duduk di posisi 2 — itu bug rantai persen yang dimampatkan, dalam bentuk lain.
    const salahPosisi = checkLine(line({
        discounts: [{ position: 2, percent: 2 }], reportDiscount: 6486.49, rules: [tarif()],
    }));
    assert.equal(salahPosisi.status, "review");
    assert.match(salahPosisi.findings.join(" "), /posisi 1 2%/);

    // Dua posisi terpotong, hanya satu yang punya tarif -> separuh penjelasan bukan penjelasan.
    const separuh = checkLine(line({
        discounts: [{ position: 1, percent: 2 }, { position: 2, percent: 1 }],
        reportDiscount: 9600, rules: [tarif()],
    }));
    assert.equal(separuh.status, "review");

    // Kedua posisi punya tarifnya -> lolos. 2% lalu 1% atas sisanya = 6.486,49 + 3.178,38.
    const lengkap = checkLine(line({
        discounts: [{ position: 1, percent: 2 }, { position: 2, percent: 1 }],
        reportDiscount: 9664.87, rules: [tarif(), tarif({ tierNo: 2, benefitValue: "1" })],
    }));
    assert.equal(lengkap.status, "ok", lengkap.findings.join(" | "));
});

test("tarif outlet tidak pernah membenarkan klaim principal", () => {
    // Beban ikut dicocokkan: potongan di posisi 4 adalah klaim principal, dan tarif
    // distributor tidak boleh menjadikannya sah hanya karena persennya kebetulan sama.
    const hasil = checkLine(line({
        discounts: [{ position: 4, percent: 2 }], reportDiscount: 6486.49, rules: [tarif()],
    }));
    assert.equal(hasil.status, "review");
    assert.match(hasil.findings.join(" "), /Klaim principal/);
});

test("potongan tanpa aturan jadi TAK BERTUAN, di posisi mana pun", () => {
    // Keputusan pengguna 2026-09-15. Peta posisi 1-3/4-5 hanya berlaku bagi potongan yang
    // aturannya ADA — ia menyatakan siapa yang DIMAKSUD menanggung, bukan siapa yang terbukti.
    const tanpaAturan = checkLine(line({ discounts: [{ position: 1, percent: 2 }], reportDiscount: 6486.49 }));
    assert.equal(tanpaAturan.status, "review");
    assert.equal(tanpaAturan.split.distributor, 0, "tidak boleh diakui sebagai beban kita");
    assert.equal(tanpaAturan.split.unowned, 6486.49);
    assert.match(tanpaAturan.findings.join(" "), /tak bertuan/);

    // Sisi principal sama saja: tanpa aturan, ia bukan uang yang berhak kita tagih.
    const klaimLiar = checkLine(line({ discounts: [{ position: 4, percent: 2.25 }], reportDiscount: 7297.3 }));
    assert.equal(klaimLiar.split.principal, 0);
    assert.equal(klaimLiar.split.unowned, 7297.3);

    // Begitu aturannya ada, potongannya kembali diakui pada penanggung yang benar.
    const adaAturan = checkLine(line({
        discounts: [{ position: 1, percent: 2 }], reportDiscount: 6486.49,
        rules: [tarif()],
    }));
    assert.equal(adaAturan.status, "ok", adaAturan.findings.join(" | "));
    assert.equal(adaAturan.split.distributor, 6486.49);
    assert.equal(adaAturan.split.unowned, 0);

    // Totalnya tidak boleh berubah gara-gara penggolongan ulang — hanya embernya yang pindah.
    for (const hasil of [tanpaAturan, klaimLiar, adaAturan]) {
        assert.equal(hasil.split.distributor + hasil.split.principal + hasil.split.unowned, hasil.split.total);
    }
});

test("aturan per barang dicocokkan PER KOLOM, bukan pada jumlahnya", () => {
    // Satu aturan 5% tidak boleh meloloskan 3% di kolom 4 plus 2% di kolom 5: itu bisa dua
    // program berbeda, dan salah satunya mungkin tidak punya dasar sama sekali.
    const jumlahSaja = checkLine(line({
        discounts: [{ position: 4, percent: 3 }, { position: 5, percent: 2 }], reportDiscount: 16021.62,
        rules: [aturan({ benefitValue: "5" })],
    }));
    assert.equal(jumlahSaja.status, "review");
    assert.equal(jumlahSaja.split.principal, 0, "yang tidak dijelaskan tidak boleh diakui");

    // Masing-masing kolom punya aturannya sendiri -> lolos.
    const lengkap = checkLine(line({
        discounts: [{ position: 4, percent: 3 }, { position: 5, percent: 2 }], reportDiscount: 16021.62,
        rules: [aturan({ benefitValue: "3" }), aturan({ promoGroup: "LAIN", benefitValue: "2" })],
    }));
    assert.equal(lengkap.status, "ok", lengkap.findings.join(" | "));

    // Satu kolom saja yang punya aturan -> tetap ditahan seluruhnya.
    const separuh = checkLine(line({
        discounts: [{ position: 4, percent: 3 }, { position: 5, percent: 2 }], reportDiscount: 16021.62,
        rules: [aturan({ benefitValue: "3" })],
    }));
    assert.equal(separuh.status, "review");
});

test("aturan yang sudah lewat masa berlakunya tidak menjelaskan apa pun", () => {
    const berlaku = aturan({ periodStart: "2026-09-01", periodEnd: "2026-09-30" });
    assert.equal(aturanBerlaku(berlaku, "2026-09-12"), true);
    assert.equal(aturanBerlaku(berlaku, "2026-09-01"), true);
    assert.equal(aturanBerlaku(berlaku, "2026-09-30"), true);
    assert.equal(aturanBerlaku(berlaku, "2026-10-01"), false);
    assert.equal(aturanBerlaku(berlaku, "2026-08-31"), false);
});

test("ATURAN tanpa tanggal tidak berlaku kapan pun; KEANGGOTAAN tanpa tanggal berlaku terus", () => {
    // Aturan promo WAJIB berperiode. Sampai 20 September 2026 aturan tanpa tanggal akhir
    // membenarkan potongan SELAMANYA — satu salah ketik `PERIODE` di Excel cukup membuatnya,
    // dan mesin Python sudah menolaknya sejak awal sementara jalur faktur ini menerimanya.
    assert.equal(aturanBerlaku(aturan({ periodStart: "2026-09-01", periodEnd: null }), "2030-12-31"), false);
    assert.equal(aturanBerlaku(aturan({ periodStart: null, periodEnd: "2026-09-30" }), "2000-01-01"), false);
    assert.equal(aturanBerlaku(aturan({ periodStart: null, periodEnd: null }), "2026-09-15"), false);

    // KEANGGOTAAN daftar outlet BEDA, dan bedanya disengaja: lampiran daftar outlet sebuah
    // surat tidak membawa tanggalnya sendiri — dua anggota daftar `BP2609007909` di produksi
    // memang berperiode kosong, dan yang membatasi masa berlakunya adalah periode ATURANnya.
    // Menutup ujung yang kosong di sini akan mencabut kedua outlet itu dan membuat 123 aturan
    // ON PO berhenti berlaku untuk siapa pun.
    const anggota = [{ listName: "BP2609007909", customerCode: "C-BA0003", periodStart: null, periodEnd: null, active: true }];
    assert.equal(outletListsOn(anggota, "2026-09-15").get("BP2609007909")?.has("C-BA0003"), true);
    assert.equal(outletListsOn(anggota, "2030-01-01").get("BP2609007909")?.has("C-BA0003"), true);
});

test("baris bonus: potongan 100% dijelaskan aturan BONUS_QTY, bebannya principal", () => {
    // Bentuk nyata baris bonus: harga penuh lalu dipotong 100% di POSISI 1 (kolom distributor),
    // sementara suratnya menulis "beli 30 gratis 1" — BONUS_QTY, bukan persen. Gerbang dan
    // Rekap Promo wajib menjawab sama: dijelaskan, dan beban PRINCIPAL sesuai suratnya.
    const bonusRule: PublishedRule = {
        suratProgram: "BP2609007713", promoGroup: "RESIK V KHASIAT MANJAKANI",
        itemCode: "K1010001006010", customerCode: "", tierNo: 1,
        triggerQty: 30, triggerUnit: "PCS",
        benefitType: "BONUS_QTY", benefitValue: "1", benefitBeban: "PRINCIPAL",
    };
    const bonusLine = { bonus: true, discounts: [{ position: 1, percent: 100 }], reportDiscount: 324324.32 };

    const lolos = checkLine(line({ ...bonusLine, rules: [bonusRule] }));
    assert.equal(lolos.status, "ok");
    assert.equal(lolos.split.principal, 324324.32);
    assert.equal(lolos.split.distributor, 0);

    // Tanpa aturannya baris yang sama TETAP tertahan: angka 100 bukan surat.
    assert.equal(checkLine(line({ ...bonusLine, rules: [] })).status, "review");
    // Aturan bonus milik barang lain tidak meloloskannya.
    assert.equal(checkLine(line({ ...bonusLine, rules: [{ ...bonusRule, itemCode: "K9999" }] })).status, "review");
    // 100% BERSAMA potongan lain bukan baris bonus — itu keadaan yang belum pernah ada.
    const campuran = checkLine(line({ bonus: true, rules: [bonusRule], reportDiscount: 324324.32,
        discounts: [{ position: 1, percent: 100 }, { position: 4, percent: 3 }] }));
    assert.equal(campuran.status, "review");
});

test("daftar outlet peserta: INCLUDE hanya peserta, EXCLUDE justru sebaliknya", () => {
    // Bunyi suratnya sendiri: BP2609007713/BP2609007664 "KHUSUS CHANNEL GT PESERTA LOYALTY",
    // BP2609006016 "EXCLUDE LOYALTY". Satu daftar, dua arah.
    const lists = outletListsOn([
        { listName: "LOYALTY", customerCode: "C-WIN013", periodStart: "2026-07-01", periodEnd: "2026-09-30" },
        { listName: "LOYALTY", customerCode: "C-KOS005" },
    ], "2026-09-15");

    const hanya = { outletList: "LOYALTY", outletListMode: "INCLUDE" };
    const kecuali = { outletList: "LOYALTY", outletListMode: "EXCLUDE" };
    assert.equal(outletAllowed(hanya, "C-WIN013-KN", lists), true);
    assert.equal(outletAllowed(hanya, "C-NOV009-KN", lists), false);
    assert.equal(outletAllowed(kecuali, "C-WIN013-KN", lists), false);
    assert.equal(outletAllowed(kecuali, "C-NOV009-KN", lists), true);

    // Aturan tanpa daftar tidak tersentuh sama sekali — 234 baris yang sudah termuat.
    assert.equal(outletAllowed({}, "C-NOV009-KN", lists), true);

    // DUA DAFTAR, SATU BELUM DIUNGGAH. Keputusan pengguna 18 Sep 2026: yang dipakai hanya daftar
    // yang sudah ada isinya. Surat MSG berbunyi "exclude LOYALTY DAN CONTRACTUAL" sementara
    // CONTRACTUAL belum pernah diunggah; menahan seluruh programnya berarti tidak seorang pun
    // dapat potongan yang memang dijanjikan, padahal LOYALTY-nya sudah diketahui.
    const duaKecuali = { outletList: "LOYALTY,CONTRACTUAL", outletListMode: "EXCLUDE" };
    assert.equal(outletAllowed(duaKecuali, "C-WIN013-KN", lists), false);   // peserta LOYALTY: tetap dikecualikan
    assert.equal(outletAllowed(duaKecuali, "C-NOV009-KN", lists), true);    // bukan peserta: tetap dapat
    const duaHanya = { outletList: "LOYALTY,CONTRACTUAL", outletListMode: "INCLUDE" };
    assert.equal(outletAllowed(duaHanya, "C-WIN013-KN", lists), true);
    assert.equal(outletAllowed(duaHanya, "C-NOV009-KN", lists), false);

    // TETAPI kalau TIDAK SATU PUN daftarnya terisi, gagal-tertutup tetap berlaku: kita tidak tahu
    // apa-apa tentang siapa, jadi tidak ada yang diloloskan. Ini yang menahan aturan ON PO selama
    // daftar pesertanya belum diunggah.
    const semuaKosong = { outletList: "CONTRACTUAL,HYBRID", outletListMode: "EXCLUDE" };
    assert.equal(outletAllowed(semuaKosong, "C-NOV009-KN", lists), false);
    assert.equal(outletAllowed({ outletList: "CONTRACTUAL", outletListMode: "INCLUDE" }, "C-WIN013-KN", lists), false);

    // Awalan dipenggal di tanda hubung: C-WIN01 tidak boleh ikut mengesahkan C-WIN013.
    assert.equal(outletAllowed(hanya, "C-WIN0131-KN", lists), false);

    // Keanggotaan berperiode: di luar periodenya, outlet itu BUKAN peserta.
    const oktober = outletListsOn([
        { listName: "LOYALTY", customerCode: "C-WIN013", periodStart: "2026-07-01", periodEnd: "2026-09-30" },
    ], "2026-10-01");
    assert.equal(outletAllowed(hanya, "C-WIN013-KN", oktober), false);
    // EXCLUDE pada daftar yang kehabisan anggota juga TIDAK berlaku (keputusan pengguna
    // 15 Sep 2026). Daftar kosong tidak berarti "tidak ada yang dikecualikan"; ia berarti kita
    // tidak tahu siapa yang dikecualikan, dan yang tidak diketahui ditahan. Sebelum ini
    // keanggotaan kuartal yang belum diunggah membuat potongan MSG jatuh ke SEMUA outlet.
    assert.equal(outletAllowed(kecuali, "C-WIN013-KN", oktober), false);

    // GAGAL TERTUTUP: daftar yang namanya salah ketik membuat aturannya tidak berlaku untuk
    // siapa pun, bukan berlaku untuk semua orang.
    assert.equal(outletAllowed({ outletList: "LOYALTI", outletListMode: "INCLUDE" }, "C-WIN013-KN", lists), false);

    // Anggota yang dinonaktifkan tidak ikut terbaca.
    const mati = outletListsOn([{ listName: "LOYALTY", customerCode: "C-WIN013", active: false }], "2026-09-15");
    assert.equal(outletAllowed(hanya, "C-WIN013-KN", mati), false);
});

test("gerbang menahan bonus yang jatuh ke outlet BUKAN peserta", () => {
    const bonusRule: PublishedRule = {
        suratProgram: "BP2609007713", promoGroup: "RESIK V KHASIAT MANJAKANI",
        itemCode: "K1010001006010", customerCode: "", tierNo: 1, triggerQty: 30, triggerUnit: "PCS",
        benefitType: "BONUS_QTY", benefitValue: "1", benefitBeban: "PRINCIPAL",
        outletList: "LOYALTY", outletListMode: "INCLUDE",
    };
    const bonusLine = { bonus: true, discounts: [{ position: 1, percent: 100 }], reportDiscount: 324324.32 };

    // Pemanggil (route) yang menyaring; di sini dibuktikan bahwa aturan yang TIDAK lolos
    // saringan itu memang tidak menjelaskan apa pun — bukan lolos karena isinya kebetulan cocok.
    const lists = outletListsOn([{ listName: "LOYALTY", customerCode: "C-WIN013" }], "2026-09-15");
    const peserta = [bonusRule].filter((rule) => outletAllowed(rule, "C-WIN013-KN", lists));
    const bukan = [bonusRule].filter((rule) => outletAllowed(rule, "C-GAL006-KN", lists));
    assert.equal(checkLine(line({ ...bonusLine, rules: peserta })).status, "ok");
    assert.equal(checkLine(line({ ...bonusLine, rules: bukan })).status, "review");
});

test("kuota bonus: beli 10 pcs TIDAK boleh dapat bonus", () => {
    // Ketakutan yang disebut pengguna, dan memang jalur yang sebelumnya terbuka: baris bonus
    // diperiksa sendirian, sementara jumlah belinya ada di baris LAIN.
    const aturan = [{ itemCode: "K137A", suratProgram: "BP2609007713", promoGroup: "RESIK V KHASIAT MANJAKANI", triggerQty: 30, benefitValue: "1" }];
    const kurang = bonusQuota([
        { key: "beli", itemCode: "K137A", quantity: 10, bonus: false },
        { key: "bonus", itemCode: "K137A", quantity: 1, bonus: true },
    ], aturan);
    assert.equal(kurang[0].purchased, 10);
    assert.equal(kurang[0].entitled, 0);
    assert.equal(kurang[0].given, 1);
    assert.deepEqual(kurang[0].overKeys, ["bonus"]);

    // Tepat 30 berhak satu, dan tidak lebih.
    const pas = bonusQuota([
        { key: "beli", itemCode: "K137A", quantity: 30, bonus: false },
        { key: "b1", itemCode: "K137A", quantity: 1, bonus: true },
    ], aturan);
    assert.equal(pas[0].entitled, 1);
    assert.deepEqual(pas[0].overKeys, []);

    // 59 masih satu: kelipatan PENUH, bukan pembulatan.
    assert.equal(bonusQuota([{ key: "b", itemCode: "K137A", quantity: 59, bonus: false }], aturan)[0].entitled, 1);
});

test("kuota bonus dihitung per KELOMPOK MIX, dengan satuan sudah diseragamkan", () => {
    // Angka nyata INV/2609/KN00453: beli 12 KRT isi 72 (=864) + 3 KRT isi 36 (=108) pada satu
    // kelompok mix, bonus 28 + 3 = 31 BTL. 972 / 30 = 32 -> masih dalam kuota.
    const aturan = [
        { itemCode: "K1370000005010", suratProgram: "BP2609007713", promoGroup: "RESIK V KHASIAT MANJAKANI", triggerQty: 30, benefitValue: "1" },
        { itemCode: "K1370000009010", suratProgram: "BP2609007713", promoGroup: "RESIK V KHASIAT MANJAKANI", triggerQty: 30, benefitValue: "1" },
        { itemCode: "K1370001009010", suratProgram: "BP2609007713", promoGroup: "RESIK V MANJAKANI WHITENING", triggerQty: 30, benefitValue: "1" },
    ];
    const hasil = bonusQuota([
        { key: "a", itemCode: "K1370000005010", quantity: 864, bonus: false },
        { key: "b", itemCode: "K1370000005010", quantity: 28, bonus: true },
        { key: "c", itemCode: "K1370000009010", quantity: 108, bonus: false },
        { key: "d", itemCode: "K1370000009010", quantity: 3, bonus: true },
        { key: "e", itemCode: "K1370001009010", quantity: 252, bonus: false },
        { key: "f", itemCode: "K1370001009010", quantity: 8, bonus: true },
    ], aturan);
    const manjakani = hasil.find((g) => g.promoGroup === "RESIK V KHASIAT MANJAKANI")!;
    assert.equal(manjakani.purchased, 972);
    assert.equal(manjakani.entitled, 32);
    assert.equal(manjakani.given, 31);
    assert.deepEqual(manjakani.overKeys, []);

    // Kelompok lain dihitung sendiri: 252 / 30 = 8, diberi 8 — pas.
    const whitening = hasil.find((g) => g.promoGroup === "RESIK V MANJAKANI WHITENING")!;
    assert.equal(whitening.entitled, 8);
    assert.deepEqual(whitening.overKeys, []);

    // Kalau pembeliannya dipindah ke kelompok lain, bonusnya TIDAK ikut berhak.
    const salahKelompok = bonusQuota([
        { key: "a", itemCode: "K1370001009010", quantity: 900, bonus: false },
        { key: "b", itemCode: "K1370000005010", quantity: 5, bonus: true },
    ], aturan);
    assert.deepEqual(salahKelompok.find((g) => g.promoGroup === "RESIK V KHASIAT MANJAKANI")!.overKeys, ["b"]);
});

test("kuota bonus: baris tidak pernah dipecah, dan yang lewat disebut satu per satu", () => {
    const aturan = [{ itemCode: "K1", suratProgram: "S", promoGroup: "G", triggerQty: 30, benefitValue: "1" }];
    const hasil = bonusQuota([
        { key: "beli", itemCode: "K1", quantity: 60, bonus: false },   // berhak 2
        { key: "b1", itemCode: "K1", quantity: 1, bonus: true },
        { key: "b2", itemCode: "K1", quantity: 1, bonus: true },
        { key: "b3", itemCode: "K1", quantity: 1, bonus: true },       // kelebihan
    ], aturan);
    assert.equal(hasil[0].entitled, 2);
    assert.deepEqual(hasil[0].overKeys, ["b3"]);

    // Baris yang membuat kumulatif melewati kuota dianggap lewat SELURUHNYA.
    const utuh = bonusQuota([
        { key: "beli", itemCode: "K1", quantity: 60, bonus: false },
        { key: "borongan", itemCode: "K1", quantity: 10, bonus: true },
    ], aturan);
    assert.deepEqual(utuh[0].overKeys, ["borongan"]);

    // Tanpa ambang (surat tidak menyebut minimum), tidak ada kuota yang bisa ditegakkan.
    const tanpa = bonusQuota([
        { key: "b", itemCode: "K1", quantity: 99, bonus: true },
    ], [{ ...aturan[0], triggerQty: 0 }]);
    assert.deepEqual(tanpa[0].overKeys, []);
});

test("gerbang MENAHAN baris bonus yang melewati kuota, meski aturannya ada", () => {
    const bonusRule: PublishedRule = {
        suratProgram: "BP2609007713", promoGroup: "RESIK V KHASIAT MANJAKANI",
        itemCode: "K1010001006010", customerCode: "", tierNo: 1, triggerQty: 30, triggerUnit: "PCS",
        benefitType: "BONUS_QTY", benefitValue: "1", benefitBeban: "PRINCIPAL",
    };
    const bonusLine = { bonus: true, discounts: [{ position: 1, percent: 100 }], reportDiscount: 324324.32 };

    // Kuotanya dihitung pemanggil; di sini dibuktikan bahwa alasannya MENAHAN barisnya, dan
    // aturan yang ada tidak lagi menjelaskannya.
    const lewat = checkLine(line({
        ...bonusLine, rules: [bonusRule],
        bonusOverQuota: "Bonus melewati kuota RESIK V KHASIAT MANJAKANI: pembelian 10 berhak 0, tetapi diberikan 1.",
    }));
    assert.equal(lewat.status, "review");
    assert.match(lewat.findings.join(" "), /melewati kuota/);
    // Bebannya TIDAK dipindah ke principal: yang tidak dijelaskan tidak boleh diakui bisa ditagih.
    assert.equal(lewat.split.principal, 0);

    // Tanpa alasan kuota, baris yang sama tetap lolos seperti biasa.
    assert.equal(checkLine(line({ ...bonusLine, rules: [bonusRule] })).status, "ok");
});

/* ---------------------------------------------------------------- CHANNEL dan daftar kosong

   Dua lubang yang ditemukan pengguna 15 Sep 2026, keduanya GAGAL TERBUKA sebelum ini:
   surat ber-"CHANNEL GT" berlaku untuk outlet MT, dan aturan EXCLUDE yang daftarnya kosong
   berlaku untuk semua orang. */

test("GT = TT saja; kategori master yang lain tidak ikut mendapat promo GT", () => {
    assert.equal(channelOutlet("TT"), "GT");
    assert.equal(channelOutlet("MT"), "MT");
    assert.equal(channelOutlet("NKA"), "NKA");
    assert.equal(channelOutlet("Umum"), "UMUM");
    assert.equal(channelOutlet(null), "", "kategori kosong berarti channelnya tidak diketahui");

    const gt = { channel: "GT" };
    assert.equal(channelAllowed(gt, channelOutlet("TT")), true);
    assert.equal(channelAllowed(gt, channelOutlet("MT")), false);
    assert.equal(channelAllowed(gt, channelOutlet("Umum")), false);
    // Outlet yang kategorinya belum diisi TIDAK lolos aturan ber-channel: yang tidak diketahui
    // ditahan, sama seperti daftar peserta yang kosong.
    assert.equal(channelAllowed(gt, ""), false);
    // Aturan tanpa channel berlaku di mana saja — bentuk sebagian besar surat.
    assert.equal(channelAllowed({ channel: "" }, ""), true);
    assert.equal(channelAllowed({ channel: "ALL" }, channelOutlet("MT")), true);
});

test("aturan EXCLUDE yang daftarnya KOSONG tidak berlaku untuk siapa pun, bukan untuk semua", () => {
    const rule = { outletList: "LOYALTY", outletListMode: "EXCLUDE" };
    const adaAnggota = outletListsOn(
        [{ listName: "LOYALTY", customerCode: "C-AD0021", periodStart: "2026-10-01", periodEnd: "2026-12-31" }],
        "2026-10-15");
    // Dengan anggota: peserta dikecualikan, bukan peserta dapat. Ini perilaku yang benar.
    assert.equal(outletAllowed(rule, "C-AD0021-KN", adaAnggota), false);
    assert.equal(outletAllowed(rule, "C-BA0003-KN", adaAnggota), true);

    // Tanpa anggota pada tanggal itu — nama salah ketik, atau keanggotaan kuartal berikutnya
    // belum diunggah — aturannya TIDAK berlaku untuk siapa pun. Sebelum ini ia berlaku untuk
    // semua orang, termasuk outlet yang justru dikecualikan suratnya.
    const kosong = outletListsOn([], "2026-10-15");
    assert.equal(outletAllowed(rule, "C-BA0003-KN", kosong), false);
    assert.equal(outletAllowed(rule, "C-AD0021-KN", kosong), false);
    // Keanggotaan yang sudah lewat periodenya sama saja dengan tidak ada.
    const kedaluwarsa = outletListsOn(
        [{ listName: "LOYALTY", customerCode: "C-AD0021", periodStart: "2026-07-01", periodEnd: "2026-09-30" }],
        "2026-10-15");
    assert.equal(outletAllowed(rule, "C-BA0003-KN", kedaluwarsa), false);
});

test("daftar kosong dilaporkan dengan nama surat yang memakainya", () => {
    const pesan = daftarKosong([
        { outletList: "LOYALTY", outletListMode: "EXCLUDE", suratProgram: "BP2609006016" },
        { outletList: "LOYALTY", outletListMode: "INCLUDE", suratProgram: "BP2609007713" },
        { outletList: "", suratProgram: "BP2609007909" },
    ], outletListsOn([], "2026-10-15"));
    assert.equal(pesan.length, 1);
    assert.match(pesan[0], /LOYALTY/);
    assert.match(pesan[0], /BP2609006016, BP2609007713/);
    assert.doesNotMatch(pesan[0], /BP2609007909/, "aturan tanpa daftar tidak ada urusannya");
});

test("channel laporan principal diterjemahkan, yang tak dikenal TIDAK ditebak", () => {
    assert.equal(channelLaporan("General Trade"), "GT");
    assert.equal(channelLaporan("Modern Trade"), "MT");
    assert.equal(channelLaporan("GT"), "GT");
    assert.equal(channelLaporan("Wholesale"), "", "istilah baru tidak boleh ditebak jadi GT atau MT");
    assert.equal(channelLaporan(""), "");
});

/* ---------------------------------------------------------------- AMBANG per barang non-bonus

   Sampai 2026-09-15 `trigger_qty` pada aturan per barang non-bonus hanyalah keterangan:
   pencocoknya melihat PERSEN saja. "Beli 30 pcs dapat 3%" yang diberikan pada pembelian 5 pcs
   lolos sempurna — barangnya benar, persennya benar, dan tidak ada yang bertanya berapa dibeli. */

const aturanAmbang = (over: Partial<PublishedRule> = {}): PublishedRule => ({
    suratProgram: "BP2610001234", promoGroup: "B&B ALL VARIANT", itemCode: "K1041101030010",
    customerCode: "", tierNo: 4, triggerQty: 30, triggerUnit: "PCS",
    benefitType: "DISC_PCT", benefitValue: "3", benefitBeban: "PRINCIPAL", ...over,
});

test("ambang PCS dinilai dari belanja SE-SO, bukan per baris", () => {
    const rules = [aturanAmbang()];
    // Satu SO, barang sama, dua baris bersatuan berbeda — persis bentuk INV/2609/KN00453.
    const belanja = purchaseByGroup([
        { itemCode: "K1041101030010", quantity: 24, gross: 200_000 },
        { itemCode: "K1041101030010", quantity: 12, gross: 100_000 },
    ], rules);
    const kunci = triggerGroupKey(rules[0]);
    assert.equal(belanja.get(kunci)?.qty, 36);
    assert.equal(triggerReached(rules[0], belanja.get(kunci)).ok, true);

    // Per baris, 24 dan 12 dua-duanya di bawah 30 — dan menahannya akan menuduh pembelian yang sah.
    const kurang = purchaseByGroup([{ itemCode: "K1041101030010", quantity: 12, gross: 100_000 }], rules);
    const hasil = triggerReached(rules[0], kurang.get(kunci));
    assert.equal(hasil.ok, false);
    assert.match((hasil as { reason: string }).reason, /12 PCS, belum mencapai ambang 30 PCS/);
});

test("ambang dijumlah per KELOMPOK, karena suratnya berkata MIX VARIANT", () => {
    const rules = [
        aturanAmbang({ itemCode: "K1041101030010" }),
        aturanAmbang({ itemCode: "K1090003005010" }),
    ];
    const belanja = purchaseByGroup([
        { itemCode: "K1041101030010", quantity: 20, gross: 150_000 },
        { itemCode: "K1090003005010", quantity: 15, gross: 120_000 },
    ], rules);
    // 20 varian A + 15 varian B = 35, memenuhi ambang 30 walau tidak satu pun mencapainya sendiri.
    assert.equal(triggerReached(rules[0], belanja.get(triggerGroupKey(rules[0]))).ok, true);

    // Kelompok LAIN tidak ikut menolong: aturan yang kelompoknya berbeda dinilai sendiri.
    const lain = aturanAmbang({ promoGroup: "RESIK V CAIR", itemCode: "K1370000005010" });
    assert.equal(triggerReached(lain, belanja.get(triggerGroupKey(lain))).ok, false);
});

test("baris BONUS tidak ikut dihitung sebagai pembelian", () => {
    const rules = [aturanAmbang()];
    const belanja = purchaseByGroup([
        { itemCode: "K1041101030010", quantity: 25, gross: 200_000 },
        { itemCode: "K1041101030010", quantity: 10, gross: 80_000, bonus: true },
    ], rules);
    // 25 beli + 10 bonus = 35, tetapi bonusnya hadiah — bukan belanja yang memenuhi syaratnya sendiri.
    assert.equal(belanja.get(triggerGroupKey(rules[0]))?.qty, 25);
    assert.equal(triggerReached(rules[0], belanja.get(triggerGroupKey(rules[0]))).ok, false);
});

test("ambang RUPIAH dinilai TERMASUK PPN, mengikuti bukti program MSG", () => {
    const rule = aturanAmbang({ triggerQty: 1_000_000, triggerUnit: "RP" });
    // DPP 910.000 -> dengan PPN 1.010.100, melewati ambang sejuta.
    assert.equal(triggerReached(rule, { qty: 0, value: 910_000 }).ok, true);
    // DPP 800.000 -> dengan PPN 888.000, belum.
    const kurang = triggerReached(rule, { qty: 0, value: 800_000 });
    assert.equal(kurang.ok, false);
    assert.match((kurang as { reason: string }).reason, /belum mencapai ambang Rp 1.000.000/);
});

test("ambang bersatuan KRT TIDAK ditebak, dan tidak dianggap terpenuhi", () => {
    // Isi karton berbeda tiap barang; mengubah "5 KRT" jadi angka satuan terkecil berarti
    // mengarang isi yang tidak tertulis di aturannya.
    const rule = aturanAmbang({ triggerQty: 5, triggerUnit: "KRT" });
    const hasil = triggerReached(rule, { qty: 10_000, value: 99_000_000 });
    assert.equal(hasil.ok, false, "belanja sebesar apa pun tidak boleh mengesahkan ambang yang tidak terbaca");
    assert.match((hasil as { reason: string }).reason, /Tulis ambangnya dalam satuan terkecil/);
});

test("ambang nol atau kosong berarti tanpa syarat beli — bentuk 105 aturan produksi", () => {
    for (const q of [0, undefined]) {
        assert.equal(triggerReached(aturanAmbang({ triggerQty: q as number }), undefined).ok, true);
    }
    // Ambang 1 (bentuk BP2609007909 sesudah default "setiap pembelian") terpenuhi oleh 1 pcs.
    assert.equal(triggerReached(aturanAmbang({ triggerQty: 1 }), { qty: 1, value: 100 }).ok, true);
    assert.equal(triggerReached(aturanAmbang({ triggerQty: 1 }), { qty: 0, value: 0 }).ok, false);
});

test("ambang MSG dan bonus TIDAK disaring di sini — pemeriksanya sudah ada masing-masing", () => {
    // Kalau keduanya ikut tersaring, mereka hilang dari daftar aturan sebelum `checkSoPromo`
    // dan `bonusQuota` sempat melihat — dan program MSG yang selama ini benar berhenti dikenali
    // tanpa satu pun galat.
    assert.equal(needsTriggerCheck({ itemCode: "", benefitType: "DISC_RP" }), false, "tingkat faktur (MSG)");
    assert.equal(needsTriggerCheck({ itemCode: "K1", benefitType: "BONUS_QTY" }), false, "bonus");
    assert.equal(needsTriggerCheck({ itemCode: "", customerCode: "C-AL0063", benefitType: "DISC_PCT" }), false, "tarif outlet");
    assert.equal(needsTriggerCheck({ itemCode: "K1", benefitType: "DISC_PCT" }), true, "inilah yang belum dijaga");
});

test("baris bonus TIDAK diadu dengan laporan principal yang nol", () => {
    // Bonus barang masuk faktur Accurate sebagai baris berharga penuh lalu dipotong 100%; laporan
    // principal menyebutnya BONUS, jadi kolom diskonnya nol. Keduanya benar. Contoh nyata batch
    // 15 September: ALUBI KOSMETIK, OVALE FACIAL LOTION — 396 PCS dibeli, 13 bonus diterima
    // (berhak 13,2; 0,2 PCS tidak mungkin diberikan), potongan principal Rp 0.
    const bonus = checkLine(line({ discounts: [{ position: 1, percent: 100 }], reportDiscount: 0 }));
    assert.equal(bonus.findings.filter((f) => f.includes("berbeda dari laporan")).length, 0,
        bonus.findings.join(" | "));

    // Yang TIDAK dilonggarkan: kalau principal justru MELAPORKAN potongan pada baris bonus,
    // salah satu pihak salah dan itu tetap harus terlihat.
    const bonusTapiDilaporkan = checkLine(line({ discounts: [{ position: 1, percent: 100 }], reportDiscount: 50000 }));
    assert.match(bonusTapiDilaporkan.findings.join(" "), /berbeda dari laporan principal/);

    // Diskon biasa 100% bukan bonus? Tidak ada bentuk seperti itu — 100% di satu posisi memang
    // definisi baris bonus. Yang dijaga di sini: diskon WAJAR tetap diadu seperti biasa.
    const biasa = checkLine(line({ discounts: [{ position: 1, percent: 4 }], reportDiscount: 0 }));
    assert.match(biasa.findings.join(" "), /berbeda dari laporan principal/);
});

test("MSG: selisih koma-koma pembulatan sampai Rp 100 tidak ditahan, beda tier tetap ditahan", () => {
    // Kasus nyata TK RAMADHANI COS, batch 15 September: tier 3 Rp 60.000, klaim DPP 54.070,26
    // -> dengan PPN 60.017,99. Selisih Rp 17,99 dari nota Rp 4,2 juta, murni sisa pembulatan
    // per baris yang dikalikan PPN. Toleransi Rp 1/baris tidak menampungnya dan menuduh klaim
    // yang benar.
    const tiers = [
        msg(), msg({ tierNo: 2, triggerQty: 2_000_000, benefitValue: "40000" }),
        msg({ tierNo: 3, triggerQty: 3_000_000, benefitValue: "60000" }),
    ];
    const ramadhani = checkSoPromo({ gross: 3_800_000, principalClaim: 54_070.26, lineCount: 3 }, tiers);
    assert.match(ramadhani.explained, /tier 3/);
    assert.deepEqual(ramadhani.findings, [], ramadhani.findings.join(" | "));

    // Rp 100 masih JAUH di bawah beda tier terkecil (Rp 20.000), jadi tier yang salah tetap
    // tertahan — toleransi ini menyembunyikan koma, bukan kesalahan tier.
    const tierSalah = checkSoPromo({ gross: 3_800_000, principalClaim: 36_036.04, lineCount: 3 }, tiers);
    assert.equal(tierSalah.explained, "");
    assert.ok(tierSalah.findings[0].includes("60.000"), tierSalah.findings.join(" | "));
});

test("aturan yang menunjuk DUA daftar menggabungkannya, dan gagal tertutup bila salah satunya kosong", () => {
    // "EXCLUDE LOYALTY DAN CONTRACTUAL" — peserta salah satu daftar ikut dikecualikan.
    const rule = { outletList: "CONTRACTUAL,LOYALTY", outletListMode: "EXCLUDE" };
    const keduanya = outletListsOn([
        { listName: "LOYALTY", customerCode: "C-AD0021" },
        { listName: "CONTRACTUAL", customerCode: "C-BA0003" },
    ], "2026-09-15");
    assert.equal(outletAllowed(rule, "C-AD0021-KN", keduanya), false);
    assert.equal(outletAllowed(rule, "C-BA0003-KN", keduanya), false);
    assert.equal(outletAllowed(rule, "C-WA0012-KN", keduanya), true);

    // CONTRACTUAL belum diunggah, LOYALTY sudah. Keputusan pengguna 18 Sep 2026 MEMBALIK aturan
    // lama di sini: yang dipakai hanya daftar yang sudah ada isinya, jadi ini dibaca "exclude
    // LOYALTY saja" dan programnya tetap berjalan. Sebelumnya seluruh aturan ditahan, dan
    // akibatnya tidak seorang pun menerima potongan yang memang dijanjikan surat.
    //
    // Harganya disengaja: outlet CONTRACTUAL ikut menerima potongan sampai daftarnya diunggah.
    // `daftarKosong` tetap menyebut nama daftar yang hilang supaya itu tidak lewat diam-diam.
    const sebagian = outletListsOn([{ listName: "LOYALTY", customerCode: "C-AD0021" }], "2026-09-15");
    assert.equal(outletAllowed(rule, "C-WA0012-KN", sebagian), true);
    assert.equal(outletAllowed(rule, "C-AD0021-KN", sebagian), false);
    // Yang TIDAK berubah: tidak satu pun daftar terisi = tetap ditahan.
    assert.equal(outletAllowed(rule, "C-WA0012-KN", outletListsOn([], "2026-09-15")), false);
    // Peringatannya harus menyebut akibat yang BENAR: daftarnya dilewati, bukan barisnya ditahan.
    const peringatan = daftarKosong([rule], sebagian);
    assert.equal(peringatan.length, 1);
    assert.ok(peringatan[0].includes("CONTRACTUAL") && peringatan[0].includes("BERJALAN TANPA"), peringatan[0]);
    const ditahan = daftarKosong([rule], outletListsOn([], "2026-09-15"));
    assert.ok(ditahan[0].includes("barisnya ditahan"), ditahan[0]);

    // INCLUDE dua daftar: peserta salah satunya berhak.
    const dua = { outletList: "CONTRACTUAL,LOYALTY", outletListMode: "INCLUDE" };
    assert.equal(outletAllowed(dua, "C-AD0021-KN", keduanya), true);
    assert.equal(outletAllowed(dua, "C-WA0012-KN", keduanya), false);

    // Yang hilang disebut namanya sendiri, bukan pasangannya.
    const pesan = daftarKosong([{ ...rule, suratProgram: "BP2609006016" }], sebagian);
    assert.equal(pesan.length, 1);
    assert.match(pesan[0], /CONTRACTUAL/);
});

/* ---------------------------------------------------------------- JARINGAN: posisi dimaklumi, nilai tidak

   ORDER_DETAIL 16 Sep 2026: ALFAMART C-AL0063 dilaporkan Kino DISC_1 4 lalu DISC_4 2,25, sedangkan
   tarifnya posisi 1 4% dan posisi 2 2,25%, keduanya tanggungan distributor. Keputusan pengguna
   2026-09-24: untuk Indomaret, Alfamart, Indogrosir, dan Alfamidi posisi yang salah dimaklumi,
   nilai yang berbeda dari tarif ditolak — "3.96+3.1+3.1 itu baru ditolak". */

const alfa = (over: Partial<PublishedRule> = {}) => tarif({ customerCode: "C-AL0063", benefitValue: "4", ...over });
const indomaret = [tarif({ customerCode: "C-IN0050", benefitValue: "3.96" }),
    tarif({ customerCode: "C-IN0050", tierNo: 2, benefitValue: "3.1" })];

test("jaringan: persen yang posisinya salah dipindah ke posisi tarifnya", () => {
    const tarifAlfa = [alfa(), alfa({ tierNo: 2, benefitValue: "2.25" })];
    const hasil = normalisasiJaringan([{ position: 1, percent: 4 }, { position: 4, percent: 2.25 }], tarifAlfa, "K1330001020010");
    assert.equal(hasil.finding, undefined);
    assert.deepEqual(hasil.discounts, [{ position: 1, percent: 4 }, { position: 2, percent: 2.25, reportPosition: 4 }]);

    // Barisnya lolos, bebannya distributor, total tetap sama dengan laporan.
    const cek = checkLine(line({ gross: 901621.62, reportDiscount: 55539.89, discounts: hasil.discounts, rules: tarifAlfa }));
    assert.equal(cek.status, "ok", cek.findings.join(" | "));
    assert.equal(cek.split.principal, 0);
    assert.equal(cek.split.distributor, 55539.89);

    // Urutan tertukar pun dimaklumi: yang dinilai nilainya, bukan kolomnya.
    assert.deepEqual(normalisasiJaringan([{ position: 1, percent: 3.1 }, { position: 4, percent: 3.96 }], indomaret, "K1").discounts,
        [{ position: 1, percent: 3.96, reportPosition: 4 }, { position: 2, percent: 3.1, reportPosition: 1 }]);

    // Kurang dari tarif bukan kerugian perusahaan: tidak ditahan.
    assert.equal(normalisasiJaringan([{ position: 1, percent: 3.96 }], indomaret, "K1").finding, undefined);

    // Validasi ULANG memakai posisi LAPORAN: tarif dicabut -> kembali ke DISC_4, tidak tertinggal di posisi 2.
    assert.deepEqual(normalisasiJaringan(hasil.discounts, [alfa()], "K1").discounts,
        [{ position: 1, percent: 4 }, { position: 4, percent: 2.25 }]);
    assert.deepEqual(normalisasiJaringan(hasil.discounts, tarifAlfa, "K1").discounts, hasil.discounts, "berulang kali hasilnya sama");
});

test("jaringan: nilai yang tidak ada di tarif DITOLAK, dengan sebabnya", () => {
    // Contoh pengguna: 3,96 + 3,1 + 3,1 lawan tarif 3,96 + 3,1 -> kelebihan 3,1 tidak punya dasar.
    const d = [{ position: 1, percent: 3.96 }, { position: 4, percent: 3.1 }, { position: 5, percent: 3.1 }];
    const hasil = normalisasiJaringan(d, indomaret, "K1");
    assert.deepEqual(hasil.discounts, d, "barisnya dikembalikan apa adanya");
    assert.match(hasil.finding ?? "", /3\.96 \+ 3\.1 \+ 3\.1 tidak sama dengan tarif outlet ini \(3\.96 \+ 3\.1\): 3\.1% di DISC_5/);

    // Nilai berbeda (3% lawan 3,1%) juga ditolak — keputusan Indomaret 14 Sep: tarifnya 3,1 bukan 3.
    assert.match(normalisasiJaringan([{ position: 1, percent: 3.96 }, { position: 4, percent: 3 }], indomaret, "K1").finding ?? "", /3% di DISC_4/);

    // Surat principal untuk barang itu membenarkan persen tambahannya -> tetap di posisinya.
    const surat = aturan({ itemCode: "K1", benefitValue: "3" });
    const denganSurat = normalisasiJaringan([{ position: 1, percent: 3.96 }, { position: 4, percent: 3.1 }, { position: 5, percent: 3 }],
        [...indomaret, surat], "K1");
    assert.equal(denganSurat.finding, undefined);
    assert.deepEqual(denganSurat.discounts,
        [{ position: 1, percent: 3.96 }, { position: 2, percent: 3.1, reportPosition: 4 }, { position: 5, percent: 3 }]);

    // Tanpa tarif tidak ada acuan posisi: dibiarkan, pemeriksaan biasa yang menahannya.
    assert.deepEqual(normalisasiJaringan([{ position: 4, percent: 2.25 }], [], "K1"), { discounts: [{ position: 4, percent: 2.25 }] });
    // Nominal rupiah (MSG) dan baris bonus tidak disentuh.
    const rp = [{ position: 1, percent: 4 }, { position: 5, percent: 0.5, amount: 1000 }];
    assert.deepEqual(normalisasiJaringan(rp, [alfa()], "K1").discounts, rp);
});

test("jaringan dicocokkan pada NAMA master: Indomaret, Alfamart, Indogrosir, Alfamidi saja", () => {
    for (const nama of ["ALFAMART {C-AL0063}", "ALFAMART PALOPO {C-ALF052}", "ALFAMIDI {C-AL0064}",
        "INDOMARET {C-IN0050}", "INDOGROSIR - GORONTALO"]) assert.ok(JARINGAN_POSISI_BEBAS.test(nama), nama);
    for (const nama of ["PT. SUPRA BOGA LESTARI {C-PT0029}", "LOTTE MART", "HERO SUPERMARKET", "TK. SUBHAN {C-SU0275}", "ALFAMARTINI"]) {
        assert.equal(JARINGAN_POSISI_BEBAS.test(nama), false, nama);
    }
});

test("tarif PRINCIPAL di posisi 4 menjelaskan klaimnya (PT SUPRA BOGA 0,5%)", () => {
    // Sampai 2026-09-24 hanya tarif distributor yang dicocokkan; tarif principal yang dimuat
    // pengguna ditolak dengan pesan "0,5% tidak sama dengan ... posisi 4 0,5%".
    const supra = [tarif({ customerCode: "C-PT0029", benefitValue: "3" }),
        tarif({ customerCode: "C-PT0029", tierNo: 4, benefitValue: "0.5", benefitBeban: "PRINCIPAL" })];
    const hasil = checkLine(line({ discounts: [{ position: 1, percent: 3 }, { position: 4, percent: 0.5 }],
        reportDiscount: 11302.7, rules: supra }));
    assert.equal(hasil.status, "ok", hasil.findings.join(" | "));
    assert.equal(hasil.split.principal, 1572.97);

    // Beban tetap dicocokkan: tarif principal tidak membenarkan potongan di posisi distributor.
    const salah = checkLine(line({ discounts: [{ position: 2, percent: 0.5 }], reportDiscount: 1621.62, rules: supra }));
    assert.equal(salah.status, "review");
});

test("NKA tergolong Modern Trade saat dibandingkan dengan channel laporan principal", () => {
    // ALFAMART disebut "Modern Trade" oleh Kino dan NKA oleh master — bukan dua jawaban yang
    // berbeda. Sebelumnya gerbang menyuruh orang mengganti kategori Accurate-nya.
    const alfamart = checkLine(line({ discounts: [{ position: 1, percent: 2 }], reportDiscount: 6486.49,
        rules: [tarif()], outletChannel: channelOutlet("NKA"), reportChannel: "Modern Trade" }));
    assert.equal(alfamart.status, "ok", alfamart.findings.join(" | "));

    // Selisih yang sungguhan tetap terlihat.
    const beda = checkLine(line({ discounts: [{ position: 1, percent: 2 }], reportDiscount: 6486.49,
        rules: [tarif()], outletChannel: channelOutlet("NKA"), reportChannel: "General Trade" }));
    assert.match(beda.findings.join(" "), /master Accurate menyimpannya NKA/);

    // Kelayakan promo ber-channel TIDAK ikut dilebarkan: surat MT tetap hanya untuk kategori MT.
    assert.equal(channelAllowed({ channel: "MT" }, channelOutlet("NKA")), false);
});
