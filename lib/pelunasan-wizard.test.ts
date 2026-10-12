/*
 * Tujuan: Mengunci aturan wizard Pelunasan (S6e-2b): akun wajib menurut isi berkas, penanda ISI_KODE_AKUN_ ditolak, baris ganda ditahan
 *   kecuali diizinkan Finance, kunci override lock = yang dipakai server (ganda berkas / dikunci / riwayat Accurate), dan hasil Selesaikan
 *   (SUCCESS = terposting bernomor, FAILED = Gagal boleh diulang) menggantikan Tidak pasti.
 * Caller: npm test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
    AKUN_KOSONG, KODE_DISELESAIKAN, barisLaporanHasil, bersihkanHeader, hitungHasil, isiBerkas, nomorTerposting, paketDari, periksaAkun, rencanaKirim, terapkanPenyelesaian,
} from "./pelunasan-wizard.ts";
import { buildSalesReceiptIdempotencyPayload } from "./sales-receipt-fingerprint.ts";
import type { DuplicateReviewEntry } from "./pelunasan/pratinjau-ganda.ts";

test("isi berkas: BG, transfer tanpa bank tetap, dan potongan dihitung per baris", () => {
    const rows = bersihkanHeader([
        { "Code Outlet (*wajib)": "PELANGGAN-A", "No. Nota": "INV-1", Trf: 1000, "Ket. Trf": "BCA" },
        { "Code Outlet": "PELANGGAN-B", "No. Nota": "INV-2", Trf: 500, "Ket. Trf": "maybank cabang a" },
        { "Code Outlet": "PELANGGAN-C", "No. Nota": "INV-3", BG: 700, "Pot.2 Kwtnsi": 10 },
        { "Code Outlet": "", "No. Nota": "" },
    ]);
    assert.deepEqual(isiBerkas(rows), { baris: 3, bg: 1, trfTanpaBank: 1, pot: [0, 1, 0] });
});

test("akun: BG & potongan wajib bila berkas memuatnya; penanda ISI_KODE_AKUN_ tidak lolos", () => {
    const isi = { baris: 3, bg: 4, trfTanpaBank: 0, pot: [2, 0, 0] as [number, number, number] };
    assert.deepEqual(Object.keys(periksaAkun(AKUN_KOSONG, isi)).sort(), ["bg", "pot1"]);
    assert.match(periksaAkun(AKUN_KOSONG, isi).bg ?? "", /Wajib: 4 baris berisi BG/);
    assert.deepEqual(periksaAkun({ ...AKUN_KOSONG, bg: "110104", pot1: "4102" }, isi), {});
    assert.ok(periksaAkun({ ...AKUN_KOSONG, bg: "110104", pot1: "isi_kode_akun_pot1_di_ui" }, isi).pot1, "penanda (huruf apa pun) ditolak");
    assert.ok(periksaAkun({ ...AKUN_KOSONG, tunai: "ISI_KODE_AKUN_X" }, { ...isi, bg: 0, pot: [0, 0, 0] }).tunai, "isian opsional pun diperiksa");
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
