/* AM-025 (H05): keputusan lock idempotency sales-receipt. Hasil yang mungkin sudah terposting ke
 * Accurate (SUCCESS, PROCESSING aktif/basi, UNKNOWN) TIDAK boleh diambil alih diam-diam. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideLock, isCompleteStatus, STALE_PROCESSING_MS } from "./idempotency-lock.ts";

const now = new Date("2026-09-30T10:00:00Z");
const row = (key: string, status: string, ageMs = 0) => ({ key, status, updatedAt: new Date(now.getTime() - ageMs), createdAt: null });
const decide = (keys: string[], rows: ReturnType<typeof row>[], allowLocked: string[] = [], allowDuplicate: string[] = []) =>
    decideLock(keys.map((key) => ({ key })), new Map(rows.map((r) => [r.key, r])), now, new Set(allowDuplicate), new Set(allowLocked));
const reasons = (d: ReturnType<typeof decide>) => Object.fromEntries(d.blocked.map((b) => [b.key, b.reason]));

test("key baru dikunci; FAILED boleh dicoba ulang", () => {
    const d = decide(["baru", "gagal"], [row("gagal", "FAILED")]);
    assert.deepEqual(d.toInsert.map((e) => e.key), ["baru"]);
    assert.deepEqual(d.toRetry, ["gagal"]);
    assert.equal(d.blocked.length, 0);
});

test("PROCESSING basi (>15 menit) diblokir UNKNOWN_OUTCOME, BUKAN diambil alih", () => {
    // Dulu: diambil alih diam-diam -> percobaan pertama yang sebenarnya sudah terposting dikirim ulang.
    const d = decide(["basi"], [row("basi", "PROCESSING", STALE_PROCESSING_MS + 1)]);
    assert.deepEqual(reasons(d), { basi: "UNKNOWN_OUTCOME" });
    assert.deepEqual(d.toRetry, []);
});

test("SUCCESS, PROCESSING aktif, UNKNOWN, status asing: diblokir", () => {
    const d = decide(["s", "p", "u", "x"], [row("s", "SUCCESS"), row("p", "PROCESSING", 1000), row("u", "UNKNOWN"), row("x", "failed ")]);
    assert.deepEqual(reasons(d), { s: "ALREADY_SUCCESS", p: "STILL_PROCESSING", u: "UNKNOWN_OUTCOME", x: "UNKNOWN_OUTCOME" });
    assert.deepEqual(d.toRetry, []);
});

test("konfirmasi manusia (allowLockedKeys): SUCCESS tak ditulis; lainnya diambil alih dengan CAS status+updatedAt", () => {
    const basi = row("basi", "PROCESSING", STALE_PROCESSING_MS + 1);
    const d = decide(["s", "basi", "u"], [row("s", "SUCCESS"), basi, row("u", "UNKNOWN")], ["s", "basi", "u"]);
    assert.equal(d.blocked.length, 0);
    assert.deepEqual(d.toRetry, []);
    assert.deepEqual(d.toInsert, []);
    // Dulu (review F1): override dibiarkan PROCESSING selamanya -> hasil kirimnya tak pernah tercatat.
    assert.deepEqual(d.toTakeover, [
        { key: "basi", status: "PROCESSING", updatedAt: basi.updatedAt },
        { key: "u", status: "UNKNOWN", updatedAt: row("u", "UNKNOWN").updatedAt },
    ]);
});

test("duplikat dalam satu upload diblokir kecuali diizinkan", () => {
    assert.deepEqual(reasons(decide(["a", "a"], [])), { a: "DUPLICATE_IN_UPLOAD" });
    assert.equal(decide(["a", "a"], [], [], ["a"]).blocked.length, 0);
});

test("complete hanya menerima status akhir yang dikenal", () => {
    for (const s of ["SUCCESS", "FAILED", "UNKNOWN"]) assert.ok(isCompleteStatus(s), s);
    for (const s of ["PROCESSING", "success", "", null, 1]) assert.ok(!isCompleteStatus(s), String(s));
});
