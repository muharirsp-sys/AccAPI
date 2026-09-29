/* AM-014 / C.14: /api/proxy menolak tulis purchase-payment SEBELUM membaca sesi Accurate atau
 * memanggil jaringan — guard command server tidak bisa dilewati lewat proxy generik. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "../app/api/proxy/route.ts";
import { auth } from "./auth.ts";
import { db } from "./db.ts";

test("proxy: tulis purchase-payment -> 403 tanpa baca sesi & tanpa fetch", async () => {
    const sessionDescriptor = Object.getOwnPropertyDescriptor(auth.api, "getSession");
    const selectDescriptor = Object.getOwnPropertyDescriptor(db, "select");
    const realFetch = globalThis.fetch;
    let selects = 0;
    let fetches = 0;
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => ({ user: { id: "u1" }, session: { id: "s1" } }) });
    Object.defineProperty(db, "select", { configurable: true, value: () => { selects += 1; throw new Error("TIDAK BOLEH membaca sesi Accurate"); } });
    globalThis.fetch = (async () => { fetches += 1; throw new Error("TIDAK BOLEH ke jaringan"); }) as typeof fetch;
    try {
        for (const endpointPath of ["/api/purchase-payment/bulk-save.do", "/purchase-payment/bulk-save.do/api", "/api/purchase-payment/save.do"]) {
            const res = await POST(new NextRequest("http://localhost/api/proxy", {
                method: "POST",
                body: JSON.stringify({ endpointPath, method: "POST", payload: [{ bankNo: "1" }] }),
            }));
            assert.equal(res.status, 403, endpointPath);
        }
        assert.equal(selects, 0);
        assert.equal(fetches, 0);
    } finally {
        if (sessionDescriptor) Object.defineProperty(auth.api, "getSession", sessionDescriptor);
        if (selectDescriptor) Object.defineProperty(db, "select", selectDescriptor);
        else delete (db as unknown as Record<string, unknown>).select;
        globalThis.fetch = realFetch;
    }
});
