/*
 * Tujuan: Uji lib/opc-ui.ts — setiap kombinasi status yang ditulis route OPC / dipakai kode lama memetakan ke tahap yang benar,
 *   antrean per tab memakai predikat kode lama, tab per peran, claimView, saringan, dan format.
 * Caller: `npm test` (tsx --test).
 * Dependensi: lib/opc-ui, lib/off-program-control/dev-fixtures.
 * Side Effects: Tidak ada.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    PREDIKAT, SARINGAN_KOSONG, TAMPILAN, alurBatch, infoTahap, izinAksi, pdfBoleh, saringBatch, subTampilan, tabEfektif, tabTerlihat, tahapBatch,
    tanggalOpc, waktuWita, type BatchOpc,
} from "./opc-ui";
import { createOffDevBatches } from "./off-program-control/dev-fixtures";

const b = (over: Partial<BatchOpc> = {}): BatchOpc => ({
    id: "x", noPengajuan: "001/KINO/10/2026", principleName: "KINO INDONESIA. TBK, PT", principleCode: "KINO", bulan: "10", tahun: "2026",
    supervisorName: "Rahmat", status: "Draft", smStatus: "Not Started", claimStatus: "Not Started", omStatus: "Not Started",
    financeStatus: "Not Started", finalStatus: "Not Started", locked: false, ...over,
});
const disetujuiSm = { smStatus: "Approved by SM", locked: true };
const disetujuiKlaim = { ...disetujuiSm, claimStatus: "Approved" };
const disetujuiOm = { ...disetujuiKlaim, omStatus: "Approved" };

// Kombinasi yang ditulis route OPC (submit, sm-approve/return, claim-review, om-decision, finance-payment, final-claim, refund) + status lama.
const KASUS: Array<[string, BatchOpc, string, string]> = [
    ["draf baru", b(), "draf", "Draf"],
    ["dikirim ke SM", b({ status: "Submitted to SM", smStatus: "Waiting Review" }), "sm", "Menunggu SM"],
    ["dikembalikan SM", b({ status: "Returned by SM", smStatus: "Returned" }), "dikembalikan", "Dikembalikan SM"],
    ["disetujui SM", b({ status: "Approved by SM", ...disetujuiSm, omStatus: "Notify OM" }), "klaim", "Menunggu Klaim"],
    // claim-review route (return) menulis locked:false + finalStatus "Not Started" — SPV boleh mengubahnya lagi.
    ["dikembalikan Klaim", b({ status: "Returned by Claim", ...disetujuiSm, claimStatus: "Returned", locked: false }), "dikembalikan", "Dikembalikan Klaim"],
    // BL-06: route claim-review hanya memeriksa "disetujui SM", jadi Klaim bisa mengembalikan batch yang sudah disetujui OM / dibayar;
    // omStatus/financeStatus lama tertinggal. Tahap tetap Dikembalikan (bukan Bayar/Final).
    ["dikembalikan Klaim setelah OM", b({ status: "Returned by Claim", ...disetujuiOm, claimStatus: "Returned", financeStatus: "Waiting Payment", locked: false }), "dikembalikan", "Dikembalikan Klaim"],
    ["dikembalikan Klaim setelah bayar", b({ status: "Returned by Claim", ...disetujuiOm, claimStatus: "Returned", financeStatus: "Paid", locked: false }), "dikembalikan", "Dikembalikan Klaim"],
    ["disetujui Klaim", b({ status: "Claim Approved", ...disetujuiKlaim, omStatus: "Waiting Approval" }), "om", "Menunggu OM"],
    ["status lama Ready for OM", b({ status: "Ready for OM", ...disetujuiKlaim, omStatus: "Waiting Approval" }), "om", "Menunggu OM"],
    ["status lama Waiting OM", b({ status: "Waiting OM", ...disetujuiKlaim, omStatus: "Waiting Approval" }), "om", "Menunggu OM"],
    ["dibatalkan OM", b({ status: "Cancelled by OM", ...disetujuiKlaim, omStatus: "Cancelled" }), "dibatalkan", "Dibatalkan"],
    ["dibatalkan (lama)", b({ status: "Cancelled" }), "dibatalkan", "Dibatalkan"],
    ["disetujui OM", b({ status: "OM Approved", ...disetujuiOm, financeStatus: "Waiting Payment" }), "bayar", "Menunggu bayar"],
    ["bayar sebagian", b({ status: "Partial Paid", ...disetujuiOm, financeStatus: "Partial Paid" }), "bayar", "Dibayar sebagian"],
    ["perlu koreksi bayar", b({ status: "OM Approved", ...disetujuiOm, financeStatus: "Need Correction" }), "bayar", "Perlu koreksi bayar"],
    ["status lama Returned to Finance", b({ status: "Returned to Finance", ...disetujuiOm, financeStatus: "Need Correction" }), "bayar", "Perlu koreksi bayar"],
    ["lunas, menunggu final", b({ status: "Paid", ...disetujuiOm, financeStatus: "Paid", finalStatus: "Waiting Claim Final Verification" }), "final", "Verifikasi final"],
    ["berkas belum lengkap", b({ status: "Paid", ...disetujuiOm, financeStatus: "Paid", finalStatus: "Incomplete Documents" }), "final", "Berkas belum lengkap"],
    ["kelebihan dana", b({ status: "Overpaid - Pending Refund", ...disetujuiOm, financeStatus: "Paid", finalStatus: "Pending Refund", refundStatus: "Pending Refund" }), "final", "Menunggu pengembalian selisih"],
    ["sebagian dikembalikan", b({ status: "Overpaid - Pending Refund", ...disetujuiOm, financeStatus: "Paid", finalStatus: "Partially Refunded" }), "final", "Menunggu pengembalian selisih"],
    ["selesai", b({ status: "Completed", ...disetujuiOm, financeStatus: "Paid", finalStatus: "Completed" }), "selesai", "Selesai"],
    ["selisih lunas dikembalikan", b({ status: "Completed", ...disetujuiOm, financeStatus: "Paid", finalStatus: "Fully Refunded" }), "selesai", "Selesai"],
];

test("setiap kombinasi status memetakan ke tahap dan label yang benar", () => {
    for (const [nama, batch, tahap, label] of KASUS) {
        assert.equal(tahapBatch(batch), tahap, nama);
        assert.equal(infoTahap(batch).label, label, nama);
    }
    // Returned to Finance dengan financeStatus Paid tetapi final belum mulai: kembali ke Bayar, bukan Final.
    assert.equal(tahapBatch(b({ status: "Returned to Finance", ...disetujuiOm, financeStatus: "Paid" })), "bayar");
});

test("fixture dev (tujuh skenario) berurutan Draf → Selesai", () => {
    assert.deepEqual(createOffDevBatches(7).map((x) => tahapBatch(x as BatchOpc)), ["draf", "sm", "klaim", "om", "bayar", "final", "selesai"]);
});

test("tone: Dikembalikan/Dibatalkan negatif, draf netral, lewat SLA kuning, selesai positif; pemilik tahap", () => {
    const tone = (nama: string) => infoTahap(KASUS.find((k) => k[0] === nama)![1]).tone;
    assert.equal(tone("dikembalikan SM"), "neg");
    assert.equal(tone("dibatalkan OM"), "neg");
    assert.equal(tone("draf baru"), "neu");
    assert.equal(tone("selesai"), "pos");
    assert.equal(infoTahap(b({ status: "Submitted to SM", smStatus: "Waiting Review" }), true).tone, "warn");
    assert.equal(infoTahap(b({ status: "Returned by SM", smStatus: "Returned" }), true).tone, "neg"); // lewat SLA tidak menutupi Dikembalikan
    assert.equal(infoTahap(b({ status: "Submitted to SM", smStatus: "Waiting Review" })).pemilik, "Sales Manager");
    assert.equal(infoTahap(b({ createdByRole: "claim" })).pemilik, "Klaim");
    assert.equal(infoTahap(b({ status: "Completed", finalStatus: "Completed" })).pemilik, null);
});

test("Flow 7 tahap: langkah aktif, lewat SLA, dibatalkan berhenti di OM, selesai tuntas", () => {
    assert.deepEqual(alurBatch(b()).map((s) => s.state), ["current", "todo", "todo", "todo", "todo", "todo", "todo"]);
    const sm = b({ status: "Submitted to SM", smStatus: "Waiting Review" });
    assert.deepEqual(alurBatch(sm, true).map((s) => s.state), ["done", "late", "todo", "todo", "todo", "todo", "todo"]);
    assert.deepEqual(alurBatch(b({ status: "Cancelled by OM", omStatus: "Cancelled" })).map((s) => `${s.label}:${s.state}`), ["Draf:done", "SM:done", "Klaim:done", "Dibatalkan:stop"]);
    assert.ok(alurBatch(b({ status: "Completed", finalStatus: "Completed" })).every((s) => s.state === "done"));
});

test("antrean per tab = predikat kode lama", () => {
    const k = Object.fromEntries(KASUS.map(([nama, batch]) => [nama, batch]));
    const masuk = (p: (x: BatchOpc) => boolean) => KASUS.filter(([, batch]) => p(batch)).map(([nama]) => nama);
    assert.deepEqual(masuk(PREDIKAT.spvAntrean), ["draf baru", "dikembalikan SM", "dikembalikan Klaim", "dikembalikan Klaim setelah OM", "dikembalikan Klaim setelah bayar"]);
    // Kasus nyata: Klaim mengembalikan (locked:false) → SPV boleh mengubah, juga bila dikembalikan setelah OM/bayar.
    for (const nama of ["dikembalikan SM", "dikembalikan Klaim", "dikembalikan Klaim setelah OM", "dikembalikan Klaim setelah bayar"]) assert.equal(PREDIKAT.spvBisaUbah(k[nama]), true, nama);
    assert.equal(PREDIKAT.spvBisaUbah({ ...k["dikembalikan Klaim"], locked: true }), false); // data terkunci → baca-saja
    assert.deepEqual(masuk(PREDIKAT.smAntrean), ["dikirim ke SM"]);
    assert.ok(!PREDIKAT.smPantau(k["draf baru"]) && PREDIKAT.smPantau(k["selesai"]));
    assert.deepEqual(masuk(PREDIKAT.klaimAntrean), ["disetujui SM"]);
    assert.ok(PREDIKAT.klaimPantau(k["dikembalikan Klaim"]) && PREDIKAT.klaimPantau(k["disetujui Klaim"]));
    assert.deepEqual(masuk(PREDIKAT.omAntrean), ["disetujui Klaim", "status lama Ready for OM", "status lama Waiting OM"]);
    assert.deepEqual(masuk(PREDIKAT.keuanganAntrean), ["disetujui OM", "bayar sebagian", "perlu koreksi bayar", "status lama Returned to Finance"]);
    assert.ok(PREDIKAT.keuanganPantau(k["lunas, menunggu final"]) && !PREDIKAT.keuanganPantau(k["disetujui Klaim"]));
    assert.deepEqual(masuk(PREDIKAT.finalAntrean), ["lunas, menunggu final", "berkas belum lengkap"]);
    // Hub lama hanya menghitung yang lunas penuh.
    assert.equal(PREDIKAT.finalAntreanHub(k["lunas, menunggu final"]), false);
    assert.equal(PREDIKAT.finalAntreanHub({ ...k["lunas, menunggu final"], paymentSummary: { totalNominal: 1, totalPaid: 1, remainingAmount: 0, isFullyPaid: true } }), true);
    assert.ok(PREDIKAT.finalPantau(k["selesai"]));
    assert.ok(PREDIKAT.clmAntrean(b({ createdByRole: "claim" })) && !PREDIKAT.clmAntrean(b()));
    assert.ok(PREDIKAT.selisihTerbuka(k["kelebihan dana"]));
    // BL-06 (lebih ketat = aman): batch terminal tidak masuk antrean aksi mana pun.
    // Dikembalikan Klaim setelah OM/bayar juga tidak masuk antrean SM/Klaim/OM/Keuangan/Final (sumbu lama yang tertinggal tidak menarik).
    for (const nama of ["dibatalkan OM", "dibatalkan (lama)", "selesai", "selisih lunas dikembalikan", "dikembalikan Klaim setelah OM", "dikembalikan Klaim setelah bayar"]) {
        for (const p of [PREDIKAT.smAntrean, PREDIKAT.klaimAntrean, PREDIKAT.omAntrean, PREDIKAT.keuanganAntrean, PREDIKAT.finalAntrean]) assert.equal(p(k[nama]), false, nama);
    }
    assert.deepEqual(TAMPILAN.claim.map((t) => t.kunci), ["after-sm", "after-finance", "data-claim"]);
});

test("tab per peran (SM hanya Sales Manager), ?tab= tak boleh jatuh ke tab pertama, claimView", () => {
    assert.deepEqual(tabTerlihat("admin"), ["overview", "supervisor", "sales", "claim", "om", "finance", "audit"]);
    assert.deepEqual(tabTerlihat("sales_manager"), ["sales"]);
    assert.deepEqual(tabTerlihat("claim"), ["claim", "audit"]);
    assert.deepEqual(tabTerlihat("sales"), []);
    assert.equal(tabEfektif("admin", null), "overview");
    assert.equal(tabEfektif("admin", "finance"), "finance");
    assert.equal(tabEfektif("claim", "sales"), "claim");
    assert.equal(tabEfektif("unknown", "claim"), undefined);
    assert.equal(subTampilan("claim", "after", null), "after-finance");
    assert.equal(subTampilan("claim", "after-finance", null), "after-finance");
    assert.equal(subTampilan("claim", "data-claim", null), "data-claim");
    assert.equal(subTampilan("claim", null, null), "after-sm");
    assert.equal(subTampilan("overview", null, "semua"), "semua");
});

test("PDF surat (#6): tab/peran Supervisor hanya setelah Klaim menyetujui; tab lain bila ada", () => {
    const pdf = { pdfUrl: "/api/off-program-control/batches/x/pdf" };
    assert.equal(pdfBoleh({ ...pdf, claimStatus: "Not Started" }, "admin", "supervisor"), false); // admin di tab SPV = aturan SPV
    assert.equal(pdfBoleh({ ...pdf, claimStatus: "Not Started" }, "supervisor", "supervisor"), false);
    assert.equal(pdfBoleh({ ...pdf, claimStatus: "Approved" }, "supervisor", "supervisor"), true);
    assert.equal(pdfBoleh({ ...pdf, claimStatus: "Not Started" }, "admin", "overview"), true);
    assert.equal(pdfBoleh({ pdfUrl: null, claimStatus: "Approved" }, "admin", "overview"), false);
});

test("izin aksi = matriks peran OFF kode lama", () => {
    assert.equal(izinAksi("admin", "om_approve"), undefined);
    assert.equal(izinAksi("operational_manager", "om_cancel"), undefined);
    assert.match(izinAksi("claim", "om_approve") ?? "", /Peran OFF/);
    assert.match(izinAksi("supervisor", "finance_payment") ?? "", /Peran OFF/);
});

test("saringan klien: cari, principal, tahap, periode bulan dan rentang", () => {
    const rows = [
        b({ id: "a", noPengajuan: "001/KINO/10/2026", periodDates: { pengajuan: ["2026-10-02"], bayar: [] } }),
        b({ id: "c", noPengajuan: "004/URC/09/2026", principleCode: "URC", principleName: "URC INDONESIA, PT", status: "Submitted to SM", smStatus: "Waiting Review", periodDates: { pengajuan: ["2026-09-20"] } }),
    ];
    const ids = (s: Partial<typeof SARINGAN_KOSONG>) => saringBatch(rows, { ...SARINGAN_KOSONG, ...s }).map((x) => x.id);
    assert.deepEqual(ids({}), ["a", "c"]);
    assert.deepEqual(ids({ cari: "urc" }), ["c"]);
    assert.deepEqual(ids({ principal: "KINO" }), ["a"]);
    assert.deepEqual(ids({ tahap: "sm" }), ["c"]);
    assert.deepEqual(ids({ bulan: "2026-10" }), ["a"]);
    assert.deepEqual(ids({ dari: "2026-09-01", sampai: "2026-09-30" }), ["c"]);
    assert.deepEqual(ids({ jenisTanggal: "bayar", bulan: "2026-10" }), []); // jenis tanggal tanpa data = tidak cocok (sama dengan kode lama)
});

test("format tanggal dd/mm/yyyy dan jam WITA", () => {
    assert.equal(tanggalOpc("2026-10-06"), "06/10/2026");
    assert.equal(tanggalOpc(null), "–");
    assert.equal(waktuWita("2026-10-06T01:40:00Z"), "06/10/2026 09.40");
});
