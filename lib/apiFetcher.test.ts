/* AM-014: hasil tulis Accurate lewat proxy — hanya penolakan beramplop yang "gagal" (boleh diulang). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AccurateError, classifyBulkSaveResponse, classifyWriteError } from "./apiFetcher.ts";

test("bulk-save: sukses per item + id = posted; item ditolak = rejected; sisanya tidak pasti", () => {
    const ok = { s: true, d: [{ s: true, d: "Berhasil", r: { id: 881, number: "PP/2609/001" } }] };
    assert.deepEqual(classifyBulkSaveResponse(ok), { kind: "posted", id: "881", number: "PP/2609/001" });
    // Amplop atas s:true tetapi itemnya ditolak — dulu tercatat "posted".
    assert.equal(classifyBulkSaveResponse({ s: true, d: [{ s: false, d: ["Vendor tidak ditemukan"] }] }).kind, "rejected");
    assert.equal(classifyBulkSaveResponse([{ s: false, d: ["x"] }]).kind, "rejected");
    // Sukses tanpa id: tidak bisa dibuktikan/diverifikasi -> tidak pasti, bukan posted.
    assert.equal(classifyBulkSaveResponse({ s: true, d: [{ s: true, d: "Berhasil" }] }).kind, "unknown");
    // Sebagian item masuk, sebagian ditolak: sebagian SUDAH ada di Accurate -> bukan "rejected".
    assert.equal(classifyBulkSaveResponse({ s: true, d: [{ s: true, r: { id: 1 } }, { s: false, d: ["x"] }] }).kind, "unknown");
    assert.equal(classifyBulkSaveResponse(null).kind, "unknown");
    assert.equal(classifyBulkSaveResponse({ message: "Bad Gateway" }).kind, "unknown");
});

test("error tulis: hanya amplop penolakan Accurate yang rejected; timeout/gateway/jaringan tidak pasti", () => {
    const rejected = new AccurateError("Vendor tidak ditemukan", [{ s: false, d: ["Vendor tidak ditemukan"] }], { s: false, d: ["Vendor tidak ditemukan"] });
    assert.equal(classifyWriteError(rejected).kind, "rejected");
    // Bentuk yang dilempar accurateFetch untuk respons proxy 504/502/500 (bukan amplop Accurate).
    assert.equal(classifyWriteError(new AccurateError("timeout", undefined, { error: "Accurate tidak merespons dalam 30 detik (timeout). Coba lagi." })).kind, "unknown");
    assert.equal(classifyWriteError(new AccurateError("non-JSON", undefined, { error: "non-JSON", detail: "<html>" })).kind, "unknown");
    assert.equal(classifyWriteError(new Error("Terjadi kesalahan jaringan.")).kind, "unknown");
    assert.equal(classifyWriteError(new TypeError("Cannot read properties of null (reading 's')")).kind, "unknown");
});
