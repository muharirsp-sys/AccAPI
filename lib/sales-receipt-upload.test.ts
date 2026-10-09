/* Tinjauan S6-0a (api-wrapper): laporan per baris unggah sales-receipt. Status baris dicatat SERVER (proxy); halaman
 * hanya melaporkan — penolakan Accurate = TIDAK PASTI (C11), bukan "berhasil terposting" dan bukan gagal yang boleh
 * dikirim ulang. Prompt alasan override hanya bila override benar-benar dipakai. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isLockRequired, overrideKeysNeeded, salesReceiptRowReports } from "./sales-receipt-upload.ts";

test("jawaban array: s:false per baris dilaporkan 'Accurate menolak … tidak pasti', bukan berhasil", () => {
    const r = salesReceiptRowReports(2, [{ s: true, r: { number: "PR-1" } }, { s: false, d: ["Nilai pelunasan melebihi nilai piutang \"INV-2\""] }]);
    assert.equal(r[0].ok, true);
    assert.deepEqual(r[0].item, { s: true, r: { number: "PR-1" } });
    assert.equal(r[1].ok, false);
    assert.match(r[1].message, /^Accurate menolak: Nilai pelunasan melebihi nilai piutang "INV-2" — status tidak pasti, butuh pemeriksaan\/override Finance$/);
});

test("amplop s:true dengan baris s:false, amplop s:false menyeluruh, tanpa jawaban", () => {
    const env = salesReceiptRowReports(2, { s: true, d: [{ s: true }, { s: false, d: ["ditolak"] }] });
    assert.deepEqual(env.map((x) => x.ok), [true, false]);
    assert.match(env[1].message, /Accurate menolak: ditolak/);
    const all = salesReceiptRowReports(2, { s: false, d: ["Data tidak valid"] });
    assert.deepEqual(all.map((x) => x.ok), [false, false]);
    assert.match(all[0].message, /^Accurate menolak: Data tidak valid — status tidak pasti/);
    const none = salesReceiptRowReports(1, undefined, "timeout 30 detik");
    assert.match(none[0].message, /^Tanpa jawaban Accurate \(timeout 30 detik\) — status tidak pasti, cek Accurate sebelum kirim ulang$/);
    const proxyErr = salesReceiptRowReports(1, { error: "Accurate tidak merespons dalam 30 detik" });
    assert.match(proxyErr[0].message, /^Tanpa jawaban Accurate \(Accurate tidak merespons dalam 30 detik\)/, "galat proxy bukan jawaban Accurate");
});

test("409 SALES_RECEIPT_LOCK_REQUIRED dari proxy dikenali", () => {
    assert.equal(isLockRequired({ rawErrorObject: { error: "x", code: "SALES_RECEIPT_LOCK_REQUIRED" } }), true);
    assert.equal(isLockRequired({ rawErrorObject: { s: false, d: ["x"] } }), false);
    assert.equal(isLockRequired(new Error("x")), false);
});

test("override hanya bila dipakai: baris pertama duplikat-dalam-unggahan (pilihan bawaan) tidak butuh alasan", () => {
    assert.deepEqual(overrideKeysNeeded(["A", "B"], ["A"], []), { allowDuplicateKeys: [], allowLockedKeys: [] });
    assert.deepEqual(overrideKeysNeeded(["A", "B", "A"], ["A"], []), { allowDuplicateKeys: ["A"], allowLockedKeys: [] });
    assert.deepEqual(overrideKeysNeeded(["S"], [], ["S"]), { allowDuplicateKeys: [], allowLockedKeys: ["S"] }, "blok server selalu butuh override");
});
