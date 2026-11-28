/* Mengunci cek "sudah diinput di Accurate" (25 Nov 2026): pelunasan ada yang diinput sales, ada yang admin. Dengan kolom Saldo (Form Kerja
 * Inc "6_Saldo" = sisa piutang sebelum baris), sisa Accurate ≈ Saldo → dikirim; ≈ Saldo − bayar → dilewati; lainnya → PERLU_CEK.
 * Angka baris D & E dari berkas nyata 24 Nov 2026 (INV/2607/HZ01281, INV/2604/GD00274). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { alokasikan } from "./alokasi.ts";

const PETA = { mapTunaiAutoNum: "", mapTunaiBank: "", mapTrfAutoNum: "", mapTrfBank: "", mapBgAutoNum: "", mapBgBank: "", mapPot1Account: "", mapPot2Account: "", mapPot3Account: "" };
const faktur = (no: string, sisa: number) => [no, { invoiceNo: no, customerNo: "C-X0001-SZ", branchId: 1, branchName: "B", outstanding: sisa }] as const;

test("sudah di Accurate: hanya baris yang belum diinput yang dikirim; sisanya dilewati atau ditahan dengan angka", () => {
    const rows = [
        { "Code Outlet": "C-X0001", "No. Nota": "INV/A", "Saldo": 1000000, "Tunai": 400000 },          // A belum (sisa = saldo)
        { "Code Outlet": "C-X0001", "No. Nota": "INV/B", "Saldo": 500000, "Tunai": 500000 },           // B sudah lunas
        { "Code Outlet": "C-X0001", "No. Nota": "INV/C", "Saldo": 300000, "Tunai": 100000 },           // C sudah (cicil oleh sales)
        { "Code Outlet": "C-X0001", "No. Nota": "INV/D", "Saldo": 1362317.31, "Tunai": 300000 },       // D lunas penuh di Accurate → cek
        { "Code Outlet": "C-X0001", "No. Nota": "INV/E", "Saldo": 16062.4, "Tunai": 16062.4 },         // E belum, beda Rp1,33 = selisih
        { "Code Outlet": "C-X0001", "No. Nota": "INV/F", "Tunai": 50000 },                             // F tanpa Saldo → seperti dulu
    ];
    const invoiceBranchMap = new Map<string, Record<string, unknown>>([
        faktur("INV/A", 1000000), faktur("INV/B", 0), faktur("INV/C", 200000), faktur("INV/D", 0), faktur("INV/E", 16061.07), faktur("INV/F", 80000),
    ]);
    const { groupedMap, dilewati } = alokasikan(rows, { trxDate: "2026-11-24", peta: PETA, returMap: new Map(), invoiceBranchMap, invoiceLookupDebugMap: new Map() });

    assert.deepEqual(dilewati.map((d) => [d.invoiceNo, d.reason]), [["INV/B", "SUDAH_DI_ACCURATE"], ["INV/C", "SUDAH_DI_ACCURATE"], ["INV/D", "PERLU_CEK"]]);
    assert.match(dilewati[2].detail ?? "", /Sisa piutang Accurate Rp 0; berkas: saldo Rp 1\.362\.317,31, bayar Rp 300\.000/);
    const sr = [...groupedMap.values()][0];
    assert.equal(sr.customerNo, "C-X0001-SZ", "pelanggan dari faktur Accurate (bersufiks divisi)");
    assert.deepEqual(sr.detailInvoice.map((d: { invoiceNo: string }) => d.invoiceNo), ["INV/A", "INV/E", "INV/F"]);
    const e = sr.detailInvoice[1];
    assert.equal(e.paymentAmount, 16061.07, "uang tetap 16.062,4; selisih -1,33 ke akun selisih");
    assert.deepEqual(e.detailDiscount, [{ amount: 16061.07 - 16062.4, accountNo: "600136" }]);
});

test("NKA: sisa RJN di Accurate lebih kecil dari retur di berkas → dilunasi sesuai Accurate, kekurangan dicatat (aturan pemilik 28 Nov), bukan retur manual", () => {
    // Faktur Rp33.982.123 = TF Rp8.356.714 + retur Rp25.625.409, tetapi RJN di daftar berkas hanya bersisa Rp57.043 (pelanggan/divisi lain).
    const rows = [{ "Code Outlet": "C-AL0063", "No. Nota": "INV/2608/M101032", "Trf": 8356714, "Ket. Trf": "TF MAYBANK (1) 23/10", "Pot. RT Gt": 25625409, "No.RJS RT Gt": "RJN/2609/M100201,M200073" }];
    const returMap = new Map<string, Record<string, unknown>>([["DOC|RJN/2609/M100201,M200073", {
        isArray: true, number: "RJN/2609/M100201", outstanding: 57043, customerNo: "C-AL0063-M2",
        returns: [{ number: "RJN/2609/M200073", primeOwing: 57043, customer: { customerNo: "C-AL0063-M2" }, branch: { id: 2, name: "MIX FOOD 2" } }],
    }]]);
    const invoiceBranchMap = new Map<string, Record<string, unknown>>([["INV/2608/M101032", { customerNo: "C-AL0063-M1", branchId: 1, outstanding: 33982123 }]]);
    const out = alokasikan(rows, { trxDate: "2026-10-23", peta: PETA, returMap, invoiceBranchMap, invoiceLookupDebugMap: new Map() });
    assert.deepEqual(out.unresolvedReturWarnings, [], "dokumen ADA di Accurate: bukan retur manual");
    assert.deepEqual(out.returIkutAccurate.map((r) => [r.invoiceNo, r.kurang, r.refs]), [["INV/2608/M101032", 25625409 - 57043, ["RJN/2609/M100201,M200073"]]],
        "kekurangan tetap tercatat (tidak hilang diam-diam)");
    const docs = [...out.groupedMap.values(), ...out.ayatSilangDocs];
    assert.equal(docs.find((d) => d.bankNo === "110105")?.chequeAmount, 8356714, "transfer tetap utuh");
    assert.deepEqual(out.ayatSilangDocs.map((d) => d.chequeAmount), [57043, -57043], "retur yang ada tetap dipakai lewat ayat silang");
});

test("retur ketemu tetapi sudah habis terpakai: tidak ada pelunasan sampah berisi selisih saja; dicatat sesuai Accurate (uji kering 24 Nov)", () => {
    // INV/2611/KN00063: Pot. Lain RJN/2611/KN00158 Rp364.600,47, sisa faktur Rp364.600, retur di Accurate sudah terpakai (sisa 0).
    const rows = [{ "Code Outlet": "C-RAN772", "No. Nota": "INV/2611/KN00063", "Pot. Lain": 364600.4687, "Ket. Pot": "RJN/2611/KN00158" }];
    const returMap = new Map<string, Record<string, unknown>>([["DOC|RJN/2611/KN00158", {
        isArray: true, number: "RJN/2611/KN00158", outstanding: 0, customerNo: "C-RAN772-KN",
        returns: [{ number: "RJN/2611/KN00158", primeOwing: 0, customer: { customerNo: "C-RAN772-KN" } }],
    }]]);
    const invoiceBranchMap = new Map<string, Record<string, unknown>>([["INV/2611/KN00063", { customerNo: "C-RAN772-KN", branchId: 1, outstanding: 364600 }]]);
    const out = alokasikan(rows, { trxDate: "2026-11-24", peta: PETA, returMap, invoiceBranchMap, invoiceLookupDebugMap: new Map() });
    assert.deepEqual([...out.groupedMap.values()].flatMap((s) => s.detailInvoice), [], "dulu: INV -0,47 dengan 600136 -0,47");
    assert.deepEqual(out.unresolvedReturWarnings, []);
    assert.equal(out.returIkutAccurate[0]?.kurang, 364600.4687);
});

/* 27 Nov 2026: bentuk NYATA Accurate — RJN Belum Lunas primeOwing NEGATIF (RJN/2610/CS00140 −118.300). Dulu dibaca "sudah terpakai",
 * jadi semua retur RJN berkas 26/11 jatuh ke retur manual dan 2 faktur NKA 25/11 (TF sudah, retur belum) tertahan PERLU_CEK. */
const rjn = (number: string, primeOwing: number, customerNo: string) => ({ number, primeOwing, customer: { customerNo }, branch: { id: 9, name: "DIV" } });
const peta = (key: string, returns: ReturnType<typeof rjn>[]) => new Map<string, Record<string, unknown>>([[key, {
    isArray: true, number: returns[0].number, outstanding: returns.reduce((s, r) => s + Math.abs(r.primeOwing), 0), customerNo: returns[0].customer.customerNo, returns,
}]]);
const semua = (out: ReturnType<typeof alokasikan>) => [...out.groupedMap.values(), ...out.ayatSilangDocs];

test("RJN primeOwing negatif dipakai: divisi sama = baris negatif di pelunasan Kas, divisi lain = ayat silang 110120 (26/11 C-CIT036 & C-BA0003)", () => {
    const rows = [{ "Code Outlet": "C-CIT036", "No. Nota": "INV/2611/CS00066", "Saldo": 1640824.2, "Trf": 1509511.2, "Ket. Trf": "TF MAYBANK 26/11",
        "Pot. RT Gt": 118300, "No.RJS RT Gt": "RJN/2610/CS00140, RJN/2610/M100686" }];
    const returMap = peta("DOC|RJN/2610/CS00140, RJN/2610/M100686", [rjn("RJN/2610/CS00140", -100000, "C-CIT036-CS"), rjn("RJN/2610/M100686", -278228, "C-CIT036-M1")]);
    const invoiceBranchMap = new Map<string, Record<string, unknown>>([["INV/2611/CS00066", { customerNo: "C-CIT036-CS", branchId: 1, outstanding: 1640824.2 }]]);
    const out = alokasikan(rows, { trxDate: "2026-11-26", peta: PETA, returMap, invoiceBranchMap, invoiceLookupDebugMap: new Map() });
    assert.deepEqual(out.unresolvedReturWarnings, [], "dulu: seluruh 118.300 masuk retur manual");
    const kas = semua(out).find((d) => d.bankNo === "110102");
    assert.deepEqual(kas?.detailInvoice, [{ invoiceNo: "INV/2611/CS00066", paymentAmount: 100000 }, { invoiceNo: "RJN/2610/CS00140", paymentAmount: -100000 }]);
    assert.equal(kas?.chequeAmount, 0);
    assert.deepEqual(out.ayatSilangDocs.map((d) => [d.customerNo, d.chequeAmount, d.detailInvoice]), [
        ["C-CIT036-CS", 18300, [{ invoiceNo: "INV/2611/CS00066", paymentAmount: 18300 }]],
        ["C-CIT036-M1", -18300, [{ invoiceNo: "RJN/2610/M100686", paymentAmount: -18300 }]],
    ]);
    assert.equal(semua(out).find((d) => d.bankNo === "110105")?.chequeAmount, 1509511.2, "transfer utuh");
    assert.equal(returMap.get("DOC|RJN/2610/CS00140, RJN/2610/M100686")!.returns[1].primeOwing, -(278228 - 18300), "sisa tetap negatif untuk baris berikutnya");
});

test("uang sudah diinput admin, retur belum: hanya bagian retur yang dikirim (25NKA INV/2609/UN00142); sebagian RJN terpakai: hanya yang tersisa", () => {
    const rows = [
        // UN00142: TF 11.145.130,95 sudah di Accurate, sisa 3.456.085 = seluruh RT Gt.
        { "Code Outlet": "C-ALF052", "No. Nota": "INV/2609/UN00142", "Saldo": 14601215.95, "Trf": 11145130.95, "Ket. Trf": "TF MAYBANK 20/11", "Total.Trx": 14601215.95,
            "Pot. RT Gt": 3456085, "No.RJS RT Gt": "RJN/2611/DL00084,UN00071" },
        // M101092: TF + biaya + sebagian RJN sudah; RJN A terpakai (0), B & C tersisa 700.000 = sisa faktur.
        { "Code Outlet": "C-AL0063", "No. Nota": "INV/2609/M101092", "Saldo": 2010000, "Trf": 1000000, "Ket. Trf": "TF MAYBANK 20/11", "BiayaTrf/BG": 10000,
            "Pot. RT Gt": 1000000, "No.RJS RT Gt": "RJN/2610/M100433,KN00061,AB00266" },
        // Retur tersisa (200.000) lebih besar dari sisa faktur (120.000): ada pembayaran lain yang tak jelas → tetap PERLU_CEK.
        { "Code Outlet": "C-ALF052", "No. Nota": "INV/2609/UN00999", "Saldo": 500000, "Trf": 300000, "Ket. Trf": "TF MAYBANK 20/11",
            "Pot. RT Gt": 200000, "No.RJS RT Gt": "RJN/2611/UN00999" },
    ];
    const returMap = new Map([
        ...peta("DOC|RJN/2611/DL00084,UN00071", [rjn("RJN/2611/DL00084", -1445515, "C-ALF052-DLP"), rjn("RJN/2611/UN00071", -2000000, "C-ALF052-UN")]), // kurang 10.570
        ...peta("DOC|RJN/2610/M100433,KN00061,AB00266", [rjn("RJN/2610/M100433", 0, "C-AL0063-M1"), rjn("RJN/2610/KN00061", -400000, "C-AL0063-KN"), rjn("RJN/2610/AB00266", -300000, "C-AL0063-AB")]),
        ...peta("DOC|RJN/2611/UN00999", [rjn("RJN/2611/UN00999", -200000, "C-ALF052-UN")]),
    ]);
    const invoiceBranchMap = new Map<string, Record<string, unknown>>([
        ["INV/2609/UN00142", { customerNo: "C-ALF052-UN", branchId: 1, outstanding: 3456085 }],
        ["INV/2609/M101092", { customerNo: "C-AL0063-M1", branchId: 1, outstanding: 700000 }],
        ["INV/2609/UN00999", { customerNo: "C-ALF052-UN", branchId: 1, outstanding: 120000 }],
    ]);
    const out = alokasikan(rows, { trxDate: "2026-11-25", peta: PETA, returMap, invoiceBranchMap, invoiceLookupDebugMap: new Map() });
    assert.deepEqual(out.hanyaReturBaris, [1, 2]);
    assert.deepEqual(out.dilewati.map((d) => [d.invoiceNo, d.reason]), [["INV/2609/UN00999", "PERLU_CEK"]]);
    assert.equal(semua(out).some((d) => d.bankNo === "110105"), false, "transfer TIDAK dikirim ulang");
    assert.deepEqual(out.trxTakCocok, [], "Total.Trx tidak berlaku untuk baris hanya-retur");
    assert.deepEqual(out.unresolvedReturWarnings, [], "aturan pemilik 28 Nov: dokumen ada → sesuai Accurate, bukan retur manual");
    assert.deepEqual(out.returIkutAccurate.map((r) => [r.invoiceNo, r.kurang]), [["INV/2609/UN00142", 10570]],
        "kekurangan RJN (nomor salah tulis) tercatat; transfer tidak diproses ulang");
    const kas = semua(out).filter((d) => d.bankNo === "110102" && d.detailInvoice.length > 0); // kelompok kosong dibuang finalisasiPayload
    assert.deepEqual(kas.map((d) => [d.customerNo, d.chequeAmount, d.detailInvoice]), [
        ["C-ALF052-UN", 0, [{ invoiceNo: "INV/2609/UN00142", paymentAmount: 2000000 }, { invoiceNo: "RJN/2611/UN00071", paymentAmount: -2000000 }]],
    ], "divisi sama = baris negatif; potongan biaya TF tidak ikut");
    assert.match(String(kas[0].description), /^Retur RJN\/2611\/DL00084,UN00071/);
    const pasangan = out.ayatSilangDocs.map((d) => [d.customerNo, d.chequeAmount, d.detailInvoice.map((x: { invoiceNo: string; paymentAmount: number }) => `${x.invoiceNo}:${x.paymentAmount}`).join(" ")]);
    assert.deepEqual(pasangan, [
        ["C-ALF052-UN", 1445515, "INV/2609/UN00142:1445515"], ["C-ALF052-DLP", -1445515, "RJN/2611/DL00084:-1445515"],
        ["C-AL0063-M1", 400000, "INV/2609/M101092:400000"], ["C-AL0063-KN", -400000, "RJN/2610/KN00061:-400000"],
        ["C-AL0063-M1", 300000, "INV/2609/M101092:300000"], ["C-AL0063-AB", -300000, "RJN/2610/AB00266:-300000"],
    ], "RJN yang sudah terpakai (M100433, sisa 0) tidak disentuh");
});

test("keterangan ayat silang dengan ratusan RJN dipotong (NKA ±2.600 huruf)", () => {
    const daftar = `RJN/2610/${Array.from({ length: 200 }, (_, i) => `KN${String(i).padStart(5, "0")}`).join(",")}`;
    const rows = [{ "Code Outlet": "C-AL0063", "No. Nota": "INV/X", "Pot. RT Gt": 1000, "No.RJS RT Gt": daftar }];
    const out = alokasikan(rows, { trxDate: "2026-11-25", peta: PETA, returMap: peta(`DOC|${daftar}`, [rjn("RJN/2610/KN00000", -1000, "C-AL0063-KN")]),
        invoiceBranchMap: new Map([["INV/X", { customerNo: "C-AL0063-M1", branchId: 1, outstanding: 1000 }]]), invoiceLookupDebugMap: new Map() });
    assert.equal(out.ayatSilangDocs.length, 2);
    for (const d of out.ayatSilangDocs) assert.ok(String(d.description).length <= 160, String(d.description).length);
});

test("selisih pembulatan tidak tertinggal sendirian di pelunasan Kas saat semua retur pindah ke ayat silang (putar ulang 26/11 CL00085, GD01905)", () => {
    const rows = [
        { "Code Outlet": "C-CIT040", "No. Nota": "INV/2611/CL00085", "Pot. RT Gt": 55150, "No.RJS RT Gt": "RJN/2611/M100187" },   // RJN 55.150,10 > sisa 55.150
        { "Code Outlet": "C-BA0003", "No. Nota": "INV/2607/GD01905", "Pot. RT Gt": 3000, "No.RJS RT Gt": "RJN/2610/CL00034" },    // sisa faktur 3.000,28
    ];
    const returMap = new Map([
        ...peta("DOC|RJN/2611/M100187", [rjn("RJN/2611/M100187", -55150.1, "C-CIT040-M1")]),
        ...peta("DOC|RJN/2610/CL00034", [rjn("RJN/2610/CL00034", -3000, "C-BA0003-CL")]),
    ]);
    const invoiceBranchMap = new Map<string, Record<string, unknown>>([
        ["INV/2611/CL00085", { customerNo: "C-CIT040-CL", branchId: 1, outstanding: 55150 }],
        ["INV/2607/GD01905", { customerNo: "C-BA0003-GD", branchId: 1, outstanding: 3000.28 }],
    ]);
    const out = alokasikan(rows, { trxDate: "2026-11-26", peta: PETA, returMap, invoiceBranchMap, invoiceLookupDebugMap: new Map() });
    assert.deepEqual([...out.groupedMap.values()].flatMap((s) => s.detailInvoice), [], "tidak ada baris faktur Kas berisi selisih saja");
    const faktur = out.ayatSilangDocs.filter((d) => d.chequeAmount > 0).map((d) => [d.chequeAmount, d.detailInvoice[0]]);
    assert.equal(faktur.length, 2);
    assert.equal(faktur[0][0], 55150.1);
    assert.ok(Math.abs(faktur[0][1].paymentAmount - 55150) < 1e-6, "faktur terbayar tepat sisanya");
    assert.ok(Math.abs(faktur[0][1].detailDiscount[0].amount + 0.1) < 1e-6 && faktur[0][1].detailDiscount[0].accountNo === "600136");
    assert.ok(Math.abs(faktur[1][1].paymentAmount - 3000.28) < 1e-6 && Math.abs(faktur[1][1].detailDiscount[0].amount - 0.28) < 1e-6);
    assert.deepEqual(out.ayatSilangDocs.filter((d) => d.chequeAmount < 0).map((d) => d.chequeAmount), [-55150.1, -3000], "RJN habis terpakai");
});

/* Celah 4A (27 Nov 2026): Tinjau 25NKA 15.45 bersamaan penyegaran kasir → pencarian 3 faktur galat (sisa Accurate 0 = sudah diinput admin)
 * → dulu baris jalan terus TANPA cek "sudah di Accurate" dan disiapkan kirim sesuai berkas (atas pelanggan C-ALF052 tanpa sufiks). */
test("4A: berkas ber-Saldo + faktur gagal dibaca → ditahan FAKTUR_TAK_TERBACA, tidak dikirim; tanpa Saldo tetap perilaku lama", async () => {
    const { parsePelunasan } = await import("./parser.ts");
    const { buatEmulator } = await import("./uji/emulator-accurate.ts");
    const { barisUnggah, AKUN_AWAL } = await import("../pelunasan-wizard.ts");
    const fk = (number: string, primeOwing: number) => ({ id: Number(number.slice(-3)), number, primeOwing, branch: { id: 1, name: "B" }, customer: { customerNo: "C-ALF052-M2" } });
    const emu = buatEmulator({
        salesInvoice: [fk("INV/2608/M200309", 0), fk("INV/2608/M200400", 300000), fk("INV/2608/M200305", 80000)],
        salesReturn: [], galat: ["M200309", "M200305"],
    });
    const rows = [
        { "Code Outlet": "C-ALF052", "No. Nota": "INV/2608/M200309", "Saldo": 500000, "Trf": 500000, "Ket. Trf": "TF MAYBANK 25/11" }, // galat, sudah lunas
        { "Code Outlet": "C-ALF052", "No. Nota": "INV/2608/M200400", "Saldo": 300000, "Trf": 300000, "Ket. Trf": "TF MAYBANK 25/11" }, // terbaca, belum
        { "Code Outlet": "C-ALF052", "No. Nota": "INV/2608/M200305", "Trf": 80000, "Ket. Trf": "TF MAYBANK 25/11" },                    // galat, tanpa Saldo
    ];
    const out = await parsePelunasan(rows, { trxDate: "2026-11-25", isKeySaved: true, peta: PETA, accurateFetch: emu.accurateFetch as never });
    assert.deepEqual(out.counts.skipped.map((d) => [d.row, d.reason, d.invoiceNo]), [[1, "FAKTUR_TAK_TERBACA", "INV/2608/M200309"]]);
    assert.match(out.counts.skipped[0].detail ?? "", /tidak terbaca dari Accurate \(galat saat membaca\).*Ulangi pratinjau/);
    const faktur = out.payload.flatMap((s) => s.detailInvoice.map((d: { invoiceNo: string }) => d.invoiceNo));
    assert.deepEqual(faktur.sort(), ["INV/2608/M200305", "INV/2608/M200400"], "dulu: M200309 ikut dikirim Rp500.000 atas C-ALF052");
    // Jejak Hermes: perlu_cek (dinilai Hermes), bukan "dilewati" (diabaikan Hermes).
    assert.deepEqual(barisUnggah(rows, out, AKUN_AWAL).map((b) => b.status), ["perlu_cek", "diproses", "diproses"]);

    // 429 (proxy sudah mengulang 4×): petunjuk "Accurate sibuk" — teks galat mentah TIDAK disalin ke detail (bisa memuat isi jawaban proxy).
    const sibuk = alokasikan([rows[0]], { trxDate: "2026-11-25", peta: PETA, returMap: new Map(), invoiceBranchMap: new Map(),
        invoiceLookupDebugMap: new Map([["INV/2608/M200309", { found: false, lookupSource: "ERROR", error: "HTTP 429 melebihi toleransi 8 request per detik token=rahasia" }]]) });
    assert.match(sibuk.dilewati[0].detail ?? "", /Accurate sibuk/);
    assert.doesNotMatch(sibuk.dilewati[0].detail ?? "", /rahasia/);
    // Faktur terbaca tetapi primeOwing kosong = sama-sama tak terbaca (fail-closed).
    const tanpaSisa = alokasikan([rows[0]], { trxDate: "2026-11-25", peta: PETA, returMap: new Map(), invoiceLookupDebugMap: new Map(),
        invoiceBranchMap: new Map([["INV/2608/M200309", { customerNo: "C-ALF052-M2", branchId: 1, outstanding: null }]]) });
    assert.deepEqual(tanpaSisa.dilewati.map((d) => d.reason), ["FAKTUR_TAK_TERBACA"]);
    assert.equal(tanpaSisa.groupedMap.size, 0);
});

test("4D: akun Accurate tanpa hak Lihat Retur Penjualan → peringatan jelas di Tinjau, bukan sekadar 'retur belum ditemukan'", async () => {
    const { parsePelunasan } = await import("./parser.ts");
    const pesan: string[] = [];
    const fetchTanpaHak = async (path: string) => {
        if (path.includes("sales-return")) throw new Error("Anda tidak memiliki hak Aktif / Buat / Ubah / Hapus / Lihat Retur Penjualan");
        return { s: true, d: [], sp: { pageCount: 1 } };
    };
    const rows = [{ "Code Outlet": "C-X0001", "No. Nota": "INV/2611/CS00001", "Tunai": 90000, "No.SRB Rt Ktr": "SRB 2676.01", "Pot.RT Ktr": 10000 }];
    await parsePelunasan(rows, { trxDate: "2026-11-26", isKeySaved: true, peta: PETA, accurateFetch: fetchTanpaHak as never,
        lapor: (jenis, p) => { if (jenis === "warning") pesan.push(p); } });
    assert.ok(pesan.some((p) => /1 referensi retur tidak bisa dicari: akun Accurate di sesi ini tidak punya hak Lihat Retur Penjualan/.test(p)), pesan.join(" | "));
    // Galat lain (mis. jaringan) tidak memicu kalimat hak akses.
    const lain: string[] = [];
    await parsePelunasan(rows, { trxDate: "2026-11-26", isKeySaved: true, peta: PETA, accurateFetch: (async () => { throw new Error("HTTP 502"); }) as never,
        lapor: (jenis, p) => { if (jenis === "warning") lain.push(p); } });
    assert.ok(!lain.some((p) => /hak Lihat Retur/.test(p)));
});

test("PERLU_CEK: keterangan memuat pelunasan Accurate faktur itu + tanda dugaan input dobel (P.27-11-2026 INV/2610/HZ02233)", async () => {
    const { parsePelunasan } = await import("./parser.ts");
    const struk: Record<number, { number: string; transDate: string; detailInvoice: unknown[] }> = {
        1: { number: "110102.2026.11.16019", transDate: "28/11/2026", detailInvoice: [{ invoice: { number: "INV/2610/HZ02233" }, paymentAmount: 700000 }] },
        2: { number: "110102.2026.11.16020", transDate: "28/11/2026", detailInvoice: [{ invoice: { number: "INV/2610/HZ02233" }, paymentAmount: 700000 }] },
        3: { number: "110102.2026.11.15105", transDate: "25/11/2026", detailInvoice: [{ invoice: { number: "INV/2610/HZ09999" }, paymentAmount: 800000 }] },
    };
    const kueri: Record<string, unknown>[] = [];
    const fetch = async (path: string, _m: string, q?: unknown) => {
        const p = (q ?? {}) as Record<string, unknown>;
        if (path === "/api/sales-receipt/list.do") { kueri.push(p); return { s: true, d: [{ id: 1 }, { id: 2 }, { id: 3 }] }; }
        if (path === "/api/sales-receipt/detail.do") return { s: true, d: struk[Number(p.id)] };
        if (p["filter.number.val"] === "INV/2610/HZ02233") return { s: true, d: [{ number: "INV/2610/HZ02233", primeOwing: 6396469.83, customer: { customerNo: "C-SI0054-HZ" }, branch: { id: 1, name: "B" } }] };
        return { s: true, d: [] };
    };
    const rows = [{ "Code Outlet": "C-SI0054", "No. Nota": "INV/2610/HZ02233", "Saldo": 7796470.06, "Tunai": 700000 }];
    const out = await parsePelunasan(rows, { trxDate: "2026-11-27", isKeySaved: true, peta: PETA, accurateFetch: fetch as never });
    assert.equal(out.payload.length, 0, "tetap tidak dikirim");
    const d = out.counts.skipped[0];
    assert.equal(d.reason, "PERLU_CEK");
    assert.match(d.detail ?? "", /Pelunasan di Accurate sejak 28\/09\/2026: 110102\.2026\.11\.16019 \(28\/11\/2026\) Rp 700\.000; 110102\.2026\.11\.16020 \(28\/11\/2026\) Rp 700\.000\. DUGAAN INPUT DOBEL: 110102\.2026\.11\.16019, 110102\.2026\.11\.16020/);
    assert.doesNotMatch(d.detail ?? "", /15105/, "pelunasan faktur lain tidak ikut");
    assert.equal(kueri[0]["filter.customerNo"], "C-SI0054-HZ");
    // Galat baca riwayat: Tinjau tetap jalan, keterangan menyebutnya.
    const galat = await parsePelunasan(rows, { trxDate: "2026-11-27", isKeySaved: true, peta: PETA,
        accurateFetch: (async (path: string, m: string, q?: unknown) => (path.startsWith("/api/sales-receipt/") ? Promise.reject(new Error("429")) : fetch(path, m, q))) as never });
    assert.match(galat.counts.skipped[0].detail ?? "", /Pelunasan di Accurate: tidak terbaca/);
});
