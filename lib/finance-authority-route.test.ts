/* Owner D-14/D-18 (2026-09-30): aksi yang membuka kiriman ulang ke Accurate hanya untuk kewenangan Finance
 * (`finance.retry_post`), DITEGAKKAN backend. Uji perilaku: sesi & grup dipalsukan, tanpa DB/jaringan. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST as resolvePurchasePayment } from "../app/api/finance/purchase-payment/resolve/route.ts";
import { auth } from "./auth.ts";
import { db } from "./db.ts";

/** Jalankan `fn` sebagai user bergrup dengan izin `keys` (tanpa bypass lokal). */
export async function asUserWith<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const saved = [
        [auth.api, "getSession", Object.getOwnPropertyDescriptor(auth.api, "getSession")],
        [db, "select", Object.getOwnPropertyDescriptor(db, "select")],
    ] as const;
    const env = process.env.LOCAL_AUTH_BYPASS;
    delete process.env.LOCAL_AUTH_BYPASS;
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => ({ user: { id: "u-fin", role: "staff" }, session: { id: "s1" } }) });
    // getUserPermissions: select().from(userGroup).leftJoin(groupPermission).where(...) -> baris grup.
    const rows = keys.map((key) => ({ groupId: "g1", key }));
    Object.defineProperty(db, "select", { configurable: true, value: () => ({ from: () => ({ leftJoin: () => ({ where: async () => rows }) }) }) });
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
