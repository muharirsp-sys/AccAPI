/**
 * Tujuan: fixture GENERIK uji karakterisasi Pelunasan (S6e-1) — baris Excel (bentuk keluaran `sheet_to_json` setelah
 *   header `(*wajib)` dibersihkan, W:261-273) + isi Accurate tiruan untuk `emulator-accurate.ts`.
 * Caller: lib/pelunasan/pelunasan.test.ts (dan perekam golden sekali-pakai).
 * Side Effects: tidak ada. Tiap fixture adalah FUNGSI → objek segar tiap panggilan (kode pelunasan memutasi baris).
 * Data contoh generik (PELANGGAN A, CABANG A, INV/2610/XX…) — bukan data principal/pelanggan nyata.
 */
import type { DataAccurate } from "./emulator-accurate.ts";
import { buildSalesReceiptIdempotencyPayload } from "../../sales-receipt-fingerprint.ts";

type Baris = Record<string, string | number>;
export type OpsiFixture = {
    trxDate: string;
    isKeySaved: boolean;
    mapTunaiAutoNum: string; mapTunaiBank: string;
    mapTrfAutoNum: string; mapTrfBank: string;
    mapBgAutoNum: string; mapBgBank: string;
    mapPot1Account: string; mapPot2Account: string; mapPot3Account: string;
};
export type Fixture = { nama: string; catatan: string; rows: Baris[]; data: DataAccurate; opsi: OpsiFixture };

const OPSI_DASAR: OpsiFixture = {
    trxDate: "2026-10-09", isKeySaved: true,
    mapTunaiAutoNum: "", mapTunaiBank: "",
    mapTrfAutoNum: "", mapTrfBank: "",
    mapBgAutoNum: "", mapBgBank: "",
    mapPot1Account: "", mapPot2Account: "", mapPot3Account: "",
};

const CABANG_A = { id: 1, name: "CABANG A" };
const CABANG_B = { id: 2, name: "CABANG B" };
const plg = (customerNo: string, name: string) => ({ id: Number(customerNo.replace(/\D/g, "")), customerNo, name });

const faktur = (no: string, primeOwing: number, customerNo: string, extra: Record<string, unknown> = {}) => ({
    id: 1000 + Number(no.replace(/\D/g, "").slice(-4)),
    number: no, primeOwing, branch: CABANG_A, customer: plg(customerNo, `PELANGGAN ${customerNo}`), charField1: "", description: "", ...extra,
});

const retur = (id: number, number: string, primeOwing: number, customerNo: string, extra: Record<string, unknown> = {}) => ({
    id, number, primeOwing, branch: CABANG_B, customer: plg(customerNo, `PELANGGAN ${customerNo}`),
    description: "", keywords: "", returnDocumentNumber: "", documentCode: "", charField1: "", ...extra,
});

const f1 = (): Fixture => ({
    nama: "f01-tunai-total-trx",
    catatan: "Tunai + Total.Trx: lunas pas, snap Total.Trx ≤ Rp 100 (bump kas), Total.Trx > piutang (dibatasi piutang); Total.Trx = 0 eksplisit (tidak ada yang dibayar).",
    opsi: { ...OPSI_DASAR, mapTunaiAutoNum: "300", mapTunaiBank: "110102" },
    rows: [
        { "Code Outlet": "PLG-A-001", "No. Nota": "INV/2610/XX00001", "Tunai": 1500000, "Total.Trx": 1500000, "Ket. All Trx": "Setoran harian 1" },
        { "Code Outlet": "PLG-A-001", "No. Nota": "INV/2610/XX00002", "Tunai": 999950, "Total.Trx": 999950, "Ket. All Trx": "Setoran harian 1" },
        { "Code Outlet": "PLG-A-002", "No. Nota": "INV/2610/XX00003", "Tunai": 600000, "Total.Trx": 600000 },
        { "Code Outlet": "PLG-A-002", "No. Nota": "INV/2610/XX00004", "Tunai": 50000, "Total.Trx": 0 },
    ],
    data: {
        salesInvoice: [
            faktur("INV/2610/XX00001", 1500000, "PLG-A-001"),
            faktur("INV/2610/XX00002", 1000000, "PLG-A-001"),
            faktur("INV/2610/XX00003", 500000, "PLG-A-002"),
            faktur("INV/2610/XX00004", 50000, "PLG-A-002"),
        ],
        salesReturn: [],
    },
});

const f2 = (): Fixture => ({
    nama: "f02-transfer-tanpa-total-trx",
    catatan: "Format terdeteksi tanpa Total.Trx; Trf MAYBANK/PRMT/Ket.TF; snap ≤ 100 tanpa Total.Trx; overpay dibatasi piutang; "
        + "pencarian faktur EQUAL / KEYWORD_FULL / NUMBER_CONTAIN_FULL / NUMBER_CONTAIN_TAIL / tidak ketemu (anti-ghosting).",
    opsi: { ...OPSI_DASAR, mapTrfAutoNum: "450", mapTrfBank: "110103" },
    rows: [
        { "Code Outlet": "PLG-A-001", "No. Nota": "INV/2610/XX00011", "Trf": 2000040, "Ket. Trf": "trf maybank 01" },
        { "Code Outlet": "PLG-A-001", "No. Nota": "INV/2610/XX00012", "Trf": 750000, "Ket. Trf": "PRMT" },
        { "Code Outlet": "PLG-A-002", "No. Nota": "INV/2610/XX00013", "Trf": 3000000, "Ket.TF": "BCA 22" },
        { "Code Outlet": "PLG-A-002", "No. Nota": "INV/2610/XX00099", "Trf": 100000, "Ket.TF": "BCA 22" },
        { "Code Outlet": "PLG-A-003", "No. Nota": "XX00015", "Trf": 400000 },
        { "Code Outlet": "PLG-A-003", "No. Nota": "FJ/2610/XX00016", "Trf": 250000 },
        { "Code Outlet": "PLG-A-003", "No. Nota": "INV/2610/XX00017", "Trf": 125000.5 },
    ],
    data: {
        salesInvoice: [
            faktur("INV/2610/XX00011", 2000000, "PLG-A-001"),
            faktur("INV/2610/XX00012", 1000000, "PLG-A-001"),
            faktur("INV/2610/XX00013", 2500000, "PLG-A-002", { branch: CABANG_B }),
            faktur("INV/2610/XX00015", 400000, "PLG-A-003"),
            faktur("INV/2610/XX00016", 300000, "PLG-A-003"),
            faktur("INV/2610/XX00017-R", 125000.5, "PLG-A-003"),
        ],
        salesReturn: [],
    },
});

const f3 = (): Fixture => ({
    nama: "f03-bg-biaya-disctb-multi-bayar",
    catatan: "BG + Ket.BG + BiayaTrf/BG (akun 600123) + Pot.DiscTB; Trf + biaya (600126); satu baris Tunai+Trf (diskon ke bayar terbesar); "
        + "typeAutoNumber kosong dibuang; akun Pot.1 terpetakan, Pot.2 placeholder.",
    opsi: { ...OPSI_DASAR, mapTrfBank: "110103", mapTrfAutoNum: "450", mapPot1Account: "610101" },
    rows: [
        { "Code Outlet": "PLG-B-001", "No. Nota": "INV/2610/XX00021", "BG": 5000000, "Ket.BG": "BG-778899", "BiayaTrf/BG": 6500, "Pot.DiscTB": 25000, "Total.Trx": 5031500 },
        { "Code Outlet": "PLG-B-001", "No. Nota": "INV/2610/XX00022", "Trf": 1000000, "BiayaTrf/BG": 5000, "Ket. Trf": "BCA" },
        { "Code Outlet": "PLG-B-002", "No. Nota": "INV/2610/XX00023", "Tunai": 200000, "Trf": 300000, "Pot.1 Kwtnsi": 20000, "Pot.2 Kwtnsi": 5000, "Ket. Trf": "BCA" },
    ],
    data: {
        salesInvoice: [
            faktur("INV/2610/XX00021", 5031500, "PLG-B-001"),
            faktur("INV/2610/XX00022", 1005000, "PLG-B-001"),
            faktur("INV/2610/XX00023", 525000, "PLG-B-002"),
        ],
        salesReturn: [],
    },
});

const f4 = (): Fixture => ({
    nama: "f04-potongan-kwitansi",
    catatan: "Pot.1/2/3 + Tunai dengan Total.Trx; diskon diskalakan turun (Total.Trx < diskon); healing potongan ke piutang ≤ 100; "
        + "pembayaran RETUR_ONLY (OTHERS) untuk baris potongan saja; placeholder akun Pot.2/Pot.3.",
    opsi: { ...OPSI_DASAR, mapPot1Account: "610101" },
    rows: [
        { "Code Outlet": "PLG-C-001", "No. Nota": "INV/2610/XX00031", "Tunai": 900000, "Pot.1 Kwtnsi": 50000, "Pot.2 Kwtnsi": 30000, "Pot.3 Kwtnsi": 20000, "Total.Trx": 950000 },
        { "Code Outlet": "PLG-C-001", "No. Nota": "INV/2610/XX00032", "Pot.1 Kwtnsi": 80000, "Pot.2 Kwtnsi": 40000, "Total.Trx": 100000 },
        { "Code Outlet": "PLG-C-002", "No. Nota": "INV/2610/XX00033", "Pot.3 Kwtnsi": 299950 },
    ],
    data: {
        salesInvoice: [
            faktur("INV/2610/XX00031", 950000, "PLG-C-001"),
            faktur("INV/2610/XX00032", 100000, "PLG-C-001"),
            faktur("INV/2610/XX00033", 300000, "PLG-C-002"),
        ],
        salesReturn: [],
    },
});

const f5 = (): Fixture => ({
    nama: "f05-retur-srb-rjs",
    catatan: "SRB ketemu lewat keywords (snap retur ≤ 100); RJS nomor penuh SRT/… lewat EQUAL (retur saja → OTHERS); "
        + "SRB yang di Accurate tersimpan TANPA spasi (variannya ketemu, skornya 0) → NOT_FOUND → baris manual.",
    opsi: { ...OPSI_DASAR, mapTunaiAutoNum: "300" },
    rows: [
        { "Code Outlet": "PLG-D-001", "No. Nota": "INV/2610/XX00041", "Tunai": 800000, "No.SRB Rt Ktr": "SRB 2610.0001", "Pot.RT Ktr": 199960 },
        { "Code Outlet": "PLG-D-001", "No. Nota": "INV/2610/XX00042", "No.RJS RT Gt": "SRT/2610/XX0002", "Pot. RT Gt": 150000 },
        { "Code Outlet": "PLG-D-002", "No. Nota": "INV/2610/XX00043", "Tunai": 100000, "No.SRB Rt Ktr": "SRB 2610.0003", "Pot.RT Ktr": 50000, "Ket. All Trx": "Setoran D2" },
    ],
    data: {
        salesInvoice: [
            faktur("INV/2610/XX00041", 1000000, "PLG-D-001"),
            faktur("INV/2610/XX00042", 150000, "PLG-D-001"),
            faktur("INV/2610/XX00043", 150000, "PLG-D-002"),
        ],
        salesReturn: [
            retur(201, "SRT/2610/XX0001", 200000, "PLG-D-001", { keywords: "SRB 2610.0001", description: "Retur SRB 2610.0001" }),
            retur(202, "SRT/2610/XX0002", 150000, "PLG-D-001"),
            retur(203, "SRT/2610/XX0003", 50000, "PLG-D-002", { keywords: "SRB2610.0003" }),
        ],
    },
});

const f6 = (): Fixture => ({
    nama: "f06-ayat-silang-waterfall",
    catatan: "Ket. Pot RJN/…,… + Pot. Lain disuntik jadi SRB; ayat silang dicari di sales-invoice (keyword kode), detail.do memperkaya "
        + "primeOwing; waterfall dua dokumen RJN; baris ke-2 memakai sisa primeOwing di memori; SRT.… ayat silang (detail.do galat → "
        + "primeOwing list); faktur lain berawalan sama (XX00010) tidak ikut.",
    opsi: { ...OPSI_DASAR, mapTunaiAutoNum: "300", mapTunaiBank: "110102" },
    rows: [
        { "Code Outlet": "PLG-E-001", "No. Nota": "INV/2610/XX00051", "Tunai": 700000, "Ket. Pot": "RJN/2610/XX0001,XX0002", "Pot. Lain": 300000 },
        { "Code Outlet": "PLG-E-001", "No. Nota": "INV/2610/XX00052", "Ket. Pot": "RJN/2610/XX0001,XX0002", "Pot. Lain": 50000 },
        { "Code Outlet": "PLG-E-001", "No. Nota": "INV/2610/XX00053", "Tunai": 400000, "No.SRB Rt Ktr": "SRT.2610.0009", "Pot.RT Ktr": 100000 },
    ],
    data: {
        salesInvoice: [
            faktur("INV/2610/XX00051", 1000000, "PLG-E-001"),
            faktur("INV/2610/XX00052", 50000, "PLG-E-001"),
            faktur("INV/2610/XX00053", 500000, "PLG-E-001"),
            faktur("INV/2610/XX00010", 70000, "PLG-E-009"),
            { id: 501, number: "RJN/2610/XX0001", primeOwing: 200000, _detail: { primeOwing: 180000 }, branch: CABANG_B, customer: plg("PLG-E-005", "PELANGGAN E5"), description: "" },
            { id: 502, number: "RJN/2610/XX0002", primeOwing: 150000, branch: CABANG_B, customer: plg("PLG-E-005", "PELANGGAN E5"), description: "" },
            { id: 503, number: "SRT.2610.0009", primeOwing: 100000, branch: CABANG_A, customer: plg("PLG-E-001", "PELANGGAN E1"), description: "" },
        ],
        salesReturn: [],
        galat: ['{"number":"SRT.2610.0009"}'],
    },
});

/** 120 retur pelanggan PLG-F-003 (2 halaman) supaya Step5 omni melewati paginasi. */
const returOmni = () => Array.from({ length: 120 }, (_, i) => retur(400 + i, `SRT/2610/XF${String(i).padStart(4, "0")}`, 10000, "PLG-F-003",
    i === 110 ? { description: "RB-0006 retur rusak" } : {}));

const f7 = (): Fixture => ({
    nama: "f07-retur-step4-step5-galat",
    catatan: "Pencarian kode retur galat jaringan (_ERR) → Step4 (keyword ekor faktur) menemukan; Step5 omni pelanggan dengan paginasi; "
        + "Step4 melempar → ERROR → NOT_FOUND; baris retur-saja yang NOT_FOUND dilewati; peringatan kembar dideduplikasi.",
    opsi: { ...OPSI_DASAR },
    rows: [
        { "Code Outlet": "PLG-F-001", "No. Nota": "INV/2610/XX00061", "Tunai": 300000, "No.SRB Rt Ktr": "RB-0005", "Pot.RT Ktr": 60000 },
        { "Code Outlet": "PLG-F-003", "No. Nota": "INV/2610/XX00063", "Tunai": 90000, "No.SRB Rt Ktr": "RB-0006", "Pot.RT Ktr": 10000 },
        { "Code Outlet": "PLG-F-004", "No. Nota": "INV/2610/XX00064", "Tunai": 50000, "No.SRB Rt Ktr": "RB-0007", "Pot.RT Ktr": 5000 },
        { "Code Outlet": "PLG-F-004", "No. Nota": "INV/2610/XX00064", "Tunai": 50000, "No.SRB Rt Ktr": "RB-0007", "Pot.RT Ktr": 5000 },
        { "Code Outlet": "PLG-F-005", "No. Nota": "INV/2610/XX00065", "No.SRB Rt Ktr": "RB-0008", "Pot.RT Ktr": 70000 },
    ],
    data: {
        salesInvoice: [
            faktur("INV/2610/XX00061", 360000, "PLG-F-001"),
            faktur("INV/2610/XX00063", 100000, "PLG-F-003"),
            faktur("INV/2610/XX00064", 200000, "PLG-F-004"),
            faktur("INV/2610/XX00065", 70000, "PLG-F-005"),
        ],
        salesReturn: [
            retur(301, "SRT/2610/XF0005", 60000, "PLG-F-001", { description: "Retur INV/2610/XX00061 RB-0005" }),
            ...returOmni(),
        ],
        galat: ['"RB-0005"', '"RB-0006"', '"keyword":"XX00064"'],
    },
});

const f8 = (): Fixture => ({
    nama: "f08-multi-faktur-waterfall",
    catatan: "Satu faktur dibayar beberapa baris (sisa piutang di memori, overpay dipotong, anti-ghosting saat sisa 0); dua faktur satu "
        + "pelanggan satu kelompok; faktur sama dua kali dalam kelompok (paymentAmount & diskon digabung); noise float dirapikan; "
        + "baris tanpa Code Outlet / tanpa nominal dilewati; baris tanpa No. Nota.",
    opsi: { ...OPSI_DASAR, mapTunaiAutoNum: "300", mapPot1Account: "610101" },
    rows: [
        { "Code Outlet": "PLG-G-001", "No. Nota": "INV/2610/XX00071", "Tunai": 600000 },
        { "Code Outlet": "PLG-G-001", "No. Nota": "INV/2610/XX00071", "Trf": 500000 },
        { "Code Outlet": "PLG-G-001", "No. Nota": "INV/2610/XX00071", "Tunai": 100000 },
        { "Code Outlet": "PLG-G-002", "No. Nota": "INV/2610/XX00072", "Tunai": 200000.1 },
        { "Code Outlet": "PLG-G-002", "No. Nota": "INV/2610/XX00073", "Tunai": 100000.2 },
        { "Code Outlet": "PLG-G-002", "No. Nota": "INV/2610/XX00073", "Tunai": 50000, "Pot.1 Kwtnsi": 10000 },
        { "No. Nota": "INV/2610/XX00074", "Tunai": 1 },
        { "Code Outlet": "PLG-G-003", "No. Nota": "INV/2610/XX00075", "Ket. All Trx": "kosong" },
        { "Code Outlet": "PLG-G-003", "Tunai": 5000 },
    ],
    data: {
        salesInvoice: [
            faktur("INV/2610/XX00071", 1000000, "PLG-G-001"),
            faktur("INV/2610/XX00072", 500000, "PLG-G-002"),
            faktur("INV/2610/XX00073", 400000, "PLG-G-002"),
        ],
        salesReturn: [],
    },
});

const f9 = (): Fixture => ({
    nama: "f09-tanpa-sesi-accurate",
    catatan: "isKeySaved=false: tidak ada pencarian sama sekali; retur jadi baris manual; kas tetap dibentuk tanpa cabang.",
    opsi: { ...OPSI_DASAR, isKeySaved: false },
    rows: [
        { "Code Outlet": "PLG-H-001", "No. Nota": "INV/2610/XX00081", "Tunai": 250000, "No.SRB Rt Ktr": "SRB 2610.0081", "Pot.RT Ktr": 25000, "Ket. All Trx": "Setoran H" },
        { "Code Outlet": "PLG-H-001", "No. Nota": "INV/2610/XX00082", "BG": 100000, "Ket.BG": 445566 },
    ],
    data: { salesInvoice: [faktur("INV/2610/XX00081", 275000, "PLG-H-001")], salesReturn: [] },
});

/** Faktur hasil Antrean Faktur: kepala membawa kunci antrean di charField1 dan "Order …" di description (lib/accurate-invoice-write.ts:262-266). */
export const fakturAntrean = (charField1: string) => (): Fixture => ({
    nama: charField1 ? "f10-faktur-antrean-charfield1" : "f10b-faktur-antrean-tanpa-charfield1",
    catatan: "Faktur Antrean (charField1 kepala = kunci PRINCIPAL:SO) + SRB biasa dan SRB tanpa-spasi: hasil HARUS sama dengan kembarannya "
        + "yang charField1 kosong (bukti: charField1 faktur tidak memengaruhi pencarian retur).",
    opsi: { ...OPSI_DASAR, mapTunaiAutoNum: "300" },
    rows: [
        { "Code Outlet": "PLG-J-001", "No. Nota": "INV/2610/XX00091", "Tunai": 900000, "No.SRB Rt Ktr": "SRB 2610.0091", "Pot.RT Ktr": 100000 },
        { "Code Outlet": "PLG-J-001", "No. Nota": "INV/2610/XX00092", "Tunai": 400000, "No.SRB Rt Ktr": "SRB 2610.0092", "Pot.RT Ktr": 100000 },
    ],
    data: {
        salesInvoice: [
            faktur("INV/2610/XX00091", 1000000, "PLG-J-001", { charField1, description: charField1 ? `Order ${charField1} | PELANGGAN J | GT` : "" }),
            faktur("INV/2610/XX00092", 500000, "PLG-J-001", { charField1, description: charField1 ? `Order ${charField1} | PELANGGAN J | GT` : "" }),
        ],
        salesReturn: [
            retur(601, "SRT/2610/XJ0091", 100000, "PLG-J-001", { keywords: "SRB 2610.0091", customer: { ...plg("PLG-J-001", "PELANGGAN J"), charField1: "CABANG A" } }),
            retur(602, "SRT/2610/XJ0092", 100000, "PLG-J-001", { keywords: "SRB2610.0092", customer: { ...plg("PLG-J-001", "PELANGGAN J"), charField1: "CABANG A" } }),
        ],
    },
});

const f11 = (): Fixture => ({
    nama: "f11-bukan-format-pelunasan",
    catatan: "Tanpa sinyal kolom Pelunasan → deteksi false → parser Pelunasan tidak jalan (jatuh ke grouping generik halaman).",
    opsi: { ...OPSI_DASAR },
    rows: [{ "Code Outlet": "PLG-K-001", "No. Nota": "INV/2610/XX00099", "Jumlah": 5 }],
    data: { salesInvoice: [], salesReturn: [] },
});

export const FIXTURES: Array<() => Fixture> = [f1, f2, f3, f4, f5, f6, f7, f8, f9, fakturAntrean("PRINCIPAL-A:SO-0001"), fakturAntrean(""), f11];

/** Fixture pratinjau duplikat (W:1903-2053): duplikat dalam unggahan, kunci terblokir, dan histori Accurate. */
export const fixturePratinjau = () => {
    const sr = (customerNo: string, invoiceNo: string, paymentAmount: number, extra: Record<string, unknown> = {}) => ({
        bankNo: "110102", chequeAmount: paymentAmount, customerNo, transDate: "09/10/2026", paymentMethod: "CASH_OTHER",
        detailInvoice: [{ invoiceNo, paymentAmount }], ...extra,
    });
    const rows = [
        sr("PLG-A-001", "INV/2610/XX00001", 100000),
        sr("PLG-A-001", "INV/2610/XX00001", 100000, { description: "kembar" }),
        sr("PLG-A-002", "INV/2610/XX00002", 200000),
        sr("PLG-A-003", "INV/2610/XX00003", 300000),
        sr("PLG-A-004", "INV/2610/XX00004", 400000),
    ];
    const data: DataAccurate = {
        salesInvoice: [], salesReturn: [],
        salesReceipt: [
            { id: 9001, number: "RCP/2610/0001", customer: { customerNo: "PLG-A-003" }, customerNo: "PLG-A-003", transDate: "09/10/2026",
                paymentMethod: "CASH_OTHER", chequeAmount: 300000, detailInvoice: [{ invoiceNo: "INV/2610/XX00003", paymentAmount: 300000 }] },
            { id: 9002, number: "RCP/2610/0002", customer: { customerNo: "PLG-A-003" }, customerNo: "PLG-A-003", transDate: "09/10/2026",
                paymentMethod: "CASH_OTHER", chequeAmount: 5000, detailInvoice: [{ invoiceNo: "INV/2610/XX00009", paymentAmount: 5000 }] },
        ],
    };
    const kunci = buildSalesReceiptIdempotencyPayload(rows[2]).key;
    const blockedEntries = [{ key: kunci, reason: "ALREADY_SUCCESS" }, { key: kunci, reason: "ALREADY_SUCCESS" }, { key: kunci, reason: "UNKNOWN_OUTCOME" }];
    return { rows, data, routeKey: "salesReceiptBulk", blockedEntries };
};
