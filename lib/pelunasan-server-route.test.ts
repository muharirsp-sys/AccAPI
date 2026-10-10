/* S6e-2a: penjaga server Pelunasan di route ASLI tanpa DB/jaringan nyata — sesi, grup, sesi Accurate, dan baris
 * idempotency_log dipalsukan; tulis DB dan jaringan melempar (kecuali `fetch` yang disuntik uji). Jalur yang memakai
 * transaksi guard (tandai SENDING, habiskan override) diuji dengan Postgres di lib/pelunasan-server-pg.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as proxyPost } from "../app/api/proxy/route.ts";
import { POST as lockPost } from "../app/api/idempotency/lock/route.ts";
import { accurateOAuthSession } from "../db/schema.ts";
import { auth } from "./auth.ts";
import { db } from "./db.ts";

process.env.ACCURATE_TOKEN_ENCRYPTION_KEY = "kunci-uji-s6e2a";
const enc = (v: string) => {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", createHash("sha256").update(process.env.ACCURATE_TOKEN_ENCRYPTION_KEY!).digest(), iv);
    const e = Buffer.concat([c.update(v, "utf8"), c.final()]);
    return `${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${e.toString("base64")}`;
};
/** Baris accurate_oauth_session tiruan (host diizinkan, database DB-1). */
export const sesiAccurate = (over: Record<string, unknown> = {}) => ({
    userId: "u-p", accessToken: enc("tok"), sessionHost: "https://public.accurate.id", sessionId: enc("sid"),
    databaseId: "DB-1", databaseAlias: "PT A", createdAt: new Date(), updatedAt: new Date(), ...over,
});

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
    const rows = (r: unknown[]) => Object.assign(Promise.resolve(r), { limit: async () => r });
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
