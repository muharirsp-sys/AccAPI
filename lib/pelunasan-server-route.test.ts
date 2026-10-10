/* S6e-2a: penjaga server Pelunasan di route ASLI tanpa DB/jaringan nyata — sesi, grup, sesi Accurate, dan baris
 * idempotency_log dipalsukan; tulis DB dan jaringan melempar (kecuali `fetch` yang disuntik uji). Jalur yang memakai
 * transaksi guard (tandai SENDING, habiskan override) diuji dengan Postgres di lib/pelunasan-server-pg.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST as proxyPost } from "../app/api/proxy/route.ts";
import { POST as lockPost } from "../app/api/idempotency/lock/route.ts";
import { GET as summaryGet } from "../app/api/idempotency/summary/route.ts";
import { GET as resolveGet, POST as resolvePost } from "../app/api/idempotency/resolve/route.ts";
import { buatEmulator, type DataAccurate } from "./pelunasan/uji/emulator-accurate.ts";
import { buildSalesReceiptIdempotencyPayload } from "./sales-receipt-fingerprint.ts";
import { accurateOAuthSession } from "../db/schema.ts";
import { auth } from "./auth.ts";
import { db } from "./db.ts";
import { sesiAccurate } from "./pelunasan/uji/sesi-accurate.ts";

type Opsi = { sesi?: Record<string, unknown> | null; idem?: unknown[]; fetch?: typeof fetch };
/** Jalankan `fn` sebagai user bergrup dengan izin `keys`. */
export async function sebagai<T>(keys: string[], fn: () => Promise<T>, opsi: Opsi = {}): Promise<T> {
    const saved = [
        [auth.api, "getSession", Object.getOwnPropertyDescriptor(auth.api, "getSession")],
        [db, "select", Object.getOwnPropertyDescriptor(db, "select")],
        [db, "transaction", Object.getOwnPropertyDescriptor(db, "transaction")],
        [globalThis, "fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch")],
    ] as const;
    const env = process.env.LOCAL_AUTH_BYPASS;
    delete process.env.LOCAL_AUTH_BYPASS;
    const grup = keys.map((key) => ({ groupId: "g1", key }));
    const rows = (r: unknown[]) => Object.assign(Promise.resolve(r), { limit: async () => r, groupBy: async () => r });
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => ({ user: { id: "u-p", role: "staff" }, session: { id: "s1" } }) });
    Object.defineProperty(db, "select", { configurable: true, value: () => ({ from: (t: unknown) => ({
        leftJoin: () => ({ where: async () => grup }),
        where: () => rows(t === accurateOAuthSession ? (opsi.sesi ? [opsi.sesi] : []) : (opsi.idem ?? [])),
    }) }) });
    Object.defineProperty(db, "transaction", { configurable: true, value: () => { throw new Error("TIDAK BOLEH menulis DB"); } });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: opsi.fetch ?? (() => { throw new Error("TIDAK BOLEH ke jaringan"); }) });
    try {
        return await fn();
    } finally {
        for (const [obj, k, d] of saved) {
            if (d) Object.defineProperty(obj, k, d);
            else delete (obj as unknown as Record<string, unknown>)[k];
        }
        if (env === undefined) delete process.env.LOCAL_AUTH_BYPASS;
        else process.env.LOCAL_AUTH_BYPASS = env;
    }
}

export const jsonPost = (url: string, body: unknown) => new NextRequest(`http://app.test${url}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

const BARIS = [{ customerNo: "C1", transDate: "01/10/2026", detailInvoice: [{ invoiceNo: "INV-1", paymentAmount: 1000 }] }];
const kirim = (over: Record<string, unknown> = {}) => jsonPost("/api/proxy", {
    endpointPath: "/api/sales-receipt/bulk-save.do", method: "POST", payload: BARIS, idempotencyLockId: "lock-1", expectedDatabaseId: "DB-1", ...over,
});

test("butir 1: tulis sales-receipt tanpa pelunasan.kirim -> 403 PERMISSION_REQUIRED, sebelum sesi Accurate & jaringan", async () => {
    // api_wrapper.execute (kunci Konsol) TIDAK cukup — owner #5.
    const res = await sebagai(["api_wrapper.view", "api_wrapper.execute", "finance.override_duplicate"], () => proxyPost(kirim()), { sesi: sesiAccurate() });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, "PERMISSION_REQUIRED");
    assert.equal(body.sent, false);
});

test("butir 1: GET proxy & tulis endpoint lain tidak butuh pelunasan.kirim (tidak berubah)", async () => {
    const res = await sebagai([], () => proxyPost(jsonPost("/api/proxy", { endpointPath: "/api/customer/list.do", method: "GET", payload: { "sp.pageSize": 1 } })), {
        sesi: sesiAccurate(), fetch: (async () => new Response(JSON.stringify({ s: true, d: [] }), { status: 200 })) as typeof fetch,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { s: true, d: [] });
});

test("butir 1: lock non-pratinjau tanpa pelunasan.kirim -> 403; pratinjau tetap 200", async () => {
    const keys = [{ key: "PAY_C1_01/10/2026_INV-1|1000|" }];
    const denied = await sebagai(["api_wrapper.view", "api_wrapper.execute"], () => lockPost(jsonPost("/api/idempotency/lock", { keys })));
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, "PERMISSION_REQUIRED");
    const preview = await sebagai([], () => lockPost(jsonPost("/api/idempotency/lock", { keys, preview: true })));
    assert.equal(preview.status, 200);
});

test("butir 8: payload memuat ISI_KODE_AKUN_ -> 400 PLACEHOLDER_AKUN sebelum izin/sesi/jaringan; lock juga 400", async () => {
    const payload = [{ ...BARIS[0], detailInvoice: [{ invoiceNo: "INV-1", paymentAmount: 900, detailDiscount: [{ amount: 100, accountNo: "ISI_KODE_AKUN_POT1_DI_UI" }] }] }];
    const res = await sebagai(["pelunasan.kirim"], () => proxyPost(kirim({ payload })), { sesi: sesiAccurate() });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "PLACEHOLDER_AKUN");
    assert.equal(body.sent, false);
    const lock = await sebagai(["pelunasan.kirim"], () => lockPost(jsonPost("/api/idempotency/lock", { keys: [{ key: "PAY_C1_01/10/2026_INV-1|900|ISI_KODE_AKUN_POT1_DI_UI::100" }] })));
    assert.equal(lock.status, 400);
    assert.equal((await lock.json()).code, "PLACEHOLDER_AKUN");
});

test("butir 2: database sesi != expectedDatabaseId -> 409 database_changed sebelum SENDING (tanpa transaksi/jaringan); tanpa = 400", async () => {
    const beda = await sebagai(["pelunasan.kirim"], () => proxyPost(kirim({ expectedDatabaseId: "DB-2" })), { sesi: sesiAccurate() });
    assert.equal(beda.status, 409);
    const body = await beda.json();
    assert.equal(body.code, "database_changed");
    assert.equal(body.sent, false);
    assert.equal(body.databaseId, "DB-1");
    const tanpa = await sebagai(["pelunasan.kirim"], () => proxyPost(kirim({ expectedDatabaseId: "" })), { sesi: sesiAccurate() });
    assert.equal(tanpa.status, 400);
    assert.equal((await tanpa.json()).code, "DATABASE_REQUIRED");
    // Kontrol positif: database sama -> lolos ke guard (transaksi tiruan melempar = 500), bukan 409 database.
    const sama = await sebagai(["pelunasan.kirim"], () => proxyPost(kirim({ expectedDatabaseId: "DB-1" })), { sesi: sesiAccurate() });
    assert.equal(sama.status, 500);
});

test("butir 6: ringkasan BL-41 — izin pelunasan.kirim ATAU finance.resolve_unknown; hitungan dari status & basi", async () => {
    const get = () => summaryGet(new NextRequest("http://app.test/api/idempotency/summary"));
    assert.equal((await sebagai(["api_wrapper.execute", "finance.override_duplicate"], get)).status, 403);
    const idem = [{ status: "UNKNOWN", basi: false, n: 2 }, { status: "UNKNOWN", basi: true, n: 1 }, { status: "SENDING", basi: true, n: 4 },
        { status: "SENDING", basi: false, n: 7 }, { status: "FAILED", basi: true, n: 5 }, { status: "PROCESSING", basi: true, n: 6 }, { status: "PROCESSING", basi: false, n: 9 }];
    for (const izin of [["pelunasan.kirim"], ["finance.resolve_unknown"]]) {
        const res = await sebagai(izin, get, { idem });
        assert.equal(res.status, 200);
        const b = await res.json();
        assert.deepEqual(b.uncertain, { unknown: 3, sendingStale: 4, total: 7 });
        assert.equal(b.retryable, 5);
        assert.equal(b.processingStale, 6);
        assert.deepEqual(b.perDatabase.map((d: { label: string }) => d.label), ["tidak tercatat"]);
        assert.equal(b.rows, undefined, "daftar baris hanya dengan ?rows=1");
    }
});

/** fetch tiruan: GET host Accurate dijawab emulator (baca-saja); tulis apa pun = galat uji. */
const fetchEmulator = (data: DataAccurate, log: string[] = []) => (async (input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET") throw new Error("TIDAK BOLEH menulis ke Accurate");
    const url = new URL(String(input));
    log.push(url.pathname);
    return new Response(JSON.stringify(await buatEmulator(data).accurateFetch(url.pathname.replace("/accurate/api", "/api"), "GET", Object.fromEntries(url.searchParams))), { status: 200 });
}) as typeof fetch;

test("butir 5 (GET): pratinjau Selesaikan — hanya finance.resolve_unknown; cari baca-saja di Accurate; eligible menurut status & umur", async () => {
    const r1 = { customerNo: "C1", transDate: "09/10/2026", detailInvoice: [{ invoiceNo: "INV-1", paymentAmount: 1000 }] };
    const r2 = { customerNo: "C2", transDate: "09/10/2026", detailInvoice: [{ invoiceNo: "INV-2", paymentAmount: 2000 }] };
    const k1 = buildSalesReceiptIdempotencyPayload(r1).key;
    const k2 = buildSalesReceiptIdempotencyPayload(r2).key;
    const mnt = (m: number) => new Date(Date.now() - m * 60_000);
    const idem = [
        { key: k1, status: "UNKNOWN", customerNo: "C1", transDate: "09/10/2026", invoiceNo: "INV-1", amount: 1000, updatedAt: mnt(1), createdAt: mnt(1) },
        { key: k2, status: "SENDING", customerNo: "C2", transDate: "09/10/2026", invoiceNo: "INV-2", amount: 2000, updatedAt: mnt(1), createdAt: mnt(1) },
    ];
    const url = `http://app.test/api/idempotency/resolve?key=${encodeURIComponent(k1)}&key=${encodeURIComponent(k2)}`;
    const get = () => resolveGet(new NextRequest(url));
    assert.equal((await sebagai(["pelunasan.kirim", "finance.override_duplicate", "order.resolve_unknown"], get)).status, 403);
    assert.equal((await sebagai(["finance.resolve_unknown"], () => resolveGet(new NextRequest("http://app.test/api/idempotency/resolve")))).status, 400);
    const tanpaSesi = await sebagai(["finance.resolve_unknown"], get, { idem });
    assert.equal((await tanpaSesi.json()).code, "ACCURATE_SESSION_INCOMPLETE");

    const data = { salesInvoice: [], salesReturn: [], salesReceipt: [
        { id: 7, number: "PR.7", customer: { customerNo: "C1" }, transDate: "09/10/2026", detailInvoice: [{ invoice: { number: "INV-1" }, paymentAmount: 1000, detailDiscount: [] }] }] };
    const log: string[] = [];
    const res = await sebagai(["finance.resolve_unknown"], get, { idem, sesi: sesiAccurate(), fetch: fetchEmulator(data, log) });
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.equal(b.databaseId, "DB-1");
    const [a, c] = b.rows;
    assert.deepEqual([a.found, a.receiptNumbers, a.eligible], [true, ["PR.7"], true]);
    assert.deepEqual([c.found, c.receiptNumbers, c.eligible], [false, [], false], "SENDING < 2 mnt belum boleh diselesaikan");
    assert.ok(log.length > 0 && log.every((p) => p.endsWith("list.do") || p.endsWith("detail.do")));
    // Riwayat gagal dibaca: found = null + readError (bukan "tidak ada").
    const gagal = await sebagai(["finance.resolve_unknown"], get, { idem, sesi: sesiAccurate(), fetch: (async () => new Response("<html>", { status: 502 })) as typeof fetch });
    const g = await gagal.json();
    assert.equal(g.rows[0].found, null);
    assert.match(g.rows[0].readError, /HTTP 502/);
});

test("butir 5 (POST): hanya finance.resolve_unknown; masukan tak sah 400 SEBELUM DB/Accurate", async () => {
    const body = { key: "K", decision: "tidak_ada", reason: "Dicek langsung di Accurate oleh Finance", checkedSource: "Accurate", expectedDatabaseId: "DB-1" };
    assert.equal((await sebagai(["pelunasan.kirim", "finance.override_duplicate", "order.resolve_unknown"], () => resolvePost(jsonPost("/api/idempotency/resolve", body)))).status, 403);
    for (const salah of [{ reason: "pendek" }, { decision: "hapus" }, { decision: "terposting", accurateNumber: "" }, { checkedSource: " " }, { expectedDatabaseId: "" }]) {
        const r = await sebagai(["finance.resolve_unknown"], () => resolvePost(jsonPost("/api/idempotency/resolve", { ...body, ...salah })));
        assert.equal(r.status, 400, JSON.stringify(salah));
    }
    // Database sesi beda dari yang ditampilkan = 409 sebelum membaca baris/Accurate.
    const beda = await sebagai(["finance.resolve_unknown"], () => resolvePost(jsonPost("/api/idempotency/resolve", { ...body, expectedDatabaseId: "DB-2" })), { sesi: sesiAccurate() });
    assert.equal(beda.status, 409);
    assert.equal((await beda.json()).code, "database_changed");
});
