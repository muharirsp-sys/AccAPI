/* Tinjauan S6-0a (Finance, purchase-payment): keputusan murni layar Finance — tampilan C11, tab yang kalah klaim,
 * dan "pasti belum terkirim" (gagal sebelum klaim). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { certainlyNotSent, postStatusNote, purchasePaymentConflict } from "./finance-post-status.ts";

test("C11 tampilan: 'Accurate menolak' dibedakan dari tanpa jawaban & status lama 'gagal' yang ambigu", () => {
    assert.equal(postStatusNote("unknown", 'Accurate menolak (HTTP 200), belum terbukti tidak tersimpan: ["Vendor tidak ditemukan","Bank kosong"]'),
        "Accurate menolak: Vendor tidak ditemukan; Bank kosong — status TIDAK PASTI (belum terbukti tidak tersimpan); cek purchase-payment di Accurate lalu selesaikan.");
    assert.equal(postStatusNote("unknown", "tanpa jawaban (TimeoutError: The operation was aborted due to timeout)"),
        "TIDAK PASTI — tanpa jawaban pasti dari Accurate (tanpa jawaban (TimeoutError: The operation was aborted due to timeout)); cek purchase-payment sebelum posting ulang.");
    assert.match(postStatusNote("unknown", "Accurate tidak merespons dalam 30 detik (timeout). Coba lagi.", "failed"),
        /^TIDAK PASTI — tercatat "gagal" sebelum pembaruan, tetapi galatnya ambigu \(Accurate tidak merespons/);
    assert.equal(postStatusNote("failed", "dicek manual: tidak ada di Accurate"), "Post gagal: dicek manual: tidak ada di Accurate");
    assert.equal(postStatusNote("posted", ""), "");
});

test("tab yang kalah klaim: attempt 'sending' record sama = sedang diposting sesi lain (tanpa tulis ledger)", () => {
    const live = (state: string, sameRecord = true, sameTarget = true) => ({ state, sameRecord, sameTarget });
    assert.equal(purchasePaymentConflict({ live: live("sending") }), "in_flight");
    assert.equal(purchasePaymentConflict({ live: live("posted"), generation: 0, currentGeneration: 0 }), "posted");
    assert.equal(purchasePaymentConflict({ live: live("posted"), generation: 0, currentGeneration: 1 }), "unknown", "generasi beda");
    assert.equal(purchasePaymentConflict({ live: live("posted", true, false), generation: 0, currentGeneration: 0 }), "unknown", "database lain");
    assert.equal(purchasePaymentConflict({ live: live("unknown") }), "unknown");
    assert.equal(purchasePaymentConflict({ live: live("sending", false) }), "unknown", "record lain dengan faktur sama");
    assert.equal(purchasePaymentConflict({ code: "reopened_use_repost", live: null }), "unknown");
});

test("gagal sebelum klaim = pasti belum terkirim (record tidak dikunci); 5xx tanpa penanda = tidak pasti", () => {
    assert.equal(certainlyNotSent(503, { claimed: false, error: "Gagal mencatat attempt" }), true);
    assert.equal(certainlyNotSent(400, { error: "payload" }), true);
    assert.equal(certainlyNotSent(403, { error: "Forbidden" }), true);
    assert.equal(certainlyNotSent(500, { error: "x" }), false);
    assert.equal(certainlyNotSent(502, null), false);
    assert.equal(certainlyNotSent(409, { live: null }), false);
});
