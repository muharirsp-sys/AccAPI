/* SIMULASI RANTAI PENUH untuk surat berperiode OKTOBER, dari publikasi Summary sampai gerbang
   yang menahan faktur. Berkas ini menjawab satu pertanyaan yang tidak bisa dijawab dengan
   membaca kode: "kalau bulan depan saya unggah surat Oktober, apakah ia benar-benar menahan?"

   Kenapa perlu uji tersendiri, padahal kedua sisinya sudah punya ujinya masing-masing:
   `summary-bridge.test.ts` membuktikan jembatannya menghasilkan baris yang benar, dan
   `principal-validation.test.ts` membuktikan gerbangnya menilai baris dengan benar. Tidak satu
   pun dari keduanya membuktikan bahwa baris yang KELUAR dari jembatan adalah baris yang bisa
   DIBACA gerbang. Sambungan itulah yang paling mudah patah tanpa ada yang tahu, karena kalau
   ia patah gerbangnya tidak menjerit — ia cuma berhenti menahan.

   Yang paling penting di sini adalah PERIODE. Aturan Oktober yang periodenya tidak ikut
   terbawa akan berlaku selamanya (menerima potongan September yang sudah kedaluwarsa), dan
   aturan yang periodenya terbawa salah tidak akan berlaku sama sekali (menahan seluruh faktur
   Oktober). Keduanya senyap. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridgeRows, type BridgeRow, type PublishedLetter, type SummaryProgram } from "./summary-bridge.ts";
import {
    berlakuPada, channelAllowed, channelOutlet, checkSoPromo, matchItemRule, outletAllowed,
    outletListsOn, splitDiscounts,
    type DiscountAt, type PublishedRule,
} from "./principal-validation.ts";

/* ------------------------------------------------------------------ surat Oktober

   Bentuknya sengaja meniru ketiga bentuk yang benar-benar ada pada surat September produksi,
   hanya periodenya yang digeser ke Oktober:
     A. diskon persen per barang, semua outlet          (seperti BP2609007909, 3% B&B)
     B. potongan rupiah setingkat nota, EXCLUDE LOYALTY (seperti BP2609006016, MSG)
     C. bonus barang, INCLUDE LOYALTY                   (seperti BP2609007713, Resik V) */

const OKT_AWAL = "2026-10-01";
const OKT_AKHIR = "2026-10-31";

const programA = (): SummaryProgram => ({
    id: "row-1-1", name: "DISKON B&B OKTOBER", start: OKT_AWAL, end: OKT_AKHIR,
    codes: ["K1041101030010", "K1090003005010"], channel: "ALL",
    outlet_mode: "all", outlet_classes: [], unit: "PCS", mix: false,
    threshold: "quantity", value_scope: "eligible", basis: "gross", stacking: false, priority: 1,
    // minimum "0" diterima jembatan, TETAPI sisi Python menolaknya: `Tier` pada
    // `summary_rules.py` menuntut minimum > 0 ("Minimum tier harus lebih dari nol"). Jadi
    // diskon datar tanpa syarat beli — bentuk BP2609007909 — harus diketik sebagai "Beli 1"
    // saat diterbitkan dari Summary. Diuji atas Python sungguhan, 15 Sep 2026.
    tiers: [{ minimum: "0", percentages: ["3"] }],
    source_page: 1, source_quote: "DISKON 3% ON FAKTUR",
});

const programB = (): SummaryProgram => ({
    id: "row-2-1", name: "MSG ALL BRAND HPC OKTOBER", start: OKT_AWAL, end: OKT_AKHIR,
    codes: ["K1041101030010"], channel: "GT",
    outlet_mode: "except", outlet_classes: ["LOYALTY"], unit: "PCS", mix: false,
    threshold: "value", value_scope: "eligible", basis: "gross", stacking: false, priority: 2,
    tiers: [
        { minimum: "1000000", rupiah: "20000", rupiah_mode: "once" },
        { minimum: "2000000", rupiah: "40000", rupiah_mode: "once" },
    ],
    source_page: 2, source_quote: "MINIMAL TRANSAKSI 1JT POTONGAN ON FAKTUR 20.000",
});

const programC = (): SummaryProgram => ({
    id: "row-3-1", name: "BONUS RESIK V OKTOBER", start: OKT_AWAL, end: OKT_AKHIR,
    codes: ["K1370000005010"], channel: "GT",
    outlet_mode: "only", outlet_classes: ["LOYALTY"], unit: "PCS", mix: true,
    threshold: "quantity", value_scope: "eligible", basis: "gross", stacking: false, priority: 3,
    tiers: [{ minimum: "30", bonus_quantity: "1", bonus_unit: "PCS", repeat: true }],
    source_page: 3, source_quote: "SETIAP PEMBELIAN 30 PCS MIX VARIANT",
});

const suratOktober = (over: Partial<PublishedLetter> = {}): PublishedLetter => ({
    draftId: "0c70be12-0000-0000-0000-00000000000a", principal: "KINO NON FOOD",
    suratProgram: "BP2610001234", promoLabel: "PROMO OKTOBER HPC", promoGroup: "ALL BRAND HPC",
    programs: [programA(), programB(), programC()],
    itemNames: {
        K1041101030010: "KNF B&B KIDS SHAMPOO 200ML",
        K1090003005010: "KNF B&B KIDS TOOTHPASTE 50G",
        K1370000005010: "KNF RESIK V MANJAKANI 50ML",
    },
    settlement: "on_invoice", beban: "PRINCIPAL", outletCodes: [], ...over,
});

/** Baris jembatan -> bentuk yang DIBACA gerbang. Persis yang dilakukan route from-summary
 *  saat menulis ke `promo_rule`, lalu route validate saat membacanya kembali. */
const keAturanGerbang = (row: BridgeRow): PublishedRule => ({
    suratProgram: row.suratProgram, promoGroup: row.promoGroup, itemCode: row.itemCode,
    customerCode: row.customerCode, tierNo: row.tierNo,
    periodStart: row.periodStart, periodEnd: row.periodEnd,
    triggerQty: Number(row.triggerQty), triggerUnit: row.triggerUnit,
    benefitType: row.benefitType, benefitValue: row.benefitValue, benefitBeban: row.benefitBeban,
    channel: row.channel, outletList: row.outletList, outletListMode: row.outletListMode,
});

/** Saringan yang dipakai route validate untuk tiap baris: periode, daftar peserta, DAN channel. */
const berlakuUntuk = (rules: PublishedRule[], tanggal: string, customerNo: string | null,
    anggota: Parameters<typeof outletListsOn>[0], kategoriAccurate = "TT") =>
    rules.filter((rule) => berlakuPada(rule, tanggal)
        && outletAllowed(rule, customerNo, outletListsOn(anggota, tanggal))
        && channelAllowed(rule, channelOutlet(kategoriAccurate)));

/* ------------------------------------------------------------------ 1. jembatan */

test("surat Oktober: periodenya ikut ke SETIAP baris, tidak ada satu pun yang lolos tanpa periode", () => {
    const hasil = bridgeRows(suratOktober());
    assert.deepEqual(hasil.refused, []);
    // A: 2 barang x 1 strata = 2 | B: 2 strata tingkat faktur = 2 | C: 1 barang x 1 strata = 1
    assert.equal(hasil.rows.length, 5);
    for (const row of hasil.rows) {
        assert.equal(row.periodStart, OKT_AWAL, `periode mulai hilang pada ${row.promoGroupId}`);
        assert.equal(row.periodEnd, OKT_AKHIR, `periode akhir hilang pada ${row.promoGroupId}`);
        assert.equal(row.active, true);
        assert.equal(row.suratProgram, "BP2610001234");
    }
});

test("ketiga bentuk surat terbawa utuh, termasuk arah daftar pesertanya", () => {
    const rows = bridgeRows(suratOktober()).rows;

    const persen = rows.filter((row) => row.benefitType === "DISC_PCT");
    assert.equal(persen.length, 2);
    assert.equal(persen[0].benefitValue, "3");
    assert.equal(persen[0].outletList, "", "program semua outlet tidak boleh dapat daftar peserta");

    const nota = rows.filter((row) => row.benefitType === "DISC_RP");
    assert.equal(nota.length, 2);
    assert.equal(nota[0].itemCode, "", "potongan seluruh nota harus tanpa kode barang");
    assert.equal(nota[0].triggerUnit, "RP");
    assert.equal(nota[0].outletList, "LOYALTY");
    assert.equal(nota[0].outletListMode, "EXCLUDE");

    const bonus = rows.filter((row) => row.benefitType === "BONUS_QTY");
    assert.equal(bonus.length, 1);
    assert.equal(bonus[0].triggerQty, "30");
    assert.equal(bonus[0].outletListMode, "INCLUDE");
});

/* ------------------------------------------------------------------ 2. gerbang */

test("potongan 3% pada faktur OKTOBER dijelaskan aturan dari surat Oktober", () => {
    const aturan = bridgeRows(suratOktober()).rows.map(keAturanGerbang);
    const diskon: DiscountAt[] = [{ position: 4, percent: 3 }];

    const berlaku = berlakuUntuk(aturan, "2026-10-15", "C-BA0003-KN", []);
    const cocok = matchItemRule(diskon, berlaku, "K1041101030010");
    assert.ok(cocok, "3% di posisi 4 seharusnya cocok dengan aturan Oktober");
    assert.equal(cocok.suratProgram, "BP2610001234");
});

test("potongan 3% yang SAMA pada faktur September TIDAK dijelaskan surat Oktober", () => {
    // Inilah bahaya yang sebenarnya. Kalau periodenya tidak terbawa, aturan Oktober akan
    // membenarkan potongan bulan mana pun — dan gerbang berhenti menjadi gerbang.
    const aturan = bridgeRows(suratOktober()).rows.map(keAturanGerbang);
    const diskon: DiscountAt[] = [{ position: 4, percent: 3 }];

    for (const tanggal of ["2026-09-30", "2026-11-01"]) {
        const berlaku = berlakuUntuk(aturan, tanggal, "C-BA0003-KN", []);
        assert.equal(matchItemRule(diskon, berlaku, "K1041101030010"), null,
            `aturan Oktober tidak boleh berlaku pada ${tanggal}`);
    }
});

test("potongan seluruh nota Oktober dinilai dengan ambang TERMASUK PPN, dan hanya untuk non-peserta", () => {
    const aturan = bridgeRows(suratOktober()).rows.map(keAturanGerbang);
    const anggota = [{ listName: "LOYALTY", customerCode: "C-AD0021", periodStart: "2026-10-01", periodEnd: "2026-12-31" }];

    // Bruto DPP 1.000.000 -> dengan PPN 1.110.000, melewati ambang tier 1 (Rp 1 juta).
    // Klaim principal DPP 18.018,02 -> dengan PPN 20.000, tepat manfaat tier 1.
    const bukanPeserta = berlakuUntuk(aturan, "2026-10-15", "C-BA0003-KN", anggota);
    const hasil = checkSoPromo({ gross: 1_000_000, principalClaim: 18_018.02, lineCount: 5 }, bukanPeserta);
    assert.deepEqual(hasil.findings, []);
    assert.match(hasil.explained, /BP2610001234 tier 1/);

    // Outlet yang JUSTRU peserta LOYALTY dikecualikan suratnya, jadi klaim yang sama tidak
    // punya dasar dan tidak boleh dijelaskan.
    const peserta = berlakuUntuk(aturan, "2026-10-15", "C-AD0021-KN", anggota);
    assert.equal(peserta.some((rule) => rule.benefitType === "DISC_RP"), false,
        "tier MSG tidak boleh berlaku untuk peserta LOYALTY");
});

test("bonus Oktober hanya untuk peserta LOYALTY, dan keanggotaan dibaca per TANGGAL SO", () => {
    const aturan = bridgeRows(suratOktober()).rows.map(keAturanGerbang);
    // Keanggotaan kuartal 4; pada 30 September toko ini BELUM peserta.
    const anggota = [{ listName: "LOYALTY", customerCode: "C-AD0021", periodStart: "2026-10-01", periodEnd: "2026-12-31" }];
    const bonusOn = (tanggal: string, customerNo: string) =>
        berlakuUntuk(aturan, tanggal, customerNo, anggota).some((rule) => rule.benefitType === "BONUS_QTY");

    assert.equal(bonusOn("2026-10-15", "C-AD0021-KN"), true, "peserta pada Oktober berhak bonus");
    assert.equal(bonusOn("2026-10-15", "C-BA0003-KN"), false, "bukan peserta tidak berhak bonus");
    assert.equal(bonusOn("2026-09-30", "C-AD0021-KN"), false, "belum peserta pada 30 September");
});

test("aturan September dan Oktober boleh hidup berdampingan; tanggal SO yang memisahkannya", () => {
    // Keadaan nyata bulan depan: aturan September masih tersimpan (tidak dihapus), aturan
    // Oktober baru masuk. Satu berkas batch bahkan bisa memuat kedua tanggal sekaligus.
    const oktober = bridgeRows(suratOktober()).rows.map(keAturanGerbang);
    const september = bridgeRows(suratOktober({
        draftId: "0c70be12-0000-0000-0000-00000000000b", suratProgram: "BP2609007909",
        programs: [{ ...programA(), start: "2026-09-01", end: "2026-09-30" }],
    })).rows.map(keAturanGerbang);
    const semua = [...september, ...oktober];
    const diskon: DiscountAt[] = [{ position: 4, percent: 3 }];

    const pada = (tanggal: string) =>
        matchItemRule(diskon, berlakuUntuk(semua, tanggal, "C-BA0003-KN", []), "K1041101030010");

    assert.equal(pada("2026-09-15")?.suratProgram, "BP2609007909");
    assert.equal(pada("2026-10-15")?.suratProgram, "BP2610001234");
    // Dua aturan yang sama-sama berlaku pada satu hari tidak pernah terjadi di sini karena
    // periodenya bersambung, bukan bertindih. Kalau suatu saat bertindih, `matchItemRule`
    // mengambil yang pertama cocok — dan itu yang harus diketahui, bukan ditebak.
    assert.equal(berlakuUntuk(semua, "2026-09-30", "C-BA0003-KN", []).filter((r) => r.itemCode === "K1041101030010" && r.benefitType === "DISC_PCT").length, 1);
});

test("potongan Oktober tanpa aturan sama sekali tetap tertahan sebagai tak bertuan", () => {
    // Pembuktian arah sebaliknya: rantai ini tidak boleh membuat gerbang jadi longgar.
    const aturan = bridgeRows(suratOktober()).rows.map(keAturanGerbang);
    const diskon: DiscountAt[] = [{ position: 4, percent: 7.5 }];
    const berlaku = berlakuUntuk(aturan, "2026-10-15", "C-BA0003-KN", []);
    assert.equal(matchItemRule(diskon, berlaku, "K1041101030010"), null);

    // Dan posisi 6+ tetap tak bertuan, apa pun aturannya.
    const split = splitDiscounts(1_000_000, [{ position: 6, percent: 2 }]);
    assert.ok(split.unowned > 0);
});

/* ------------------------------------------------------------------ 3. sambungan Python <-> TS

   Bentuk keluaran `readiness()` diadu apa adanya, bukan diringkas. Satu detail yang menyebut
   DUA kode barang menghasilkan DUA program (`row-1-1`, `row-1-2`) — satu per barang — meski
   potongannya setingkat NOTA dan hanya boleh ada satu. Dijalankan atas Python sungguhan
   (`summary_review_publish.readiness`) pada 15 Sep 2026, dan keluarannya disalin ke sini. */

test("potongan nota dari detail berbarang banyak tetap jadi SATU aturan per tingkat", () => {
    const msgProgram = (id: string, code: string): SummaryProgram => ({
        id, name: "MSG OKTOBER", start: OKT_AWAL, end: OKT_AKHIR, codes: [code], channel: "GT",
        outlet_mode: "all", outlet_classes: [], unit: "PCS", mix: false,
        threshold: "value", value_scope: "eligible", basis: "gross", stacking: false, priority: 1,
        tiers: [
            { minimum: "1000000", rupiah: "20000", rupiah_mode: "once", repeat: false },
            { minimum: "2000000", rupiah: "40000", rupiah_mode: "once", repeat: false },
        ],
        source_page: 1, source_quote: "MINIMAL TRANSAKSI 1JT",
    });
    const hasil = bridgeRows(suratOktober({
        programs: [msgProgram("row-1-1", "K1041101030010"), msgProgram("row-1-2", "K1090003005010")],
    }));

    // DUA baris, bukan empat: satu potongan nota per tingkat. Kalau keempatnya dimuat, satu
    // potongan Rp 20.000 akan punya dua aturan yang sama-sama membenarkannya.
    assert.equal(hasil.rows.length, 2);
    assert.deepEqual(hasil.rows.map((row) => row.itemCode), ["", ""]);
    assert.deepEqual(hasil.rows.map((row) => row.benefitValue), ["20000", "40000"]);

    // Kembarannya dilaporkan sebagai CATATAN, bukan penolakan. Kembar ini tidak bisa dihindari
    // pada potongan setingkat nota — satu detail berbarang banyak memang menghasilkan satu
    // program per barang — jadi menyebutnya "ditolak" akan membuat tiap muat surat MSG
    // terlihat gagal separuh. Penolakan yang selalu muncul akan berhenti dibaca, termasuk
    // yang sungguhan.
    assert.deepEqual(hasil.refused, []);
    assert.equal(hasil.notes.length, 2);
    assert.match(hasil.notes[0], /row-1-2.*tingkat faktur.*isi yang SAMA; dimuat sekali saja/);
});

test("periode Oktober dari sisi Python sampai ke gerbang tanpa disentuh siapa pun", () => {
    // Keluaran readiness() yang sebenarnya untuk detail Oktober (dijalankan 15 Sep 2026):
    // start/end disalin apa adanya dari baris detail yang diisi peninjau.
    const dariPython: SummaryProgram = {
        id: "row-1-1", name: "DISKON", start: "2026-10-01", end: "2026-10-31",
        codes: ["K1041101030010"], channel: "GT", unit: "PCS", mix: false,
        threshold: "quantity", value_scope: "eligible", basis: "gross", stacking: false, priority: 1,
        outlet_mode: "all", outlet_classes: [],
        tiers: [{
            minimum: "1", percentages: ["3"], rupiah: "0", rupiah_mode: "once",
            bonus_code: "", bonus_quantity: "0", bonus_unit: "PCS", bonus_scope: "code", repeat: false,
        }],
        source_page: 1, source_quote: "DISKON 3%",
    };
    const row = bridgeRows(suratOktober({ programs: [dariPython] })).rows[0];
    assert.equal(row.periodStart, "2026-10-01");
    assert.equal(row.periodEnd, "2026-10-31");
    assert.equal(berlakuPada(keAturanGerbang(row), "2026-10-31"), true, "hari terakhir Oktober masih berlaku");
    assert.equal(berlakuPada(keAturanGerbang(row), "2026-11-01"), false, "1 November sudah tidak");
});

/* ------------------------------------------------------------------ 4. channel

   Surat menyebut channelnya ("Type Of Promo"), dan sampai 15 Sep 2026 jembatan MEMBUANGNYA.
   Akibatnya surat "KHUSUS CHANNEL GT" berlaku juga untuk outlet MT. Sudah ada contohnya di
   produksi: HINDA MART (C-HIL009) disebut General Trade oleh Kino, master kita menyimpannya MT. */

test("channel surat ikut ke aturan, dan GT hanya berlaku untuk outlet berkategori TT", () => {
    const suratGT = suratOktober({
        programs: [{ ...programA(), channel: "GT" }],
    });
    const aturan = bridgeRows(suratGT).rows.map(keAturanGerbang);
    assert.equal(aturan[0].channel, "GT", "channel surat wajib terbawa, bukan dibuang");

    const diskon: DiscountAt[] = [{ position: 4, percent: 3 }];
    const pada = (kategori: string) =>
        matchItemRule(diskon, berlakuUntuk(aturan, "2026-10-15", "C-BA0003-KN", [], kategori), "K1041101030010");

    assert.ok(pada("TT"), "outlet TT berhak promo GT");
    assert.equal(pada("MT"), null, "outlet MT TIDAK berhak promo GT");
    assert.equal(pada("Umum"), null, "kategori yang belum dirapikan juga tidak");
    assert.equal(pada(""), null, "outlet tanpa kategori di master ditahan, bukan diloloskan");
});

test("surat tanpa channel (ALL) tetap berlaku di mana saja — bentuk sebagian besar aturan termuat", () => {
    const aturan = bridgeRows(suratOktober({ programs: [{ ...programA(), channel: "ALL" }] })).rows.map(keAturanGerbang);
    assert.equal(aturan[0].channel, "", "\"ALL\" disimpan kosong supaya satu arti punya satu bentuk");
    const diskon: DiscountAt[] = [{ position: 4, percent: 3 }];
    for (const kategori of ["TT", "MT", "NKA", ""]) {
        assert.ok(matchItemRule(diskon, berlakuUntuk(aturan, "2026-10-15", "C-BA0003-KN", [], kategori), "K1041101030010"),
            `aturan tanpa channel harus berlaku untuk kategori ${kategori || "(kosong)"}`);
    }
});
