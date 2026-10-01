/* AM-025 (H05): keputusan lock idempotency sales-receipt. Hasil yang mungkin sudah terposting ke
 * Accurate (SUCCESS, PROCESSING aktif/basi, UNKNOWN) TIDAK boleh diambil alih diam-diam. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideLock, isCompleteStatus, rowsNeedingOverride, STALE_PROCESSING_MS } from "./idempotency-lock.ts";
import * as lockModule from "./idempotency-lock.ts";

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

test("D-18: override yang benar-benar dipakai dilaporkan (untuk izin Finance + jejak audit)", () => {
    const basi = row("basi", "PROCESSING", STALE_PROCESSING_MS + 1);
    const d = decide(["s", "basi", "a", "a"], [row("s", "SUCCESS"), basi], ["s", "basi"], ["a"]);
    assert.deepEqual(d.overrides.map((o) => [o.key, o.action, o.blockReason, o.previousStatus]), [
        ["s", "resend_success", "ALREADY_SUCCESS", "SUCCESS"],
        ["basi", "takeover", "UNKNOWN_OUTCOME", "PROCESSING"],
        ["a", "allow_duplicate", "DUPLICATE_IN_UPLOAD", null],
    ]);
    // Tanpa izin override apa pun: tidak ada override tercatat (blok biasa).
    assert.deepEqual(decide(["s"], [row("s", "SUCCESS")]).overrides, []);
});

test("AM-024: baris proxy tercakup lock bila identitas dasar sama (nominal koreksi boleh beda)", () => {
    const fp = (r: Record<string, unknown>) => ({ key: `K:${r.customerNo}:${r.amount}`, customerNo: r.customerNo, transDate: r.transDate, invoiceNo: r.invoiceNo });
    const id = (r: { customerNo?: unknown; transDate?: unknown; invoiceNo?: unknown }) => `${r.customerNo}|${r.transDate}|${r.invoiceNo}`;
    const locked = [{ key: "K:C1:100000", customerNo: "C1", transDate: "01/09/2026", invoiceNo: "INV-1" }];
    const rows = [
        { customerNo: "C1", transDate: "01/09/2026", invoiceNo: "INV-1", amount: 100_000 }, // persis dikunci
        { customerNo: "C1", transDate: "01/09/2026", invoiceNo: "INV-1", amount: 99_900 },  // self-heal: fingerprint baru
        { customerNo: "C2", transDate: "01/09/2026", invoiceNo: "INV-2", amount: 5 },       // tidak terkunci
    ];
    const known = new Set(["K:C1:100000"]);
    assert.deepEqual(rowsNeedingOverride(rows, locked, known, fp, id), ["K:C2:5"]);
    assert.deepEqual(rowsNeedingOverride(rows, [], known, fp, id), ["K:C1:100000", "K:C1:99900", "K:C2:5"], "tanpa lock: semua butuh override");
    // Serangan: key palsu beridentitas sama dikunci, lalu kirim ulang baris yang fingerprint-nya SUDAH tercatat
    // (SUCCESS) -> identitas tidak boleh menutupinya.
    const fake = [{ key: "PALSU", customerNo: "C1", transDate: "01/09/2026", invoiceNo: "INV-1" }];
    assert.deepEqual(rowsNeedingOverride([rows[0]], fake, known, fp, id), ["K:C1:100000"]);
});

test("AM-024: salinan kembar dalam satu payload proxy butuh override per salinan", () => {
    const fp = (r: Record<string, unknown>) => ({ key: String(r.k), customerNo: "C", transDate: "D", invoiceNo: "I" });
    const id = () => "C|D|I";
    const locked = [{ key: "K1", customerNo: "C", transDate: "D", invoiceNo: "I" }];
    assert.deepEqual(rowsNeedingOverride([{ k: "K1" }, { k: "K1" }, { k: "K1" }], locked, new Set(["K1"]), fp, id), ["K1", "K1"]);
});

// Re-review d60433f2 / 748b73aa MEDIUM: hasil per baris dicatat SERVER dari jawaban Accurate yang dilihat proxy.
const L = lockModule as unknown as {
    classifySalesReceiptReply?: (n: number, json: unknown) => string[];
    completeFromStatuses?: (s: string) => string[];
};
test("jawaban sales-receipt -> hasil per baris (SUCCESS/FAILED/UNKNOWN), ragu = UNKNOWN", () => {
    const c = L.classifySalesReceiptReply!;
    assert.deepEqual(c(2, [{ s: true }, { s: false, d: ["x"] }]), ["SUCCESS", "FAILED"], "array per baris");
    assert.deepEqual(c(2, { s: false, d: [{ s: true }, { s: false }] }), ["SUCCESS", "FAILED"], "amplop dengan d per baris");
    assert.deepEqual(c(2, { s: true, d: [{ s: true }, { s: false }] }), ["SUCCESS", "FAILED"], "amplop s:true bisa membawa baris gagal (H09)");
    assert.deepEqual(c(3, { s: false, d: ["Data tidak valid"] }), ["FAILED", "FAILED", "FAILED"], "galat menyeluruh: tak ada yang tersimpan");
    assert.deepEqual(c(1, { s: true, d: ["ok"] }), ["SUCCESS"], "save.do satu objek");
    assert.deepEqual(c(2, { s: false, d: [{ s: true }] }), ["UNKNOWN", "UNKNOWN"], "per baris tapi jumlah beda -> ragu");
    assert.deepEqual(c(2, [{ s: true }]), ["UNKNOWN", "UNKNOWN"], "array jumlah beda -> ragu");
    assert.deepEqual(c(1, [{ x: 1 }]), ["UNKNOWN"], "item tanpa s boolean");
    assert.deepEqual(c(1, undefined), ["UNKNOWN"], "timeout / non-JSON");
    assert.deepEqual(c(1, null), ["UNKNOWN"]);
    assert.deepEqual(c(1, { error: "x" }), ["UNKNOWN"], "tanpa amplop Accurate");
});
test("complete dari klien: FAILED hanya dari PROCESSING (belum dikirim); SENDING tidak bisa diturunkan", () => {
    const f = L.completeFromStatuses!;
    assert.deepEqual(f("FAILED"), ["PROCESSING"]);
    assert.ok(f("SUCCESS").includes("SENDING") && f("UNKNOWN").includes("SENDING"), "menaikkan SENDING boleh (mempersempit)");
    assert.ok(!f("UNKNOWN").includes("SUCCESS") && !f("FAILED").includes("SUCCESS"));
});
test("SENDING (sudah dikirim, hasil belum dicatat) diblokir: segar = STILL_PROCESSING, basi = UNKNOWN_OUTCOME", () => {
    const now = new Date();
    const row = { key: "S", status: "SENDING", updatedAt: now };
    assert.equal(decideLock([{ key: "S" }], new Map([["S", row]]), now, new Set(), new Set()).blocked[0]?.reason, "STILL_PROCESSING");
    const later = new Date(now.getTime() + STALE_PROCESSING_MS + 1);
    assert.equal(decideLock([{ key: "S" }], new Map([["S", row]]), later, new Set(), new Set()).blocked[0]?.reason, "UNKNOWN_OUTCOME");
});
