/* S6e-2a: route ASLI /api/proxy + /api/idempotency/lock dengan Postgres EVALUASI (AM040_DATABASE_URL, bukan produksi) —
 * penahanan riwayat Accurate per paket (owner #6), fail-closed, override per blockReason, sesi belum lengkap = tidak
 * terkirim (C11). Sesi, grup izin, dan sesi Accurate dipalsukan; Accurate = emulator lib/pelunasan/uji (TANPA jaringan).
 * Tanpa env dilewati dengan sebabnya. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { NextRequest } from "next/server";
import { accurateOAuthSession, idempotencyLog, idempotencyOverride, idempotencyResolution, userGroup } from "../db/schema.ts";
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
    const resolve = (await import("../app/api/idempotency/resolve/route.ts")).POST as Route;
    return { db, auth, proxy, lock, resolve, sesiAccurate };
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
    Object.defineProperty(m.auth.api, "getSession", { configurable: true, value: async () => ({ user: { id: ME, email: "finance@contoh.test", role: "staff" }, session: { id: "s1" } }) });
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
    ({ id: number, number, customer: { customerNo: cust }, transDate: "09/10/2026", detailInvoice: [{ invoice: { number: inv }, paymentAmount: amt, detailDiscount: [] }] });

async function kunciLock(m: Awaited<ReturnType<typeof modul>>, rows: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
    const res = await m.lock(post("/api/idempotency/lock", { keys: rows.map(kunci), expectedDatabaseId: "DB-1", ...extra }));
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

test("PG A1: identik kasar walau pelunasan Accurate tanpa nomor -> tetap DITAHAN (receiptNumbers kosong), tidak dikirim", { skip: pgSkip }, () =>
    dalamDunia((tag, m) => ({ izin: KIRIM, sesi: m.sesiAccurate(), data: { ...KOSONG, salesReceipt: [{ ...riwayat(`${tag}-A`, "INV-1", 1000, ""), id: "X1" }] } }), async (m, tag, catat) => {
        const a = baris(`${tag}-A`, "INV-1", 1000);
        const res = await kirim(m, await kunciLock(m, [a]), [a]);
        assert.equal(res.status, 409);
        assert.deepEqual((await res.json()).rows, [{ index: 0, key: kunci(a).key, reason: "ACCURATE_HISTORY", receiptNumbers: [] }]);
        assert.equal(catat.post.length, 0);
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
        const pendek = await m.lock(post("/api/idempotency/lock", { keys: [kunci(a)], allowHistoryKeys: [kunci(a).key], overrideReason: "pendek", expectedDatabaseId: "DB-1" }));
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

test("PG butir 4: sesi Accurate belum lengkap -> 400 ACCURATE_SESSION_INCOMPLETE {sent:false}; baris tetap PROCESSING (boleh FAILED, bukan tidak pasti)", { skip: pgSkip }, () =>
    dalamDunia((_t, m) => ({ izin: KIRIM, sesi: m.sesiAccurate({ sessionId: null }), data: KOSONG }), async (m, tag, catat) => {
        const a = baris(`${tag}-A`, "INV-1", 1000);
        const lockId = await kunciLock(m, [a]);
        const res = await kirim(m, lockId, [a]);
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.code, "ACCURATE_SESSION_INCOMPLETE");
        assert.equal(body.sent, false);
        assert.equal(catat.post.length + catat.baca, 0);
        assert.equal(await statusDb(m.db, kunci(a).key), "PROCESSING");
    }));

test("PG butir 6 + B6: ringkasan selaras Selesaikan — SENDING >= 2 mnt, PROCESSING > 15 mnt (jam UTC); ?rows=1 memuat PROCESSING basi; saring database", { skip: pgSkip }, async () => {
    const { db } = await modul();
    const { ringkasanIdempotensi } = await import("./idempotency-summary.ts");
    const { bolehDiselesaikan } = await import("./idempotency-resolve.ts");
    const tag = `s6e2-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    const lalu = (mnt: number) => new Date(now.getTime() - mnt * 60_000);
    const baru = (k: string, status: string, umur: number, databaseId: string | null = "DB-1") => ({ key: `PAY_${tag}_${k}`, status, createdAt: lalu(umur), updatedAt: lalu(umur), databaseId });
    try {
        await db.insert(idempotencyLog).values([baru("u", "UNKNOWN", 1), baru("s1", "SENDING", 20), baru("s3", "SENDING", 16, "DB-2"), baru("s2", "SENDING", 5),
            baru("s5", "SENDING", 2), baru("s4", "SENDING", 1),
            baru("f", "FAILED", 60, null), baru("p1", "PROCESSING", 16), baru("p2", "PROCESSING", 14), baru("p3", "PROCESSING", 1), baru("ok", "SUCCESS", 99)]);
        const saring = like(idempotencyLog.key, `PAY_${tag}%`);
        const r = await ringkasanIdempotensi(db, now, saring);
        assert.deepEqual(r.uncertain, { unknown: 1, sendingStale: 4, total: 5 }, "SENDING >= 2 mnt = tidak pasti (ambang Selesaikan)");
        assert.equal(r.retryable, 1);
        assert.equal(r.processingStale, 1);
        const per = Object.fromEntries(r.perDatabase.map((d) => [d.label, [d.uncertain.total, d.retryable, d.processingStale]]));
        assert.deepEqual(per, { "DB-1": [4, 0, 1], "DB-2": [1, 0, 0], "tidak tercatat": [0, 1, 0] });
        const { daftarBarisRingkasan } = await import("./idempotency-summary.ts");
        const d = await daftarBarisRingkasan(db, now, saring);
        assert.deepEqual(d.rows.map((x) => [x.key.slice(-2), x.category]).sort(),
            [["_f", "retryable"], ["_u", "uncertain"], ["s1", "uncertain"], ["s2", "uncertain"], ["s3", "uncertain"], ["s5", "uncertain"], ["p1", "processingStale"]].sort(),
            "SENDING < 2 mnt & PROCESSING muda tidak masuk daftar");
        // Selaras: baris non-FAILED di daftar = TEPAT baris yang boleh diselesaikan.
        const semua = await db.select().from(idempotencyLog).where(saring);
        assert.deepEqual(d.rows.filter((x) => x.category !== "retryable").map((x) => x.key).sort(),
            semua.filter((x) => bolehDiselesaikan(x, now)).map((x) => x.key).sort());
        assert.equal(d.rowsTruncated, false);
        assert.ok(d.rows.every((x) => !("payload" in x)));
        assert.deepEqual((await daftarBarisRingkasan(db, now, saring, "DB-2")).rows.map((x) => x.key.slice(-2)), ["s3"], "disaring per database");
    } finally {
        await db.delete(idempotencyLog).where(like(idempotencyLog.key, `PAY_${tag}%`));
    }
});

test("PG butir 2: lock mencatat database sesi; lock di DB-1 lalu kirim dengan sesi DB-2 (expected DB-2) -> 409 database_changed, tidak dikirim", { skip: pgSkip }, async () => {
    let sesiKini: Record<string, unknown> | null = null;
    await dalamDunia((_t, m) => { sesiKini = m.sesiAccurate(); return { izin: KIRIM, get sesi() { return sesiKini; }, data: KOSONG }; }, async (m, tag, catat) => {
        const a = baris(`${tag}-A`, "INV-1", 1000);
        // Lock ke database berbeda dari sesi = 409, tidak ada yang dikunci.
        const salah = await m.lock(post("/api/idempotency/lock", { keys: [kunci(a)], expectedDatabaseId: "DB-9" }));
        assert.equal(salah.status, 409);
        assert.equal((await salah.json()).code, "database_changed");
        assert.equal(await statusDb(m.db, kunci(a).key), undefined);
        const lockId = await kunciLock(m, [a]);
        const { eq } = await import("drizzle-orm");
        assert.equal((await m.db.select({ d: idempotencyLog.databaseId }).from(idempotencyLog).where(eq(idempotencyLog.key, kunci(a).key)))[0].d, "DB-1");
        sesiKini = m.sesiAccurate({ databaseId: "DB-2", databaseAlias: "PT B" }); // pindah database di tab lain
        const res = await m.proxy(post("/api/proxy", { endpointPath: PATH, method: "POST", payload: [a], idempotencyLockId: lockId, expectedDatabaseId: "DB-2" }));
        assert.equal(res.status, 409);
        const body = await res.json();
        assert.equal(body.code, "database_changed");
        assert.equal(body.lockDatabaseId, "DB-1");
        assert.equal(catat.post.length + catat.baca, 0);
        assert.equal(await statusDb(m.db, kunci(a).key), "PROCESSING");
    });
});

// ------------------------------------------------------------------ butir 5: POST Selesaikan
// Catatan: jejak idempotency_resolution tidak bisa dihapus (trigger DDL_S6E2) — baris uji berkunci tag unik tertinggal di DB evaluasi.
const RESOLVE = ["finance.resolve_unknown"];
const ALASAN = "Dicek langsung di Accurate oleh Finance";
async function tanam(db: Db, r: Record<string, unknown>, status: string, umurMnt: number, databaseId: string | null) {
    const p = kunci(r);
    const t = new Date(Date.now() - umurMnt * 60_000);
    await db.insert(idempotencyLog).values({ key: p.key, status, customerNo: p.customerNo, transDate: p.transDate, invoiceNo: p.invoiceNo,
        amount: p.amount, createdAt: t, updatedAt: t, lockId: "L-lama", lockedBy: "orang-lain", databaseId });
    return p.key;
}
const selesaikan = (m: Awaited<ReturnType<typeof modul>>, body: Record<string, unknown>) =>
    m.resolve(post("/api/idempotency/resolve", { reason: ALASAN, checkedSource: "Accurate: daftar pelunasan", expectedDatabaseId: "DB-1", ...body }));
async function jejak(db: Db, k: string) {
    const { eq } = await import("drizzle-orm");
    return db.select().from(idempotencyResolution).where(eq(idempotencyResolution.key, k));
}

test("PG butir 5: terposting — nomor harus ditemukan pencarian; tercatat (siapa/database/sumber/alasan); ulang = already_resolved", { skip: pgSkip }, () =>
    dalamDunia((tag, m) => ({ izin: RESOLVE, sesi: m.sesiAccurate(), data: { ...KOSONG, salesReceipt: [riwayat(`${tag}-A`, "INV-1", 1000, "PR.5")] } }), async (m, tag) => {
        const k = await tanam(m.db, baris(`${tag}-A`, "INV-1", 1000), "UNKNOWN", 1, "DB-1");
        const salah = await selesaikan(m, { key: k, decision: "terposting", accurateNumber: "PR.6" });
        assert.equal(salah.status, 409);
        assert.equal((await salah.json()).code, "number_mismatch");
        assert.equal(await statusDb(m.db, k), "UNKNOWN");
        const ok = await selesaikan(m, { key: k, decision: "terposting", accurateNumber: "PR.5" });
        assert.equal(ok.status, 200);
        assert.equal(await statusDb(m.db, k), "SUCCESS");
        const j = await jejak(m.db, k);
        assert.equal(j.length, 1);
        assert.deepEqual([j[0].decision, j[0].accurateNumber, j[0].databaseId, j[0].actor, j[0].previousStatus, j[0].reason],
            ["terposting", "PR.5", "DB-1", ME, "UNKNOWN", ALASAN]);
        const lagi = await selesaikan(m, { key: k, decision: "terposting", accurateNumber: "PR.5" });
        assert.equal(lagi.status, 200);
        assert.equal((await lagi.json()).alreadyResolved, true);
        assert.equal((await jejak(m.db, k)).length, 1, "ulang tidak menambah jejak");
    }));

test("PG butir 5: tidak_ada — ditolak bila ditemukan / < 2 mnt / database lain / database tak tercatat; sah -> FAILED (boleh dikirim ulang)", { skip: pgSkip }, () =>
    dalamDunia((tag, m) => ({ izin: RESOLVE, sesi: m.sesiAccurate(), data: { ...KOSONG, salesReceipt: [riwayat(`${tag}-F`, "INV-F", 1, "PR.F")] } }), async (m, tag) => {
        const kode = async (body: Record<string, unknown>) => { const r = await selesaikan(m, body); return [r.status, (await r.json()).code]; };
        const ditemukan = await tanam(m.db, baris(`${tag}-F`, "INV-F", 1), "UNKNOWN", 5, "DB-1");
        assert.deepEqual(await kode({ key: ditemukan, decision: "tidak_ada" }), [409, "similar_found"]);
        const muda = await tanam(m.db, baris(`${tag}-M`, "INV-M", 1), "UNKNOWN", 1, "DB-1");
        assert.deepEqual(await kode({ key: muda, decision: "tidak_ada" }), [409, "not_eligible"]);
        const sending = await tanam(m.db, baris(`${tag}-S`, "INV-S", 1), "SENDING", 1, "DB-1");
        assert.deepEqual(await kode({ key: sending, decision: "terposting", accurateNumber: "X" }), [409, "not_eligible"]);
        const lain = await tanam(m.db, baris(`${tag}-L`, "INV-L", 1), "UNKNOWN", 5, "DB-2");
        assert.deepEqual(await kode({ key: lain, decision: "tidak_ada" }), [409, "wrong_database"]);
        const lama = await tanam(m.db, baris(`${tag}-N`, "INV-N", 1), "UNKNOWN", 5, null);
        const r = await selesaikan(m, { key: lama, decision: "tidak_ada" });
        assert.equal(r.status, 409);
        const b = await r.json();
        assert.equal(b.code, "database_unknown");
        assert.match(b.error, /database lain/);
        const sukses = await tanam(m.db, baris(`${tag}-T`, "INV-T", 1), "SENDING", 5, "DB-1");
        assert.deepEqual(await kode({ key: sukses, decision: "tidak_ada" }), [200, undefined]);
        assert.equal(await statusDb(m.db, sukses), "FAILED");
        for (const k of [ditemukan, muda, sending, lain, lama]) assert.equal((await jejak(m.db, k)).length, 0, "ditolak = tanpa jejak");
    }));

test("PG butir 5: pencarian Accurate gagal -> 409 search_failed, tidak ada yang diubah", { skip: pgSkip }, () =>
    dalamDunia((_t, m) => ({ izin: RESOLVE, sesi: m.sesiAccurate(), data: KOSONG, galatBaca: true }), async (m, tag) => {
        const k = await tanam(m.db, baris(`${tag}-G`, "INV-G", 1), "UNKNOWN", 5, "DB-1");
        for (const decision of ["tidak_ada", "terposting"]) {
            const r = await selesaikan(m, { key: k, decision, accurateNumber: "PR.1" });
            assert.equal(r.status, 409);
            assert.equal((await r.json()).code, "search_failed");
        }
        assert.equal(await statusDb(m.db, k), "UNKNOWN");
    }));

test("PG butir 5: baris lama (database tak tercatat) -> terposting BOLEH dengan nomor yang ditemukan di database sesi", { skip: pgSkip }, () =>
    dalamDunia((tag, m) => ({ izin: RESOLVE, sesi: m.sesiAccurate(), data: { ...KOSONG, salesReceipt: [riwayat(`${tag}-A`, "INV-1", 7, "PR.L")] } }), async (m, tag) => {
        const k = await tanam(m.db, baris(`${tag}-A`, "INV-1", 7), "UNKNOWN", 30, null);
        const r = await selesaikan(m, { key: k, decision: "terposting", accurateNumber: "PR.L" });
        assert.equal(r.status, 200);
        assert.equal(await statusDb(m.db, k), "SUCCESS");
        assert.equal((await jejak(m.db, k))[0].databaseId, "DB-1");
    }));

test("PG butir 5: status berubah selama pencarian (keputusan/kiriman lain) -> 409 changed, tanpa jejak (CAS)", { skip: pgSkip }, async () => {
    const { db } = await modul();
    const { selesaikanPelunasan } = await import("./idempotency-resolve.ts");
    const { eq } = await import("drizzle-orm");
    const tag = `s6e2-${randomUUID().slice(0, 8)}`;
    const k = await tanam(db, baris(`${tag}-C`, "INV-C", 1), "UNKNOWN", 5, "DB-1");
    try {
        const r = await selesaikanPelunasan(db, { key: k, decision: "tidak_ada", accurateNumber: "", reason: ALASAN, checkedSource: "uji", actor: "uji", sessionDatabaseId: "DB-1" },
            async () => {
                await db.update(idempotencyLog).set({ status: "SUCCESS", updatedAt: new Date() }).where(eq(idempotencyLog.key, k));
                return { mirip: new Map(), gagal: new Map() };
            });
        assert.equal(r.status, 409);
        assert.equal(r.body.code, "changed");
        assert.equal(await statusDb(db, k), "SUCCESS");
        assert.equal((await jejak(db, k)).length, 0);
    } finally {
        await db.delete(idempotencyLog).where(like(idempotencyLog.key, `PAY_${tag}%`));
    }
});

// ------------------------------------------------------------------ Tinjauan 11 Okt B1 (REV-B D & F): `tidak_ada` = bukti ketiadaan KETAT
async function mundurkan(db: Db, k: string, mnt: number) {
    const { eq } = await import("drizzle-orm");
    await db.update(idempotencyLog).set({ updatedAt: new Date(Date.now() - mnt * 60_000) }).where(eq(idempotencyLog.key, k));
}
/** Accurate MENYIMPAN pelunasan `simpan` tetapi jawabannya tidak pasti (amplop s:false tanpa hasil per baris = UNKNOWN, C11). */
const simpanLaluRagu = (data: { salesReceipt?: Record<string, unknown>[] }, simpan: () => Record<string, unknown>) => () => {
    data.salesReceipt!.push(simpan());
    return { s: false, d: ["Proses belum selesai"] };
};

test("PG REV-B D: lock Rp1.000 → kiriman koreksi Rp900 → UNKNOWN → tidak_ada 409 similar_found; tetap 1 POST; Finance bisa pilih terposting", { skip: pgSkip }, () => {
    const data = { ...KOSONG, salesReceipt: [] as Record<string, unknown>[] };
    let tagD = "";
    return dalamDunia((tag, m) => {
        tagD = tag;
        return { izin: [...KIRIM, ...RESOLVE], sesi: m.sesiAccurate(), data, balasPost: simpanLaluRagu(data, () => riwayat(`${tagD}-D`, "INV-D", 900, "PR.D1")) };
    }, async (m, tag, catat) => {
        const a = baris(`${tag}-D`, "INV-D", 1000);
        const lockId = await kunciLock(m, [a]);
        const res = await kirim(m, lockId, [baris(`${tag}-D`, "INV-D", 900)]); // koreksi: identitas dasar sama, diterima guard
        assert.equal(res.status, 200);
        assert.equal(catat.post.length, 1);
        assert.equal(await statusDb(m.db, kunci(a).key), "UNKNOWN");
        await mundurkan(m.db, kunci(a).key, 5);
        const r = await selesaikan(m, { key: kunci(a).key, decision: "tidak_ada" });
        const b = await r.json();
        assert.equal(r.status, 409, JSON.stringify(b));
        assert.equal(b.code, "similar_found");
        assert.deepEqual(b.receiptNumbers, ["PR.D1"]);
        assert.deepEqual(b.candidates, [{ receiptNumber: "PR.D1", invoiceNos: ["INV-D"], amount: 900, transDate: "09/10/2026",
            invoices: [{ invoiceNo: "INV-D", paymentAmount: 900, invoicePayment: null }] }]);
        assert.equal(await statusDb(m.db, kunci(a).key), "UNKNOWN");
        assert.equal((await jejak(m.db, kunci(a).key)).length, 0);
        // Lock ulang tetap terblokir (UNKNOWN) -> tidak ada POST kedua.
        const ulang = await m.lock(post("/api/idempotency/lock", { keys: [kunci(a)], expectedDatabaseId: "DB-1" }));
        assert.deepEqual((await ulang.json()).blockedKeys, [kunci(a).key]);
        assert.equal(catat.post.length, 1);
        // Finance memilih kandidat yang dilaporkan -> terposting.
        const t = await selesaikan(m, { key: kunci(a).key, decision: "terposting", accurateNumber: "PR.D1" });
        assert.equal(t.status, 200);
        assert.equal(await statusDb(m.db, kunci(a).key), "SUCCESS");
    });
});

test("PG REV-B F: baris berpotongan, detail Accurate tanpa discountNotes → tidak_ada 409 similar_found; FAILED paksa → kirim ulang DITAHAN", { skip: pgSkip }, () => {
    const data = { ...KOSONG, salesReceipt: [] as Record<string, unknown>[] };
    let tagF = "";
    const dgnPot = (cust: string) => ({ customerNo: cust, transDate: "09/10/2026",
        detailInvoice: [{ invoiceNo: "INV-F", paymentAmount: 900, detailDiscount: [{ accountNo: "600123", discountNotes: "Pot TB", amount: 100 }] }] });
    return dalamDunia((tag, m) => {
        tagF = tag;
        return { izin: [...KIRIM, ...RESOLVE], sesi: m.sesiAccurate(), data, balasPost: simpanLaluRagu(data, () => ({ id: "PR.F1", number: "PR.F1",
            customer: { customerNo: `${tagF}-F` }, transDate: "09/10/2026",
            detailInvoice: [{ invoice: { number: "INV-F" }, paymentAmount: 900, detailDiscount: [{ account: { no: "600123" }, amount: 100 }] }] })) };
    }, async (m, tag, catat) => {
        const a = dgnPot(`${tag}-F`);
        const lockId = await kunciLock(m, [a]);
        assert.equal((await kirim(m, lockId, [a])).status, 200);
        assert.equal(await statusDb(m.db, kunci(a).key), "UNKNOWN");
        await mundurkan(m.db, kunci(a).key, 5);
        const r = await selesaikan(m, { key: kunci(a).key, decision: "tidak_ada" });
        assert.equal(r.status, 409);
        assert.equal((await r.json()).code, "similar_found");
        // Andai baris tetap FAILED (jalur lain), kirim ulang ditahan penjaga riwayat (identitas kasar) — tidak ada POST kedua.
        const { eq } = await import("drizzle-orm");
        await m.db.update(idempotencyLog).set({ status: "FAILED" }).where(eq(idempotencyLog.key, kunci(a).key));
        const lock2 = await kunciLock(m, [a]);
        const res2 = await kirim(m, lock2, [a]);
        assert.equal(res2.status, 409);
        const b2 = await res2.json();
        assert.equal(b2.code, "ACCURATE_HISTORY");
        assert.deepEqual(b2.rows[0].receiptNumbers, ["PR.F1"]);
        assert.equal(catat.post.length, 1);
    });
});

// ------------------------------------------------------------------ Tinjauan 11 Okt B2 (REV-B G): override terikat database lock
test("PG REV-B G: lock berisi override resend_success saja (tanpa baris lock) di DB-1, sesi pindah DB-2 -> 409 database_changed, tidak dikirim", { skip: pgSkip }, async () => {
    let sesiKini: Record<string, unknown> | null = null;
    await dalamDunia((_t, m) => { sesiKini = m.sesiAccurate(); return { izin: FINANCE, get sesi() { return sesiKini; }, data: KOSONG }; }, async (m, tag, catat) => {
        const a = baris(`${tag}-G`, "INV-G", 1000);
        await tanam(m.db, a, "SUCCESS", 30, "DB-1");
        const lockId = await kunciLock(m, [a], { allowLockedKeys: [kunci(a).key], overrideReason: "Kirim ulang atas konfirmasi Finance tertulis" });
        const o = await overrideDb(m.db, kunci(a).key);
        assert.equal(o.length, 1, "satu override resend_success, tanpa baris lock");
        sesiKini = m.sesiAccurate({ databaseId: "DB-2", databaseAlias: "PT B" });
        const res = await m.proxy(post("/api/proxy", { endpointPath: PATH, method: "POST", payload: [a], idempotencyLockId: lockId, expectedDatabaseId: "DB-2" }));
        const body = await res.json();
        assert.equal(res.status, 409, JSON.stringify(body));
        assert.equal(body.code, "database_changed");
        assert.equal(body.lockDatabaseId, "DB-1");
        assert.equal(body.sent, false);
        assert.equal(catat.post.length + catat.baca, 0);
        assert.ok((await overrideDb(m.db, kunci(a).key)).every((x) => !x.consumedAt), "override tidak dihabiskan");
        // Kontrol: database yang sama dengan lock -> terkirim (override dihabiskan).
        sesiKini = m.sesiAccurate();
        assert.equal((await kirim(m, lockId, [a])).status, 200);
        assert.equal(catat.post.length, 1);
        // Override lama (database_id NULL, sebelum kolom ada) = "tidak tercatat" -> ditolak juga.
        const b = baris(`${tag}-H`, "INV-H", 5);
        await m.db.insert(idempotencyOverride).values({ id: randomUUID(), lockId: `L-${tag}`, key: kunci(b).key, actor: ME,
            reason: "Override lama sebelum kolom database", blockReason: "ALREADY_SUCCESS", previousStatus: "SUCCESS", action: "resend_success" });
        const lama = await kirim(m, `L-${tag}`, [b]);
        assert.equal(lama.status, 409);
        assert.equal((await lama.json()).lockDatabaseId, "tidak tercatat");
        assert.equal(catat.post.length, 1);
    });
});

// ------------------------------------------------------------------ Tinjauan 11 Okt RENDAH (B4, B8)
test("PG B4: Selesaikan kalah CAS tetapi status kini = tujuan (keputusan sama dari tab lain) -> 200 alreadyResolved, tanpa jejak ganda", { skip: pgSkip }, async () => {
    const { db } = await modul();
    const { selesaikanPelunasan } = await import("./idempotency-resolve.ts");
    const { eq } = await import("drizzle-orm");
    const tag = `s6e2-${randomUUID().slice(0, 8)}`;
    const k = await tanam(db, baris(`${tag}-K`, "INV-K", 1), "UNKNOWN", 5, "DB-1");
    try {
        const r = await selesaikanPelunasan(db, { key: k, decision: "tidak_ada", accurateNumber: "", reason: ALASAN, checkedSource: "uji", actor: "uji", sessionDatabaseId: "DB-1" },
            async () => {
                await db.update(idempotencyLog).set({ status: "FAILED", updatedAt: new Date() }).where(eq(idempotencyLog.key, k));
                return { mirip: new Map(), gagal: new Map() };
            });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.alreadyResolved, true);
        assert.equal(r.body.status, "FAILED");
        assert.equal((await jejak(db, k)).length, 0, "pemenang yang mencatat jejaknya");
    } finally {
        await db.delete(idempotencyLog).where(like(idempotencyLog.key, `PAY_${tag}%`));
    }
});

test("PG B8: lock PROCESSING tanpa database tercatat (baris lama) -> proxy 409 database_changed lockDatabaseId 'tidak tercatat', tidak dikirim", { skip: pgSkip }, () =>
    dalamDunia((_t, m) => ({ izin: KIRIM, sesi: m.sesiAccurate(), data: KOSONG }), async (m, tag, catat) => {
        const a = baris(`${tag}-N`, "INV-N", 1000);
        const p = kunci(a);
        await m.db.insert(idempotencyLog).values({ key: p.key, status: "PROCESSING", customerNo: p.customerNo, transDate: p.transDate, invoiceNo: p.invoiceNo,
            amount: p.amount, createdAt: new Date(), updatedAt: new Date(), lockId: `L-${tag}`, lockedBy: ME, databaseId: null });
        const res = await kirim(m, `L-${tag}`, [a]);
        assert.equal(res.status, 409);
        const b = await res.json();
        assert.deepEqual([b.code, b.lockDatabaseId, b.sent], ["database_changed", "tidak tercatat", false]);
        assert.equal(catat.post.length + catat.baca, 0);
        assert.equal(await statusDb(m.db, p.key), "PROCESSING");
    }));
