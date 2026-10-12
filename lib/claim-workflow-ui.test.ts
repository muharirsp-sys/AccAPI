/*
 * Tujuan: Self-check helper layar Claim Workflow: badge (sebagian ≠ lunas ≠ ditutup), alur, umur sejak dikirim, pratinjau pajak
 *         dibulatkan ke rupiah seperti server, syarat tutup, riwayat tanpa kode aksi, pesan galat tanpa "Unexpected end of JSON".
 * Caller: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    alurKlaim, hitungBaris, kalimatAudit, pesanGalat, polaTerbaca, statusKlaim, syaratTutup, tahapKlaim, tanggalWita, umurHari,
} from "@/lib/claim-workflow-ui";

test("badge: Dibayar sebagian kuning, Lunas hijau, Ditutup netral; PEKA lama = Dikirim", () => {
    assert.deepEqual(statusKlaim("Partially Paid"), { label: "Dibayar sebagian", tone: "warn" });
    assert.deepEqual(statusKlaim("Paid"), { label: "Lunas", tone: "pos" });
    assert.deepEqual(statusKlaim("Closed"), { label: "Ditutup", tone: "neu" });
    assert.equal(statusKlaim("EC Received").label, "Dikirim");
    assert.equal(statusKlaim("Ready to Submit").label, "Siap dikirim");
    assert.equal(tahapKlaim("Need Revision"), "draf");
    assert.equal(tahapKlaim("Waiting PEKA"), "dikirim");
});

test("alur: langkah aktif per tahap; Lunas = Dibayar selesai, Ditutup berikutnya", () => {
    const aktif = (s: string) => alurKlaim(s).find((x) => x.state === "current" || x.state === "late")?.label;
    assert.equal(aktif("Draft"), "Draf");
    assert.equal(alurKlaim("Need Revision")[0].state, "late");
    assert.equal(aktif("Submitted to Principal"), "Dikirim");
    assert.equal(aktif("Partially Paid"), "Dibayar");
    assert.equal(aktif("Paid"), "Ditutup");
    assert.ok(alurKlaim("Closed").every((x) => x.state === "done"));
    assert.equal(alurKlaim("Cancelled").at(-1)?.state, "stop");
});

test("umur: hari penuh sejak dikirim (rumus outstanding), tidak negatif, kosong bila belum dikirim", () => {
    const now = Date.parse("2026-10-06T08:00:00Z");
    assert.equal(umurHari("2026-08-20T02:00:00Z", now), 47);
    assert.equal(umurHari("2026-10-07T00:00:00Z", now), 0);
    assert.equal(umurHari(null, now), null);
    assert.equal(umurHari("bukan tanggal", now), null);
});

test("pajak: PPN/PPh dibulatkan ke rupiah seperti server, bukan toFixed(2)", () => {
    const v = hitungBaris({ dpp: "1001", ppnRate: "11", pphRate: "2" });
    assert.equal(v.ppnAmount, 110); // 110,11 → 110
    assert.equal(v.pphAmount, 20); // 20,02 → 20
    assert.equal(v.nilaiKlaim, 1091);
    assert.equal(hitungBaris({ dpp: "", ppnRate: "abc", pphRate: 0 }).nilaiKlaim, 0);
});

test("syarat tutup: delapan butir; berkas lunas lengkap lolos semua", () => {
    const lengkap = { status: "Paid", noClaim: "02/SUPER-KN/08/2026", totalClaim: 100, totalPaid: 100, remainingAmount: 0, claimLetterPdfPath: "a", summaryPdfPath: "b", receiptPdfPath: "c" };
    assert.equal(syaratTutup(lengkap, 1).length, 8);
    assert.ok(syaratTutup(lengkap, 1).every((s) => s.ok));
    const kurang = syaratTutup({ ...lengkap, status: "Partially Paid", totalPaid: 60, remainingAmount: 40, receiptPdfPath: null }, 1).filter((s) => !s.ok).map((s) => s.label);
    assert.deepEqual(kurang, ["Status Lunas", "Sisa tagihan Rp 0", "Dibayar sebesar total klaim (lebih dari 0)", "Kwitansi (PDF) ada"]);
    assert.equal(syaratTutup(lengkap, 0).find((s) => s.label === "Ada pembayaran aktif")?.ok, false);
});

test("riwayat: kalimat, status lama → baru, nominal; kode aksi tidak bocor", () => {
    assert.deepEqual(kalimatAudit({ action: "mark_ready", fromStatus: "Draft", toStatus: "Ready to Submit" }), { apa: "Menandai siap dikirim", ubah: "Draf → Siap dikirim" });
    assert.equal(kalimatAudit({ action: "payment_created", metadata: { paymentAmount: 3100000 }, note: "termin 2" }).ubah, "Rp 3.100.000 · termin 2");
    assert.equal(kalimatAudit({ action: "update_item_tax", metadata: { dpp: 4400000, ppnRate: 11, pphRate: 2 } }).ubah, "DPP Rp 4.400.000 · PPN 11% · PPh 2%");
    assert.doesNotMatch(kalimatAudit({ action: "something_new" }).apa, /_/);
});

test("pola No Claim terbaca; tanggal WITA; galat muat tanpa pesan parser", () => {
    assert.equal(polaTerbaca("{seq}/SUPER-KN/{month}/{year4}"), "{urut}/SUPER-KN/{bulan}/{tahun}");
    assert.equal(tanggalWita("2026-10-05T17:30:00Z"), "06/10/2026"); // 01.30 WITA
    assert.equal(pesanGalat("Gagal memuat Claim Workflow.", "HTTP 502"), "Gagal memuat Claim Workflow. Server menjawab HTTP 502.");
    assert.equal(pesanGalat("Gagal memuat Claim Workflow.", "Unexpected end of JSON input"), "Gagal memuat Claim Workflow.");
    assert.equal(pesanGalat("Gagal memuat Claim Workflow.", "Unauthorized"), "Unauthorized");
    assert.equal(pesanGalat("Gagal memuat Claim Workflow.", undefined), "Gagal memuat Claim Workflow.");
});
