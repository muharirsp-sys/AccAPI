/* Tinjauan S6-0a (api-wrapper): laporan per baris unggah sales-receipt. Status baris dicatat SERVER (proxy); halaman
 * hanya melaporkan — penolakan Accurate = TIDAK PASTI (C11), bukan "berhasil terposting" dan bukan gagal yang boleh
 * dikirim ulang. Prompt alasan override hanya bila override benar-benar dipakai. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { overrideKeysNeeded, salesReceiptRowReports } from "./sales-receipt-upload.ts";

test("jawaban array: s:false per baris dilaporkan 'Jawaban Accurate … tidak pasti' (C11: bukan ditolak), bukan berhasil", () => {
    const r = salesReceiptRowReports(2, [{ s: true, r: { number: "PR-1" } }, { s: false, d: ["Nilai pelunasan melebihi nilai piutang \"INV-2\""] }]);
    assert.equal(r[0].ok, true);
    assert.deepEqual(r[0].item, { s: true, r: { number: "PR-1" } });
    assert.equal(r[1].ok, false);
    assert.match(r[1].message, /^Jawaban Accurate: Nilai pelunasan melebihi nilai piutang "INV-2"\. Belum terbukti tersimpan atau tidak: status tidak pasti, butuh pemeriksaan Finance$/);
    assert.doesNotMatch(r[1].message, /menolak|ditolak/i, "C11: tidak ada 'Ditolak' dari jawaban Accurate");
});

test("amplop s:true dengan baris s:false, amplop s:false menyeluruh, tanpa jawaban", () => {
    const env = salesReceiptRowReports(2, { s: true, d: [{ s: true }, { s: false, d: ["ditolak"] }] });
    assert.deepEqual(env.map((x) => x.ok), [true, false]);
    assert.match(env[1].message, /^Jawaban Accurate: ditolak\. Belum terbukti/);
    const all = salesReceiptRowReports(2, { s: false, d: ["Data tidak valid"] });
    assert.deepEqual(all.map((x) => x.ok), [false, false]);
    assert.match(all[0].message, /^Jawaban Accurate: Data tidak valid\. Belum terbukti tersimpan atau tidak: status tidak pasti/);
    const none = salesReceiptRowReports(1, undefined, "timeout 30 detik");
    assert.match(none[0].message, /^Tanpa jawaban Accurate \(timeout 30 detik\)\. Status tidak pasti, cek Accurate sebelum kirim ulang$/);
    const proxyErr = salesReceiptRowReports(1, { error: "Accurate tidak merespons dalam 30 detik" });
    assert.match(proxyErr[0].message, /^Tanpa jawaban Accurate \(Accurate tidak merespons dalam 30 detik\)/, "galat proxy bukan jawaban Accurate");
});

test("override hanya bila dipakai: baris pertama duplikat-dalam-unggahan (pilihan bawaan) tidak butuh alasan", () => {
    assert.deepEqual(overrideKeysNeeded(["A", "B"], ["A"], []), { allowDuplicateKeys: [], allowLockedKeys: [], allowHistoryKeys: [] });
    assert.deepEqual(overrideKeysNeeded(["A", "B", "A"], ["A"], []), { allowDuplicateKeys: ["A"], allowLockedKeys: [], allowHistoryKeys: [] });
    assert.deepEqual(overrideKeysNeeded(["S"], [], ["S"]), { allowDuplicateKeys: [], allowLockedKeys: ["S"], allowHistoryKeys: [] }, "blok server selalu butuh override");
    // S6e-2: baris mirip riwayat yang dipilih -> satu override riwayat per baris final (dua salinan = dua).
    assert.deepEqual(overrideKeysNeeded(["H", "B", "H"], ["H"], [], ["H"]).allowHistoryKeys, ["H", "H"]);
});

