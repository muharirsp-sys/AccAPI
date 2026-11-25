/*
 * Tujuan: Mengunci aturan wizard Pelunasan (S6e-2b): akun wajib menurut isi berkas, penanda ISI_KODE_AKUN_ ditolak, baris ganda ditahan
 *   kecuali diizinkan Finance, kunci override lock = yang dipakai server (ganda berkas / dikunci / riwayat Accurate), dan hasil Selesaikan
 *   (SUCCESS = terposting bernomor, FAILED = Gagal boleh diulang) menggantikan Tidak pasti.
 * Caller: npm test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
    AKUN_AWAL, KODE_DISELESAIKAN, barisLaporanHasil, bersihkanHeader, cariBarisHeader, hitungHasil, isiBerkas, nomorTerposting, paketDari, periksaAkun,
    rencanaKirim, ringkasKelompok, tanggalLaporan, terapkanPenyelesaian,
} from "./pelunasan-wizard.ts";
import { buildSalesReceiptIdempotencyPayload } from "./sales-receipt-fingerprint.ts";
import type { DuplicateReviewEntry } from "./pelunasan/pratinjau-ganda.ts";

test("Form Kerja Inc harian: header di baris ke-4, tanggal di D1, nama kolom disamakan ke nama mesin", () => {
    // Bentuk nyata New Laporan AR\DD.xlsx (Okt 2026): D1 tanggal (serial), baris 2 kosong, baris 3 total, baris 4 header.
    const aoa = [
        [null, null, null, 46296],
        [],
        [null, null, null, null, 345986492.03, "60  >> BG", 761],
        ["Fix_Inc_1.xlsx", "Form Kerja Inc", "Code Outlet", "No. Nota", "Ket.Trf", "Biaya Trf/BG", "No.SRB RT Ktr", "Pot.RT Gt", "Pot.Lain", "Ket.Potong", "Ket.ALL Trx"],
    ];
    assert.equal(cariBarisHeader(aoa), 3);
    assert.equal(tanggalLaporan(aoa, 3), "2026-10-01");
    assert.equal(cariBarisHeader([["Code Outlet", "No. Nota", "Tunai"]]), 0, "Format Pelunasan lama: header di baris pertama");
    assert.equal(cariBarisHeader([["a"], ["b"]]), -1);
    const [b] = bersihkanHeader([{ "Code Outlet": "C-DEL015", "Ket.Trf": "TF MAYBANK (1) 1/10", "Biaya Trf/BG": 10000, "No.SRB RT Ktr": "SRB 2653.57",
        "Pot.RT Gt": 5, "Pot.Lain": 7, "Ket.Potong": "PPN RETUR", "Ket.ALL Trx": "TF, " }]);
    assert.deepEqual(Object.keys(b), ["Code Outlet", "Ket. Trf", "BiayaTrf/BG", "No.SRB Rt Ktr", "Pot. RT Gt", "Pot. Lain", "Ket. Pot", "Ket. All Trx"]);
});

test("isi berkas per jenis: bank transfer dari Ket. Trf (salah ketik Maybank ikut), Pot. Lain PPN/klaim/retur, biaya BG vs transfer", () => {
    const rows = bersihkanHeader([
        { "Code Outlet (*wajib)": "PELANGGAN-A", "No. Nota": "INV-1", Trf: 1000, "Ket. Trf": "BCA" },
        { "Code Outlet": "PELANGGAN-B", "No. Nota": "INV-2", Trf: 500, "Ket.Trf": "TF MAYBAK (500) 1/10", "Biaya Trf/BG": 10 },
        { "Code Outlet": "PELANGGAN-C", "No. Nota": "INV-3", BG: 700, "Pot.2 Kwtnsi": 10, "Biaya Trf/BG": 5 },
        { "Code Outlet": "PELANGGAN-D", "No. Nota": "INV-4", "Pot.Lain": 30, "Ket.Potong": "PPN RETUR" },
        { "Code Outlet": "PELANGGAN-E", "No. Nota": "INV-5", "Pot.Lain": 40, "Ket.Potong": "061/SUPER-ABCPI/04/2026" },
        { "Code Outlet": "PELANGGAN-F", "No. Nota": "INV-6", "Pot.Lain": 50, "Ket.Potong": "RJN/2608/M200134", "Pot.RT Ktr": 5 },
        { "Code Outlet": "", "No. Nota": "" },
    ]);
    const { baris, jenis } = isiBerkas([...rows, ...bersihkanHeader([{ "Code Outlet": "PELANGGAN-G", "No. Nota": "INV-7", Trf: 70, "Ket.Trf": "KELEBIHAN TF (26,024,973) AR TGL 8/4" }])]);
    assert.equal(baris, 7);
    assert.deepEqual(jenis.trf, { baris: 1, nilai: 1000 });
    assert.deepEqual(jenis.maybank, { baris: 2, nilai: 570 }, "KELEBIHAN TF ikut Maybank (praktik admin)");
    assert.deepEqual(jenis.bg, { baris: 1, nilai: 700 });
    assert.deepEqual(jenis.kwitansi, { baris: 1, nilai: 10 });
    assert.deepEqual([jenis.biayaTrf.nilai, jenis.biayaBg.nilai], [10, 5]);
    assert.deepEqual([jenis.ppnRetur.nilai, jenis.potLain.nilai, jenis.retur.nilai], [30, 40, 55]);
});

test("akun: bawaan praktik Accurate lolos; Transfer bank lain wajib bila dipakai; penanda ISI_KODE_AKUN_ tidak lolos", () => {
    const isi = isiBerkas([{ "Code Outlet": "A", "No. Nota": "I", Trf: 10, "Ket. Trf": "BCA" }, { "Code Outlet": "B", "No. Nota": "J", BG: 4, "Pot.1 Kwtnsi": 2 }]);
    assert.deepEqual(Object.keys(periksaAkun(AKUN_AWAL, isi)), ["trf"]);
    assert.match(periksaAkun(AKUN_AWAL, isi).trf ?? "", /Wajib: 1 baris/);
    assert.deepEqual(periksaAkun({ ...AKUN_AWAL, trf: "110103" }, isi), {});
    assert.ok(periksaAkun({ ...AKUN_AWAL, trf: "110103", bg: "" }, isi).bg, "rekening yang dipakai berkas tidak boleh dikosongkan");
    assert.ok(periksaAkun({ ...AKUN_AWAL, trf: "110103", kwitansi: "isi_kode_akun_pot1_di_ui" }, isi).kwitansi, "penanda (huruf apa pun) ditolak");
});

test("ringkasan kelompok: rekening uang, potongan per akun, retur negatif, ayat silang", () => {
    const k = ringkasKelompok([
        { bankNo: "110105", paymentMethod: "BANK_TRANSFER", chequeAmount: 990, detailInvoice: [{ invoiceNo: "I1", paymentAmount: 1000, detailDiscount: [{ amount: 10, accountNo: "600126" }] }] },
        { bankNo: "110102", paymentMethod: "OTHERS", chequeAmount: 0, detailInvoice: [{ invoiceNo: "I2", paymentAmount: 50 }, { invoiceNo: "RJN/1", paymentAmount: -50 }] },
        { bankNo: "110120", paymentMethod: "OTHERS", chequeAmount: 30, detailInvoice: [{ invoiceNo: "I3", paymentAmount: 30 }] },
        { bankNo: "110120", paymentMethod: "OTHERS", chequeAmount: -30, detailInvoice: [{ invoiceNo: "RJN/2", paymentAmount: -30 }] },
    ]);
    const cari = (kelompok: string) => k.find((b) => b.kelompok === kelompok);
    assert.deepEqual([cari("Transfer")?.akun, cari("Transfer")?.nilai, cari("Transfer")?.nama], ["110105", 990, "Bank Maybank 2115003838"]);
    assert.deepEqual([cari("Potongan")?.akun, cari("Potongan")?.nilai], ["600126", 10]);
    assert.deepEqual([cari("Retur (baris negatif)")?.baris, cari("Retur (baris negatif)")?.nilai], [1, 50]);
    assert.deepEqual([cari("Ayat silang · sisi faktur")?.nilai, cari("Ayat silang · sisi retur")?.nilai], [30, -30]);
    assert.deepEqual([cari("Ayat silang · sisi faktur")?.baris, cari("Ayat silang · sisi retur")?.baris], [1, 1]);
});

const row = (customerNo: string, invoiceNo: string, amount: number) => ({ customerNo, transDate: "09/10/2026", paymentMethod: "CASH_OTHER", chequeAmount: amount, detailInvoice: [{ invoiceNo, paymentAmount: amount, detailDiscount: [] }] });
const entry = (index: number, r: Record<string, unknown>, reasons: DuplicateReviewEntry["reasons"], recommended = false): DuplicateReviewEntry => ({
    reviewId: `${buildSalesReceiptIdempotencyPayload(r).key}__${index}`, key: buildSalesReceiptIdempotencyPayload(r).key, row: r, originalIndex: index,
    invoiceNo: "", customerNo: "", amount: 0, transDate: "", paymentMethod: "", reasons, recommended, matchedReceiptNumbers: [],
});

test("rencana kirim: ganda ditahan tanpa izin; izin Finance → kunci override per alasan", () => {
    const a = row("PELANGGAN-A", "INV-1", 100);
    const b = row("PELANGGAN-B", "INV-2", 200);
    const c = row("PELANGGAN-C", "INV-3", 300);
    const d = row("PELANGGAN-D", "INV-4", 400);
    const e = row("PELANGGAN-E", "INV-5", 500);
    const payload = [a, a, b, c, d, e];
    const review = [
        entry(0, a, ["DUPLICATE_IN_UPLOAD"], true),
        entry(1, a, ["DUPLICATE_IN_UPLOAD"]),
        entry(2, b, ["ACCURATE_HISTORY"]),
        entry(3, c, ["UNKNOWN_OUTCOME"]),
        entry(5, e, ["ACCURATE_HISTORY_UNREADABLE"]),
    ];
    // Cicilan belum terkirim yang juga mirip riwayat: takeover + override riwayat sekaligus (kontrak §5 hint "takeover").
    const f = row("PELANGGAN-F", "INV-6", 600);
    const cicilan = rencanaKirim([f], [entry(0, f, ["UNKNOWN_OUTCOME", "ACCURATE_HISTORY"])], new Set([`${buildSalesReceiptIdempotencyPayload(f).key}__0`]));
    assert.deepEqual(cicilan.override, { allowDuplicateKeys: [], allowLockedKeys: [buildSalesReceiptIdempotencyPayload(f).key], allowHistoryKeys: [buildSalesReceiptIdempotencyPayload(f).key] });
    assert.equal(cicilan.takeover.length, 1);
    const tanpaIzin = rencanaKirim(payload, review, new Set());
    assert.deepEqual(tanpaIzin.kirim, [a, d], "baris pertama ganda-berkas ikut; sisanya ditahan (riwayat tak terbaca juga)");
    assert.equal(tanpaIzin.ditahan.length, 4);
    assert.equal(tanpaIzin.perluAlasan, false);

    const semua = rencanaKirim(payload, review, new Set(review.map((r) => r.reviewId)));
    assert.equal(semua.kirim.length, 6);
    assert.deepEqual(semua.override, {
        allowDuplicateKeys: [review[1].key],
        allowLockedKeys: [review[3].key],
        allowHistoryKeys: [review[2].key, review[4].key],
    });
    assert.equal(semua.perluAlasan, true);
});

test("hitung hasil per keadaan", () => {
    assert.deepEqual(hitungHasil([
        { outcome: "terposting" }, { outcome: "tidak_pasti" },
        { outcome: "gagal" }, { outcome: "terposting" },
    ]), { terposting: 2, gagal: 1, tidak_pasti: 1, ditahan: 0 });
});

test("paket per hasil dan penyelesaian Tidak pasti", () => {
    const rows = [
        { index: 0, paket: 1, outcome: "terposting" as const, message: "" }, { index: 1, paket: 2, outcome: "tidak_pasti" as const, message: "x" },
        { index: 2, paket: 3, outcome: "tidak_pasti" as const, message: "y" }, { index: 3, paket: 2, outcome: "tidak_pasti" as const, message: "z" },
    ];
    assert.deepEqual(paketDari(rows, "tidak_pasti"), [2, 3]);
    assert.deepEqual(paketDari(rows, "gagal"), []);
    assert.equal(terapkanPenyelesaian(rows[1], 1, undefined), rows[1], "tanpa keputusan = hasil kirim apa adanya");
    const ya = terapkanPenyelesaian(rows[1], 1, { status: "SUCCESS", nomor: ["PR.1"], pesan: "" });
    assert.equal(ya?.outcome, "terposting");
    assert.deepEqual(ya?.receiptNumbers, ["PR.1"]);
    assert.equal(ya?.paket, 2, "paket asal tetap");
    const tidak = terapkanPenyelesaian(undefined, 5, { status: "FAILED", nomor: [], pesan: "" });
    assert.equal(tidak?.outcome, "gagal");
    assert.match(tidak?.message ?? "", /boleh dikirim ulang/);
    assert.deepEqual(hitungHasil([ya!, tidak!, rows[2]]), { terposting: 1, gagal: 1, tidak_pasti: 1, ditahan: 0 });
});

test("susulan S6e (2b #1): server sudah SUCCESS tanpa nomor keputusan = terposting TANPA nomor kandidat, arahkan ke jejak penyelesaian", () => {
    const h = terapkanPenyelesaian({ index: 0, paket: 1, outcome: "tidak_pasti", message: "x", receiptNumbers: ["PR.MIRIP"] }, 0, { status: "SUCCESS", nomor: [], pesan: "" });
    assert.equal(h?.outcome, "terposting");
    assert.deepEqual(h?.receiptNumbers, []);
    assert.deepEqual(nomorTerposting(h), []);
    assert.match(h?.message ?? "", /lihat jejak penyelesaian/);
    assert.doesNotMatch(h?.message ?? "", /PR\.MIRIP/);
});

test("susulan S6e (2b #3): nomor terposting dari item jawaban Accurate; nomor mirip (Tidak pasti/Ditahan) di kolom Excel terpisah", () => {
    const baris = (c: string) => ({ customerNo: c, paymentMethod: "CASH_OTHER", chequeAmount: 100, detailInvoice: [{ invoiceNo: `INV-${c}` }] });
    const hasil = [
        { index: 0, paket: 1, outcome: "terposting" as const, message: "", item: { s: true, r: { id: 1, number: "PR.1" } } },
        { index: 1, paket: 1, outcome: "tidak_pasti" as const, message: "x", receiptNumbers: ["PR.MIRIP"] },
        { index: 2, paket: 1, outcome: "terposting" as const, code: KODE_DISELESAIKAN, message: "Diselesaikan", receiptNumbers: ["PR.9"] },
        { index: 3, paket: 2, outcome: "ditahan" as const, message: "y", receiptNumbers: ["PR.SAMA"] },
        { index: 4, paket: 2, outcome: "terposting" as const, message: "", item: { s: true } },
    ];
    assert.deepEqual(hasil.map(nomorTerposting), [["PR.1"], [], ["PR.9"], [], []]);
    const ditahan = [{ customerNo: "C9", invoiceNo: "INV-C9", paymentMethod: "CASH_OTHER", row: { chequeAmount: 5 }, reasons: ["ACCURATE_HISTORY"], matchedReceiptNumbers: ["PR.H"] }] as unknown as DuplicateReviewEntry[];
    const r = barisLaporanHasil(["C0", "C1", "C2", "C3", "C4"].map(baris), hasil, ditahan);
    assert.deepEqual(r.map((x) => [x["Nomor Accurate"], x["Nomor mirip"]]), [["PR.1", ""], ["", "PR.MIRIP"], ["PR.9", ""], ["", "PR.SAMA"], ["", ""], ["", "PR.H"]]);
});

test("jejak Hermes: ringkasan per baris berkas (rekening yang diharapkan, status), status sesudah kirim, validasi badan", async () => {
    const { barisUnggah, terapkanHasilUnggah, bersihkanBarisUnggah } = await import("./pelunasan-wizard.ts");
    const rows = bersihkanHeader([
        { "Code Outlet": "C-A1", "No. Nota": "INV/1", "6_Saldo": 1000, Tunai: 400 },
        { "Code Outlet": "C-A2", "No. Nota": "INV/2", "6_Saldo": 500, Trf: 490, "Ket.Trf": "TF BRI (490) 1/11", "Biaya Trf/BG": 10 },
        { "Code Outlet": "C-A3", "No. Nota": "INV/3", "6_Saldo": 300, "Pot.RT Gt": 300, "No.RJS RT Gt": "RJN/2611/X1" },
        { "Code Outlet": "C-A4", "No. Nota": "INV/4", "6_Saldo": 90, Tunai: 90 },
    ]);
    const out = {
        payload: [
            { customerNo: "C-A1-SZ", bankNo: "110102", detailInvoice: [{ invoiceNo: "INV/1", paymentAmount: 400 }] },
            { customerNo: "C-A2-GD", bankNo: "110108", detailInvoice: [{ invoiceNo: "INV/2", paymentAmount: 500 }] },
        ],
        manualRows: [{ "Invoice No": "INV/3" }],
        counts: { skipped: [{ row: 4, reason: "SUDAH_DI_ACCURATE" }] },
    };
    const b = barisUnggah(rows, out, AKUN_AWAL);
    assert.deepEqual(b.map((x) => [x.faktur, x.status, x.rekening.join("+"), x.total, x.pelanggan]), [
        ["INV/1", "diproses", "110102", 400, "C-A1-SZ"],
        ["INV/2", "diproses", "110108", 500, "C-A2-GD"],
        ["INV/3", "retur_manual", "110102+110120", 300, ""],
        ["INV/4", "sudah_di_accurate", "110102", 90, ""],
    ]);
    assert.equal(b[1].potongan, 10);
    const kirim = out.payload;
    const sesudah = terapkanHasilUnggah(b, [
        { index: 0, outcome: "terposting", item: { r: { number: "110102.2026.11.00001" } } },
        { index: 1, outcome: "tidak_pasti" },
    ], kirim, []);
    assert.deepEqual(sesudah.map((x) => [x.status, x.nomor ?? []]), [
        ["terposting", ["110102.2026.11.00001"]], ["tidak_pasti", []], ["retur_manual", []], ["sudah_di_accurate", []],
    ]);
    assert.deepEqual(bersihkanBarisUnggah(JSON.parse(JSON.stringify(sesudah))), sesudah, "bentuk sah lolos utuh");
    assert.equal(bersihkanBarisUnggah([{ ...sesudah[0], status: "hapus" }]), null, "status di luar daftar ditolak");
    assert.equal(bersihkanBarisUnggah({}), null);
});

test("laporan penyesuaian: hanya uang yang masuk rekening di luar berkas; retur, ayat silang, potongan, dan belum diinput tidak masuk", async () => {
    const { bandingkanCaraBayar } = await import("./pelunasan-wizard.ts");
    const b = (faktur: string, cara: Array<{ jenis: "tunai" | "trf" | "bg" | "ppn"; rekening: string; nilai: number }>, retur = 0) => ({
        baris: 1, outlet: "C-X", faktur, pelanggan: "C-X-MS", tunai: 0, trf: 0, bg: 0, potongan: 0, retur, ppn: 0, total: 0, saldo: null,
        rekening: cara.map((c) => c.rekening), cara, status: "sudah_di_accurate" as const,
    });
    const berkas = [{ nama: "24.xlsx", baris: [
        b("INV/MS02884", [{ jenis: "tunai", rekening: "110102", nilai: 500000 }]),      // berkas Tunai, Accurate juga Maybank → masuk
        b("INV/BRI", [{ jenis: "trf", rekening: "110108", nilai: 200000 }]),            // berkas TF BRI, Accurate Maybank → masuk
        b("INV/COCOK", [{ jenis: "tunai", rekening: "110102", nilai: 100000 }]),        // sesuai → tidak
        b("INV/RETUR", [], 50000),                                                      // retur di pelunasan Kas ber-RJN → tidak
        b("INV/BELUM", [{ jenis: "bg", rekening: "110104", nilai: 300000 }]),           // belum ada di Accurate → tidak
    ] }];
    const acc = [
        { faktur: "INV/MS02884", nomor: "110102.2026.11.14000", ip: 500000, adaRetur: false },
        { faktur: "INV/MS02884", nomor: "110105.2026.11.02120", ip: 500000, adaRetur: false },
        { faktur: "INV/BRI", nomor: "110105.2026.11.02200", ip: 200000, adaRetur: false },
        { faktur: "INV/COCOK", nomor: "110102.2026.11.14001", ip: 100000, adaRetur: false },
        { faktur: "INV/RETUR", nomor: "110102.2026.11.14002", ip: 50000, adaRetur: true },
        { faktur: "INV/RETUR", nomor: "110120.2026.11.00010", ip: 50000, adaRetur: false },
    ];
    const r = bandingkanCaraBayar(berkas, acc);
    assert.deepEqual(r.map((x) => x.faktur), ["INV/MS02884", "INV/BRI"]);
    assert.equal(r[1].caraBerkas, "Transfer Rp200.000 → 110108 Bank BRI 0343.0188.8838.566");
    assert.equal(r[1].caraAccurate, "Rp200.000 → 110105 Bank Maybank 2115003838");
    assert.equal(r[0].nomorAccurate, "110102.2026.11.14000, 110105.2026.11.02120");
});
