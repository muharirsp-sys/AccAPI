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

test("S7-1b: penolakan proxy SEBELUM diteruskan (4xx + sent:false) = rejected; sent:false pada 2xx/5xx atau tanpa status tetap tidak pasti", () => {
    const izin = { error: "Tulis ke Accurate lewat Konsol butuh izin Konsol · Eksekusi (api_wrapper.execute). Tidak ada yang dikirim.", code: "PERMISSION_REQUIRED", permission: "api_wrapper.execute", sent: false };
    assert.deepEqual(classifyWriteError(new AccurateError(izin.error, undefined, izin, 403)), { kind: "rejected", message: izin.error });
    assert.equal(classifyWriteError(new AccurateError("x", undefined, { error: "x", code: "ENDPOINT_TIDAK_DIIZINKAN", sent: false }, 403)).kind, "rejected");
    assert.equal(classifyWriteError(new AccurateError("x", undefined, { error: "x", code: "ACCURATE_SESSION_INCOMPLETE", sent: false }, 400)).kind, "rejected");
    // Jawaban Accurate diteruskan proxy = HTTP 200 apa pun isinya; 5xx = galat proxy. Keduanya tidak boleh menjadi "tidak terkirim".
    assert.equal(classifyWriteError(new AccurateError("x", undefined, { s: true, sent: false }, 200)).kind, "unknown");
    assert.equal(classifyWriteError(new AccurateError("x", undefined, { error: "x", sent: false }, 502)).kind, "unknown");
    assert.equal(classifyWriteError(new AccurateError("x", undefined, { error: "x", sent: false })).kind, "unknown");
    // 403 lama tanpa sent (requirePermission polos) tetap tidak pasti — tidak ada klasifikasi baru untuk jawaban tanpa sent:false.
    assert.equal(classifyWriteError(new AccurateError("Forbidden", undefined, { error: "Forbidden" }, 403)).kind, "unknown");
    assert.equal(classifyWriteError(new AccurateError("x", undefined, { error: "x", sent: true }, 403)).kind, "unknown");
});
