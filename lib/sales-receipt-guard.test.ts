/* AM-024 (owner D-18), re-review d60433f2/748b73aa MEDIUM: guard proxy sales-receipt + hasil per baris dicatat
 * SERVER. Butuh Postgres EVALUASI (AM-040, bukan produksi) lewat AM040_DATABASE_URL dengan tabel idempotency_log
 * (+ lockId/lockedBy) & idempotency_override (scripts/migrate-pg.mjs). Tanpa env itu dilewati dengan sebabnya.
 * Jawaban Accurate di sini = objek JSON SIMULASI, bukan bukti provider. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, inArray, like } from "drizzle-orm";
import { Pool } from "pg";
import { idempotencyLog, idempotencyOverride } from "../db/schema.ts";
import * as guard from "./sales-receipt-guard.ts";
import * as lock from "./idempotency-lock.ts";
import { buildSalesReceiptIdempotencyPayload } from "./sales-receipt-fingerprint.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";
const PATH = "/api/sales-receipt/bulk-save.do";
const ME = "srg-user";
type G = { authorizeSalesReceiptWrite: (...a: unknown[]) => Promise<unknown>; recordSalesReceiptOutcome?: (...a: unknown[]) => Promise<void> };
const g = guard as unknown as G;
type L = { classifySalesReceiptReply?: (n: number, json: unknown) => string[]; completeFromStatuses?: (s: string) => string[] };
const l = lock as unknown as L;

/** Ditolak = teks alasan (kontrak lama & baru sama). */
const isDenied = (r: unknown) => typeof r === "string";

async function withDb(fn: (db: ReturnType<typeof drizzle>, tag: string) => Promise<void>) {
    const pool = new Pool({ connectionString: PG_URL, max: 4 });
    const db = drizzle(pool);
    const tag = `srg-${randomUUID().slice(0, 8)}`;
    try {
        await fn(db, tag);
    } finally {
        await db.delete(idempotencyLog).where(like(idempotencyLog.key, `PAY_${tag}%`));
        await pool.end();
    }
}

const rowOf = (cust: string, inv: string, amt: number) => ({ customerNo: cust, transDate: "01/09/2026", detailInvoice: [{ invoiceNo: inv, paymentAmount: amt }] });
const keyOf = (r: Record<string, unknown>) => buildSalesReceiptIdempotencyPayload(r).key;

/** Setara /api/idempotency/lock untuk key baru: PROCESSING milik (lockId, ME). */
async function lockRows(db: ReturnType<typeof drizzle>, rows: Record<string, unknown>[]) {
    const lockId = randomUUID();
    const now = new Date();
    await db.insert(idempotencyLog).values(rows.map((r) => {
        const p = buildSalesReceiptIdempotencyPayload(r);
        return { key: p.key, status: "PROCESSING", customerNo: p.customerNo, transDate: p.transDate, invoiceNo: p.invoiceNo, amount: p.amount, createdAt: now, updatedAt: now, lockId, lockedBy: ME };
    }));
    return lockId;
}
const statusOf = async (db: ReturnType<typeof drizzle>, k: string) =>
    (await db.select({ s: idempotencyLog.status }).from(idempotencyLog).where(eq(idempotencyLog.key, k)))[0]?.s;
const authorize = (db: ReturnType<typeof drizzle>, lockId: string, payload: unknown) =>
    g.authorizeSalesReceiptWrite(db, { lockId, userId: ME, payload, endpointPath: PATH, method: "POST" });
/** Setara /api/idempotency/complete dengan aturan transisi yang sama. */
async function clientComplete(db: ReturnType<typeof drizzle>, lockId: string, k: string, status: string) {
    await db.update(idempotencyLog).set({ status, updatedAt: new Date() }).where(and(
        eq(idempotencyLog.key, k), eq(idempotencyLog.lockId, lockId), eq(idempotencyLog.lockedBy, ME),
        inArray(idempotencyLog.status, l.completeFromStatuses!(status)),
    ));
}

test("PG: kontrol positif — baris milik lock lolos guard", { skip: pgSkip }, () => withDb(async (db, tag) => {
    const r = rowOf(tag, "INV-1", 1000);
    const L1 = await lockRows(db, [r]);
    assert.ok(!isDenied(await authorize(db, L1, [r])), "baris terkunci milik sendiri harus lolos");
}));

test("PG: skenario A — kirim ulang baris yang sama dengan lock yang sama -> ditolak (tanpa override)", { skip: pgSkip }, () => withDb(async (db, tag) => {
    const r = rowOf(tag, "INV-A", 1000);
    const L1 = await lockRows(db, [r]);
    assert.ok(!isDenied(await authorize(db, L1, [r])));
    // Proses mati / klien tidak melapor: kiriman kedua tetap ditolak.
    assert.ok(isDenied(await authorize(db, L1, [r])), "kirim kedua dengan lock yang sama tidak boleh lolos");
}));

test("PG: skenario B — klien melapor FAILED setelah terkirim sukses tidak membuka kirim ulang", { skip: pgSkip }, () => withDb(async (db, tag) => {
    const r = rowOf(tag, "INV-B", 2000);
    const k = keyOf(r);
    const L1 = await lockRows(db, [r]);
    const d = await authorize(db, L1, [r]);
    assert.ok(!isDenied(d));
    await g.recordSalesReceiptOutcome!(db, d, l.classifySalesReceiptReply!(1, [{ s: true, d: ["ok"] }]));
    assert.equal(await statusOf(db, k), "SUCCESS", "server mencatat SUCCESS dari jawaban Accurate");
    await clientComplete(db, L1, k, "FAILED");
    assert.equal(await statusOf(db, k), "SUCCESS", "klien tidak bisa menurunkan hasil yang dicatat server");
    const ex = (await db.select().from(idempotencyLog).where(eq(idempotencyLog.key, k)))[0];
    const { blocked } = lock.decideLock([{ key: k }], new Map([[k, ex]]), new Date(), new Set(), new Set());
    assert.equal(blocked[0]?.reason, "ALREADY_SUCCESS", "lock ulang tanpa override Finance diblokir");
    assert.ok(isDenied(await authorize(db, L1, [r])));
}));

test("PG: ditolak Accurate -> FAILED oleh server; kirim individual & koreksi self-heal tetap lolos sekali", { skip: pgSkip }, () => withDb(async (db, tag) => {
    const r1 = rowOf(tag, "INV-1", 1000);
    const r2 = rowOf(tag, "INV-2", 500);
    const L1 = await lockRows(db, [r1, r2]);
    const d = await authorize(db, L1, [r1, r2]);
    assert.ok(!isDenied(d));
    // Galat menyeluruh (bukan per baris): tidak ada yang tersimpan -> keduanya FAILED.
    await g.recordSalesReceiptOutcome!(db, d, l.classifySalesReceiptReply!(2, { s: false, d: ["Data tidak valid"] }));
    assert.equal(await statusOf(db, keyOf(r1)), "FAILED");
    // Mode individual atas baris yang DITOLAK server: lolos; diterima -> SUCCESS.
    const d1 = await authorize(db, L1, [r1]);
    assert.ok(!isDenied(d1), "baris FAILED (ditolak Accurate) milik lock boleh dikirim ulang");
    await g.recordSalesReceiptOutcome!(db, d1, l.classifySalesReceiptReply!(1, [{ s: true }]));
    assert.equal(await statusOf(db, keyOf(r1)), "SUCCESS");
    // Self-heal r2: nominal dikoreksi (fingerprint baru, identitas sama) -> lolos, hasilnya dicatat ke key r2.
    const healed = rowOf(tag, "INV-2", 450);
    const d2 = await authorize(db, L1, [healed]);
    assert.ok(!isDenied(d2), "koreksi self-heal beridentitas terkunci lolos");
    await g.recordSalesReceiptOutcome!(db, d2, l.classifySalesReceiptReply!(1, { s: true, d: [{ s: true }] }));
    assert.equal(await statusOf(db, keyOf(r2)), "SUCCESS");
    assert.ok(isDenied(await authorize(db, L1, [healed])), "koreksi yang sudah sukses tidak bisa dikirim lagi");
}));

test("PG: proses mati setelah dispatch -> baris tetap memblokir; klien tak bisa FAILED", { skip: pgSkip }, () => withDb(async (db, tag) => {
    const r = rowOf(tag, "INV-X", 700);
    const k = keyOf(r);
    const L1 = await lockRows(db, [r]);
    assert.ok(!isDenied(await authorize(db, L1, [r])));
    // Tidak ada recordSalesReceiptOutcome (proses mati / timeout tanpa catatan).
    await clientComplete(db, L1, k, "FAILED");
    assert.notEqual(await statusOf(db, k), "FAILED", "baris yang sudah dikirim tidak bisa dilaporkan FAILED oleh klien");
    const ex = (await db.select().from(idempotencyLog).where(eq(idempotencyLog.key, k)))[0];
    const { blocked, toRetry } = lock.decideLock([{ key: k }], new Map([[k, ex]]), new Date(), new Set(), new Set());
    assert.equal(toRetry.length, 0);
    assert.equal(blocked[0]?.reason, "STILL_PROCESSING");
    const later = new Date(Date.now() + lock.STALE_PROCESSING_MS + 60_000);
    assert.equal(lock.decideLock([{ key: k }], new Map([[k, ex]]), later, new Set(), new Set()).blocked[0]?.reason, "UNKNOWN_OUTCOME");
}));

test("PG: timeout / non-JSON -> UNKNOWN, tidak bisa dikirim ulang tanpa override", { skip: pgSkip }, () => withDb(async (db, tag) => {
    const r = rowOf(tag, "INV-T", 900);
    const L1 = await lockRows(db, [r]);
    const d = await authorize(db, L1, [r]);
    await g.recordSalesReceiptOutcome!(db, d, l.classifySalesReceiptReply!(1, undefined));
    assert.equal(await statusOf(db, keyOf(r)), "UNKNOWN");
    assert.ok(isDenied(await authorize(db, L1, [r])));
}));

test("PG: dua kiriman bersamaan dengan lock yang sama -> tepat satu lolos", { skip: pgSkip }, () => withDb(async (db, tag) => {
    const r = rowOf(tag, "INV-C", 1200);
    const L1 = await lockRows(db, [r]);
    const results = await Promise.all([authorize(db, L1, [r]), authorize(db, L1, [r])]);
    assert.equal(results.filter((x) => !isDenied(x)).length, 1, `lolos: ${results.map((x) => (isDenied(x) ? "tolak" : "lolos")).join(",")}`);
}));

test("PG: override resend_success Finance sekali pakai; baris SUCCESS tidak diturunkan oleh hasil kiriman ulang", { skip: pgSkip }, () => withDb(async (db, tag) => {
    const r = rowOf(tag, "INV-O", 3000);
    const k = keyOf(r);
    const L1 = randomUUID();
    const now = new Date();
    await db.insert(idempotencyLog).values({ key: k, status: "SUCCESS", customerNo: tag, transDate: "01/09/2026", invoiceNo: "INV-O", createdAt: now, updatedAt: now });
    await db.insert(idempotencyOverride).values({ id: randomUUID(), lockId: L1, key: k, actor: ME, reason: "uji override sekali pakai", blockReason: "ALREADY_SUCCESS", previousStatus: "SUCCESS", action: "resend_success" });
    try {
        const d = await authorize(db, L1, [r]);
        assert.ok(!isDenied(d), "override tercatat dipakai sekali");
        await g.recordSalesReceiptOutcome!(db, d, l.classifySalesReceiptReply!(1, [{ s: false, d: ["ditolak"] }]));
        assert.equal(await statusOf(db, k), "SUCCESS", "hasil kiriman ulang tidak menurunkan SUCCESS");
        assert.ok(isDenied(await authorize(db, L1, [r])), "override yang sama kedua kali ditolak");
        // dryRun (proxy tanpa sesi Accurate) tidak menghabiskan override.
        await db.insert(idempotencyOverride).values({ id: randomUUID(), lockId: L1, key: k, actor: ME, reason: "uji dry run tidak hangus", blockReason: "ALREADY_SUCCESS", previousStatus: "SUCCESS", action: "resend_success" });
        assert.ok(!isDenied(await g.authorizeSalesReceiptWrite(db, { lockId: L1, userId: ME, payload: [r], endpointPath: PATH, method: "POST" }, { dryRun: true })));
        assert.ok(!isDenied(await authorize(db, L1, [r])), "override masih utuh setelah dryRun");
    } finally {
        await db.delete(idempotencyOverride).where(eq(idempotencyOverride.lockId, L1));
    }
}));
