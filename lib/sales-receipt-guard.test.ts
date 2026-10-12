/* AM-024 (owner D-18), re-review d60433f2/748b73aa MEDIUM: guard proxy sales-receipt + hasil per baris dicatat
 * SERVER. Butuh Postgres EVALUASI (AM-040, bukan produksi) lewat AM040_DATABASE_URL dengan tabel idempotency_log
 * (+ lockId/lockedBy) & idempotency_override (scripts/migrate-pg.mjs). Tanpa env itu dilewati dengan sebabnya.
 * Jawaban Accurate di sini = objek JSON SIMULASI, bukan bukti provider. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, like } from "drizzle-orm";
import { Pool } from "pg";
import { idempotencyLog, idempotencyOverride } from "../db/schema.ts";
import * as guard from "./sales-receipt-guard.ts";
import * as lock from "./idempotency-lock.ts";
import { buildSalesReceiptIdempotencyPayload } from "./sales-receipt-fingerprint.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";
// Route asli (/api/idempotency/complete) memakai @/lib/db -> arahkan ke DB evaluasi SEBELUM import dinamis.
if (PG_URL) process.env.DATABASE_URL = PG_URL;
const PATH = "/api/sales-receipt/bulk-save.do";
const ME = "srg-user";
type Reply = { status: number; text: string };
type G = {
    authorizeSalesReceiptWrite: (...a: unknown[]) => Promise<unknown>;
    recordSalesReceiptOutcome?: (...a: unknown[]) => Promise<void>;
    sendSalesReceipt?: (db: unknown, dispatch: unknown, forward: () => Promise<Reply>) => Promise<{ json: boolean; data?: unknown; status: number }>;
};
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
// Pool @/lib/db milik route asli ditutup agar proses uji tidak menggantung (re-review c8e5663c nit).
after(async () => { if (PG_URL) await (await import("./db.ts")).pool.end(); });

/** Route /api/idempotency/complete ASLI (re-review 597a4b82 MEDIUM): sesi dipalsukan sebagai ME, DB nyata.
 * Mengembalikan body {ok, updated} — kasus negatif memeriksa updated === 0 (tidak lolos secara kosong). */
async function clientComplete(_db: ReturnType<typeof drizzle>, lockId: string, k: string, status: string) {
    const { POST } = await import("../app/api/idempotency/complete/route.ts");
    const { auth } = await import("./auth.ts");
    const saved = Object.getOwnPropertyDescriptor(auth.api, "getSession");
    const bypass = process.env.LOCAL_AUTH_BYPASS;
    delete process.env.LOCAL_AUTH_BYPASS;
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => ({ user: { id: ME, role: "staff" }, session: { id: "s" } }) });
    try {
        const res = await POST(new Request("http://app.test/api/idempotency/complete", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keys: [k], lockId, status }),
        }));
        assert.equal(res.status, 200, `complete route ${res.status}`);
        return (await res.json()) as { ok: boolean; updated: number };
    } finally {
        if (saved) Object.defineProperty(auth.api, "getSession", saved);
        if (bypass !== undefined) process.env.LOCAL_AUTH_BYPASS = bypass;
    }
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
    assert.equal((await clientComplete(db, L1, k, "FAILED")).updated, 0);
    assert.equal(await statusOf(db, k), "SUCCESS", "klien tidak bisa menurunkan hasil yang dicatat server");
    const ex = (await db.select().from(idempotencyLog).where(eq(idempotencyLog.key, k)))[0];
    const { blocked } = lock.decideLock([{ key: k }], new Map([[k, ex]]), new Date(), new Set(), new Set());
    assert.equal(blocked[0]?.reason, "ALREADY_SUCCESS", "lock ulang tanpa override Finance diblokir");
    assert.ok(isDenied(await authorize(db, L1, [r])));
}));

test("PG: C11 — penolakan Accurate belum terbukti -> UNKNOWN; kirim individual & koreksi self-heal butuh override Finance", { skip: pgSkip }, () => withDb(async (db, tag) => {
    const r1 = rowOf(tag, "INV-1", 1000);
    const r2 = rowOf(tag, "INV-2", 500);
    const r3 = rowOf(tag, "INV-3", 700);
    const L1 = await lockRows(db, [r1, r2, r3]);
    const d = await authorize(db, L1, [r1, r2]);
    assert.ok(!isDenied(d));
    // Amplop s:false tanpa hasil per baris: tidak terbukti tak ada yang tersimpan -> keduanya UNKNOWN.
    await g.recordSalesReceiptOutcome!(db, d, l.classifySalesReceiptReply!(2, { s: false, d: ["Data tidak valid"] }));
    assert.equal(await statusOf(db, keyOf(r1)), "UNKNOWN");
    assert.equal(await statusOf(db, keyOf(r2)), "UNKNOWN");
    // Mode individual (halaman lama mengurai per baris setelah galat menyeluruh) TIDAK lolos tanpa override.
    assert.ok(isDenied(await authorize(db, L1, [r1])), "baris UNKNOWN tidak boleh dikirim ulang otomatis");
    // Koreksi self-heal (nominal beda, identitas sama) juga tidak lolos.
    assert.ok(isDenied(await authorize(db, L1, [rowOf(tag, "INV-2", 450)])), "self-heal atas baris UNKNOWN butuh override");
    // Penolakan PER BARIS (mis. "melebihi nilai piutang") juga belum terbukti -> UNKNOWN, self-heal ikut tertahan.
    const d3 = await authorize(db, L1, [r3]);
    assert.ok(!isDenied(d3));
    await g.recordSalesReceiptOutcome!(db, d3, l.classifySalesReceiptReply!(1, { s: true, d: [{ s: false, d: ["melebihi nilai piutang"] }] }));
    assert.equal(await statusOf(db, keyOf(r3)), "UNKNOWN");
    assert.ok(isDenied(await authorize(db, L1, [rowOf(tag, "INV-3", 650)])), "self-heal setelah penolakan per baris butuh override");
}));

test("PG: proses mati setelah dispatch -> baris tetap memblokir; klien tak bisa FAILED", { skip: pgSkip }, () => withDb(async (db, tag) => {
    const r = rowOf(tag, "INV-X", 700);
    const k = keyOf(r);
    const L1 = await lockRows(db, [r]);
    assert.ok(!isDenied(await authorize(db, L1, [r])));
    // Tidak ada recordSalesReceiptOutcome (proses mati / timeout tanpa catatan).
    assert.equal((await clientComplete(db, L1, k, "FAILED")).updated, 0);
    assert.notEqual(await statusOf(db, k), "FAILED", "baris yang sudah dikirim tidak bisa dilaporkan FAILED oleh klien");
    const ex = (await db.select().from(idempotencyLog).where(eq(idempotencyLog.key, k)))[0];
    const { blocked, toRetry } = lock.decideLock([{ key: k }], new Map([[k, ex]]), new Date(), new Set(), new Set());
    assert.equal(toRetry.length, 0);
    assert.equal(blocked[0]?.reason, "STILL_PROCESSING");
    const later = new Date(Date.now() + lock.STALE_PROCESSING_MS + 60_000);
    assert.equal(lock.decideLock([{ key: k }], new Map([[k, ex]]), later, new Set(), new Set()).blocked[0]?.reason, "UNKNOWN_OUTCOME");
    // Menaikkan SENDING -> UNKNOWN lewat route asli boleh (mempersempit kiriman ulang).
    assert.equal((await clientComplete(db, L1, k, "UNKNOWN")).updated, 1);
    assert.equal(await statusOf(db, k), "UNKNOWN");
}));

test("PG: kontrol positif route /complete asli — baris belum dikirim boleh FAILED oleh pemilik lock", { skip: pgSkip }, () => withDb(async (db, tag) => {
    const r = rowOf(tag, "INV-P", 300);
    const k = keyOf(r);
    const L1 = await lockRows(db, [r]);
    assert.equal((await clientComplete(db, randomUUID(), k, "FAILED")).updated, 0, "lock lain tidak bisa menutup");
    assert.equal((await clientComplete(db, L1, k, "FAILED")).updated, 1, "pemilik lock menutup baris PROCESSING");
    assert.equal(await statusOf(db, k), "FAILED");
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

test("PG: kirim + catat (glue proxy) — 5xx/4xx beramplop / non-JSON / timeout = UNKNOWN (C11); per baris", { skip: pgSkip }, () => withDb(async (db, tag) => {
    const send = g.sendSalesReceipt!;
    const run = async (inv: string, forward: () => Promise<Reply>) => {
        const r = rowOf(tag, inv, 100);
        const L1 = await lockRows(db, [r]);
        const d = await authorize(db, L1, [r]);
        assert.ok(!isDenied(d));
        const out = await send(db, d, forward).catch((e: unknown) => ({ thrown: e }));
        return { out, status: await statusOf(db, keyOf(r)) };
    };
    const env = (status: number, body: unknown) => async () => ({ status, text: JSON.stringify(body) });
    assert.equal((await run("G-500", env(500, { s: false, d: ["gateway"] }))).status, "UNKNOWN", "5xx beramplop = tidak pasti");
    assert.equal((await run("G-302", env(302, { s: false, d: ["x"] }))).status, "UNKNOWN");
    assert.equal((await run("G-422", env(422, { s: false, d: ["Data tidak valid"] }))).status, "UNKNOWN", "4xx beramplop: penolakan belum terbukti (C11)");
    const nonJson = await run("G-HTML", async () => ({ status: 200, text: "<html>" }));
    assert.equal(nonJson.status, "UNKNOWN");
    assert.equal((nonJson.out as { json?: boolean }).json, false, "proxy menjawab 502 untuk non-JSON");
    const timeout = await run("G-TO", async () => { throw new DOMException("t", "TimeoutError"); });
    assert.equal(timeout.status, "UNKNOWN");
    assert.ok("thrown" in (timeout.out as object), "galat kirim dilempar ulang ke proxy (504)");
    assert.equal((await run("G-OK", env(200, [{ s: true, d: ["ok"] }]))).status, "SUCCESS");
}));
