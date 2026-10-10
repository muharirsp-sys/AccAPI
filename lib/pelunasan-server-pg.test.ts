/* S6e-2a: route ASLI /api/proxy + /api/idempotency/lock dengan Postgres EVALUASI (AM040_DATABASE_URL, bukan produksi) —
 * penahanan riwayat Accurate per paket (owner #6), fail-closed, override per blockReason, sesi belum lengkap = tidak
 * terkirim (C11). Sesi, grup izin, dan sesi Accurate dipalsukan; Accurate = emulator lib/pelunasan/uji (TANPA jaringan).
 * Tanpa env dilewati dengan sebabnya. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { NextRequest } from "next/server";
import { accurateOAuthSession, idempotencyLog, idempotencyOverride, userGroup } from "../db/schema.ts";
import { buildSalesReceiptIdempotencyPayload } from "./sales-receipt-fingerprint.ts";
import { buatEmulator, type DataAccurate } from "./pelunasan/uji/emulator-accurate.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";
if (PG_URL) process.env.DATABASE_URL = PG_URL;

const ME = "u-p";
const PATH = "/api/sales-receipt/bulk-save.do";
type Db = typeof import("./db.ts").db;
type Route = (req: NextRequest) => Promise<Response>;

async function modul() {
    const { db } = await import("./db.ts");
    const { auth } = await import("./auth.ts");
    const proxy = (await import("../app/api/proxy/route.ts")).POST as Route;
    const lock = (await import("../app/api/idempotency/lock/route.ts")).POST as Route;
    const { sesiAccurate } = await import("./pelunasan/uji/sesi-accurate.ts");
    return { db, auth, proxy, lock, sesiAccurate };
}
after(async () => { if (PG_URL) await (await import("./db.ts")).pool.end(); });

type Dunia = { izin: string[]; sesi: Record<string, unknown> | null; data: DataAccurate; balasPost?: (payload: unknown) => unknown; galatBaca?: boolean };
type Catatan = { post: unknown[]; baca: number };

/** DB nyata, kecuali grup izin & sesi Accurate (dipalsukan); fetch = emulator Accurate. */
async function dalamDunia(buatDunia: (tag: string, m: Awaited<ReturnType<typeof modul>>) => Dunia, fn: (m: Awaited<ReturnType<typeof modul>>, tag: string, catat: Catatan) => Promise<void>) {
    const m = await modul();
    const tag = `s6e2-${randomUUID().slice(0, 8)}`;
    const dunia = buatDunia(tag, m);
    const catat: Catatan = { post: [], baca: 0 };
    const emu = buatEmulator(dunia.data);
    const savedSel = Object.getOwnPropertyDescriptor(m.db, "select");
    const savedSes = Object.getOwnPropertyDescriptor(m.auth.api, "getSession");
    const savedFetch = globalThis.fetch;
    const env = process.env.LOCAL_AUTH_BYPASS;
    delete process.env.LOCAL_AUTH_BYPASS;
    const realSelect = m.db.select.bind(m.db);
    Object.defineProperty(m.auth.api, "getSession", { configurable: true, value: async () => ({ user: { id: ME, role: "staff" }, session: { id: "s1" } }) });
    Object.defineProperty(m.db, "select", { configurable: true, value: (...a: unknown[]) => {
        const b = (realSelect as (...x: unknown[]) => { from: (t: unknown) => unknown })(...a);
        const realFrom = b.from.bind(b);
        b.from = (t: unknown) => t === userGroup ? { leftJoin: () => ({ where: async () => dunia.izin.map((key) => ({ groupId: "g", key })) }) }
            : t === accurateOAuthSession ? { where: () => ({ limit: async () => (dunia.sesi ? [dunia.sesi] : []) }) }
                : realFrom(t);
        return b;
    } });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const path = url.pathname.replace("/accurate/api", "/api");
        if ((init?.method ?? "GET") === "GET") {
            catat.baca++;
            if (dunia.galatBaca) throw new Error("jaringan putus");
            return new Response(JSON.stringify(await emu.accurateFetch(path, "GET", Object.fromEntries(url.searchParams))), { status: 200 });
        }
        catat.post.push(JSON.parse(String(init?.body)));
        const balas = dunia.balasPost ? dunia.balasPost(init?.body) : { s: true, d: [{ s: true, r: { id: 1, number: "PR-1" } }] };
        return new Response(JSON.stringify(balas), { status: 200 });
    }) as typeof fetch;
    try {
        await fn(m, tag, catat);
    } finally {
        globalThis.fetch = savedFetch;
        if (savedSel) Object.defineProperty(m.db, "select", savedSel); else delete (m.db as unknown as Record<string, unknown>).select;
        if (savedSes) Object.defineProperty(m.auth.api, "getSession", savedSes);
        if (env !== undefined) process.env.LOCAL_AUTH_BYPASS = env;
        await m.db.delete(idempotencyOverride).where(like(idempotencyOverride.key, `PAY_${tag}%`));
        await m.db.delete(idempotencyLog).where(like(idempotencyLog.key, `PAY_${tag}%`));
    }
}

const post = (url: string, body: unknown) => new NextRequest(`http://app.test${url}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const baris = (cust: string, inv: string, amt: number) => ({ customerNo: cust, transDate: "09/10/2026", detailInvoice: [{ invoiceNo: inv, paymentAmount: amt }] });
const kunci = (r: Record<string, unknown>) => buildSalesReceiptIdempotencyPayload(r);
const riwayat = (cust: string, inv: string, amt: number, number: string) =>
    ({ id: number, number, customer: { customerNo: cust }, customerNo: cust, transDate: "09/10/2026", detailInvoice: [{ invoiceNo: inv, paymentAmount: amt }] });

async function kunciLock(m: Awaited<ReturnType<typeof modul>>, rows: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
    const res = await m.lock(post("/api/idempotency/lock", { keys: rows.map(kunci), ...extra }));
    const body = await res.json() as { lockId?: string; error?: string };
    assert.equal(res.status, 200, body.error);
    assert.ok(body.lockId, JSON.stringify(body));
    return body.lockId!;
}
const kirim = (m: Awaited<ReturnType<typeof modul>>, lockId: string, payload: unknown) =>
    m.proxy(post("/api/proxy", { endpointPath: PATH, method: "POST", payload, idempotencyLockId: lockId, expectedDatabaseId: "DB-1" }));
async function statusDb(db: Db, k: string) {
    const { eq } = await import("drizzle-orm");
    return (await db.select({ s: idempotencyLog.status }).from(idempotencyLog).where(eq(idempotencyLog.key, k)))[0]?.s;
}
async function overrideDb(db: Db, k: string) {
    const { eq } = await import("drizzle-orm");
    return db.select({ blockReason: idempotencyOverride.blockReason, consumedAt: idempotencyOverride.consumedAt }).from(idempotencyOverride).where(eq(idempotencyOverride.key, k));
}
const KIRIM = ["pelunasan.kirim"];
const FINANCE = ["pelunasan.kirim", "finance.override_duplicate"];
const KOSONG = { salesInvoice: [], salesReturn: [] };

test("PG butir 3: baris MIRIP riwayat tanpa override -> 409 ACCURATE_HISTORY per baris; paket tidak dikirim, lock tetap PROCESSING", { skip: pgSkip }, () =>
    dalamDunia((tag, m) => ({ izin: KIRIM, sesi: m.sesiAccurate(), data: { ...KOSONG, salesReceipt: [riwayat(`${tag}-B`, "INV-2", 2000, "PR.9")] } }), async (m, tag, catat) => {
        const a = baris(`${tag}-A`, "INV-1", 1000);
        const b = baris(`${tag}-B`, "INV-2", 2000);
        const lockId = await kunciLock(m, [a, b]);
        const res = await kirim(m, lockId, [a, b]);
        assert.equal(res.status, 409);
        const body = await res.json();
        assert.equal(body.code, "ACCURATE_HISTORY");
        assert.equal(body.sent, false);
        assert.deepEqual(body.rows, [{ index: 1, key: kunci(b).key, reason: "ACCURATE_HISTORY", receiptNumbers: ["PR.9"] }]);
        assert.equal(catat.post.length, 0, "tidak ada POST ke Accurate");
        assert.equal(await statusDb(m.db, kunci(a).key), "PROCESSING");
        assert.equal(await statusDb(m.db, kunci(b).key), "PROCESSING");
    }));

test("PG butir 3: riwayat GAGAL dibaca -> ditahan ACCURATE_HISTORY_UNREADABLE (fail-closed), tidak dikirim", { skip: pgSkip }, () =>
    dalamDunia((_t, m) => ({ izin: KIRIM, sesi: m.sesiAccurate(), data: KOSONG, galatBaca: true }), async (m, tag, catat) => {
        const a = baris(`${tag}-A`, "INV-1", 1000);
        const lockId = await kunciLock(m, [a]);
        const res = await kirim(m, lockId, [a]);
        assert.equal(res.status, 409);
        const body = await res.json();
        assert.equal(body.rows[0].reason, "ACCURATE_HISTORY_UNREADABLE");
        assert.match(body.rows[0].detail, /jaringan putus/);
        assert.equal(catat.post.length, 0);
        assert.equal(await statusDb(m.db, kunci(a).key), "PROCESSING");
    }));

test("PG butir 3: lock tak mencakup baris -> 409 LOCK_REQUIRED SEBELUM membaca riwayat (tanpa panggilan Accurate)", { skip: pgSkip }, () =>
    dalamDunia((_t, m) => ({ izin: KIRIM, sesi: m.sesiAccurate(), data: KOSONG }), async (m, tag, catat) => {
        const a = baris(`${tag}-A`, "INV-1", 1000);
        const lockId = await kunciLock(m, [a]);
        const res = await kirim(m, lockId, [a, baris(`${tag}-X`, "INV-9", 1)]);
        assert.equal(res.status, 409);
        assert.equal((await res.json()).code, "SALES_RECEIPT_LOCK_REQUIRED");
        assert.equal(catat.baca, 0, "tidak ada pembacaan riwayat");
    }));

test("PG butir 3: override Finance allowHistoryKeys (alasan >= 15) dihabiskan sekali; baris dikirim & SUCCESS", { skip: pgSkip }, () =>
    dalamDunia((tag, m) => ({ izin: FINANCE, sesi: m.sesiAccurate(), data: { ...KOSONG, salesReceipt: [riwayat(`${tag}-A`, "INV-1", 1000, "PR.7")] } }), async (m, tag, catat) => {
        const a = baris(`${tag}-A`, "INV-1", 1000);
        const pendek = await m.lock(post("/api/idempotency/lock", { keys: [kunci(a)], allowHistoryKeys: [kunci(a).key], overrideReason: "pendek" }));
        assert.equal(pendek.status, 400, "alasan < 15 ditolak");
        const lockId = await kunciLock(m, [a], { allowHistoryKeys: [kunci(a).key], overrideReason: "Cicilan kedua bernominal sama, sudah dicek" });
        const res = await kirim(m, lockId, [a]);
        assert.equal(res.status, 200);
        assert.equal(catat.post.length, 1);
        assert.equal(await statusDb(m.db, kunci(a).key), "SUCCESS");
        const o = await overrideDb(m.db, kunci(a).key);
        assert.equal(o.length, 1);
        assert.equal(o[0].blockReason, "ACCURATE_HISTORY");
        assert.ok(o[0].consumedAt, "override dihabiskan");
    }));

test("PG butir 3: override ACCURATE_HISTORY hanya untuk penahanan riwayat (penghabisan disaring per blockReason)", { skip: pgSkip }, () =>
    dalamDunia((tag, m) => ({ izin: FINANCE, sesi: m.sesiAccurate(), data: { ...KOSONG, salesReceipt: [riwayat(`${tag}-A`, "INV-1", 1000, "PR.7")] } }), async (m, tag, catat) => {
        const a = baris(`${tag}-A`, "INV-1", 1000);
        // (1) Override riwayat TIDAK menutup salinan kedua dalam paket (blok lock DUPLICATE_IN_UPLOAD).
        const l1 = await kunciLock(m, [a], { allowHistoryKeys: [kunci(a).key], overrideReason: "Cicilan kedua bernominal sama, sudah dicek" });
        const r1 = await kirim(m, l1, [a, a]);
        assert.equal(r1.status, 409);
        assert.equal((await r1.json()).code, "SALES_RECEIPT_LOCK_REQUIRED");
        // (2) Override salinan (DUPLICATE_IN_UPLOAD, belum terpakai) TIDAK menutup penahanan riwayat.
        await m.db.delete(idempotencyOverride).where(like(idempotencyOverride.key, `PAY_${tag}%`));
        await m.db.delete(idempotencyLog).where(like(idempotencyLog.key, `PAY_${tag}%`));
        const l2 = await kunciLock(m, [a, a], { allowDuplicateKeys: [kunci(a).key], overrideReason: "Dua cicilan sah pada hari yang sama" });
        const r2 = await kirim(m, l2, [a]);
        assert.equal(r2.status, 409);
        const b2 = await r2.json();
        assert.equal(b2.code, "ACCURATE_HISTORY");
        assert.deepEqual(b2.rows.map((h: { index: number }) => h.index), [0]);
        assert.equal(catat.post.length, 0);
        const o = await overrideDb(m.db, kunci(a).key);
        assert.ok(o.every((x) => !x.consumedAt), "ditahan = tidak ada override yang dihabiskan");
    }));
