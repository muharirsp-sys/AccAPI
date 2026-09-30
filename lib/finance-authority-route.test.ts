/* Owner D-14/D-18 (2026-09-30): aksi yang membuka kiriman ulang ke Accurate hanya untuk kewenangan Finance
 * (`finance.retry_post`), DITEGAKKAN backend. Uji perilaku: sesi & grup dipalsukan, tanpa DB/jaringan. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST as resolvePurchasePayment } from "../app/api/finance/purchase-payment/resolve/route.ts";
import { POST as lockIdempotency } from "../app/api/idempotency/lock/route.ts";
import { POST as completeIdempotency } from "../app/api/idempotency/complete/route.ts";
import { POST as proxyPost } from "../app/api/proxy/route.ts";
import { auth } from "./auth.ts";
import { db } from "./db.ts";

/** Jalankan `fn` sebagai user bergrup dengan izin `keys` (tanpa bypass lokal). */
export async function asUserWith<T>(keys: string[], fn: () => Promise<T>, existing: unknown[] = []): Promise<T> {
    const saved = [
        [auth.api, "getSession", Object.getOwnPropertyDescriptor(auth.api, "getSession")],
        [db, "select", Object.getOwnPropertyDescriptor(db, "select")],
        [db, "transaction", Object.getOwnPropertyDescriptor(db, "transaction")],
        [globalThis, "fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch")],
    ] as const;
    const env = process.env.LOCAL_AUTH_BYPASS;
    delete process.env.LOCAL_AUTH_BYPASS;
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => ({ user: { id: "u-fin", role: "staff" }, session: { id: "s1" } }) });
    // getUserPermissions: select().from(userGroup).leftJoin(groupPermission).where(...) -> baris grup.
    const rows = keys.map((key) => ({ groupId: "g1", key }));
    // Query lain (mis. baris idempotency_log yang ada) = select().from().where() -> `existing`.
    Object.defineProperty(db, "select", { configurable: true, value: () => ({ from: () => ({ leftJoin: () => ({ where: async () => rows }), where: async () => existing }) }) });
    Object.defineProperty(db, "transaction", { configurable: true, value: () => { throw new Error("TIDAK BOLEH menulis DB"); } });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: () => { throw new Error("TIDAK BOLEH ke jaringan"); } });
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

test("D-14 resolve purchase-payment: finance.update saja -> 403; finance.retry_post -> lolos gate", async () => {
    const denied = await asUserWith(["finance.update", "finance.view"], () => resolvePurchasePayment(jsonPost("/api/finance/purchase-payment/resolve", {})));
    assert.equal(denied.status, 403, "tanpa finance.retry_post harus 403");
    // Kontrol positif: gate lolos, lalu validasi body (kosong) menjawab 400 — 403 di atas memang dari izin.
    const allowed = await asUserWith(["finance.retry_post"], () => resolvePurchasePayment(jsonPost("/api/finance/purchase-payment/resolve", {})));
    assert.equal(allowed.status, 400);
});

test("D-18 override sales-receipt: non-Finance -> 403; Finance tanpa alasan -> 400; tanpa tulis DB", async () => {
    const successRow = [{ key: "PAY_C1_01/09/2026_INV-1|1000|", status: "SUCCESS", updatedAt: new Date(), createdAt: null }];
    const body = (overrideReason = "") => ({ keys: [{ key: successRow[0].key }], allowLockedKeys: [successRow[0].key], overrideReason });
    const denied = await asUserWith(["api_wrapper.view", "finance.update"], () => lockIdempotency(jsonPost("/api/idempotency/lock", body("alasan override yang cukup panjang"))), successRow);
    assert.equal(denied.status, 403, "override tanpa finance.retry_post harus 403");
    const noReason = await asUserWith(["finance.retry_post"], () => lockIdempotency(jsonPost("/api/idempotency/lock", body("pendek"))), successRow);
    assert.equal(noReason.status, 400, "alasan < 15 karakter harus 400");
    // Kontrol positif: tanpa override, non-Finance tetap boleh melihat blok (preview) — 200, tanpa tulis.
    const preview = await asUserWith(["api_wrapper.view"], () => lockIdempotency(jsonPost("/api/idempotency/lock", { keys: [{ key: successRow[0].key }], preview: true })), successRow);
    assert.equal(preview.status, 200);
    assert.deepEqual((await preview.json()).blockedKeys, [successRow[0].key]);
});

test("AM-050: complete tanpa lockId -> 400 (sesi lain tak bisa menutup PROCESSING orang lain)", async () => {
    const res = await asUserWith(["api_wrapper.view"], () => completeIdempotency(jsonPost("/api/idempotency/complete", { keys: ["K"], status: "FAILED" })));
    assert.equal(res.status, 400);
});

test("AM-024: proxy menolak tulis sales-receipt tanpa lock (409) sebelum sesi Accurate & jaringan", async () => {
    for (const endpointPath of ["/api/sales-receipt/bulk-save.do", "/api/sales-receipt/save.do", "/api/./sales-receipt/%62ulk-save.do"]) {
        const res = await asUserWith([], () => proxyPost(jsonPost("/api/proxy", { endpointPath, method: "POST", payload: [{ customerNo: "C1" }] })));
        assert.equal(res.status, 409, endpointPath);
        assert.equal((await res.json()).code, "SALES_RECEIPT_LOCK_REQUIRED");
    }
});
