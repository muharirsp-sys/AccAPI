/* AM-043 (D.21): backend menolak angka target/support yang bukan number finite >= 0, walau UI
 * biasanya memblokir. NaN dari sel Excel invalid menjadi `null` saat JSON.stringify — server tidak
 * boleh mengubahnya menjadi 0, dan field target yang HILANG tidak boleh jatuh ke DEFAULT 0.
 * Semua kasus harus ditolak 400 SEBELUM DB disentuh. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST as postTargets } from "../app/api/insentif-sales/targets/route.ts";
import { POST as postSupport } from "../app/api/insentif-sales/support/route.ts";
import { db } from "./db.ts";

async function withLocalAdminNoDb<T>(fn: () => Promise<T>): Promise<T> {
    const env = { NODE_ENV: process.env.NODE_ENV, LOCAL_AUTH_BYPASS: process.env.LOCAL_AUTH_BYPASS };
    const saved = (["select", "insert", "update", "transaction"] as const).map((k) => [k, Object.getOwnPropertyDescriptor(db, k)] as const);
    Object.assign(process.env, { NODE_ENV: "development", LOCAL_AUTH_BYPASS: "true" });
    for (const [k] of saved) Object.defineProperty(db, k, { configurable: true, value: () => { throw new Error(`DB disentuh (${k})`); } });
    try {
        return await fn();
    } finally {
        for (const [k, d] of saved) {
            if (d) Object.defineProperty(db, k, d);
            else delete (db as unknown as Record<string, unknown>)[k];
        }
        for (const [k, v] of Object.entries(env)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

const req = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, {
    method: "POST", headers: { host: "localhost:3000", "content-type": "application/json" }, body: JSON.stringify(body),
});

const target = (over: Record<string, unknown> = {}) => ({
    salesCode: "S-01", salesName: "Budi", principle: "GODREJ", branch: "MKS", periodMonth: 9, periodYear: 2026,
    targetValue: 1_000_000, targetEc: 10, targetAo: 5, targetIa: 2, ...over,
});

test("targets: null / hilang / string / boolean / NaN->null ditolak 400 tanpa menyentuh DB", async () => {
    await withLocalAdminNoDb(async () => {
        for (const [label, over] of [
            ["targetValue null (NaN setelah JSON)", { targetValue: null }],
            ["targetEc hilang", { targetEc: undefined }],
            ["targetAo string kosong", { targetAo: "" }],
            ["targetIa string angka", { targetIa: "12" }],
            ["targetValue boolean", { targetValue: true }],
            ["splmValue null", { splmValue: null }],
            ["targetValue negatif", { targetValue: -1 }],
        ] as const) {
            const res = await postTargets(req("/api/insentif-sales/targets", [target(over)]));
            assert.equal(res.status, 400, label);
        }
    });
});

test("support: null / string kosong / string angka ditolak 400 tanpa menyentuh DB; nol sah tetap boleh divalidasi", async () => {
    await withLocalAdminNoDb(async () => {
        const row = (supportAmount: unknown) => [{ salesCode: "S-01", principle: "GODREJ", periodMonth: 9, periodYear: 2026, supportAmount }];
        for (const bad of [null, "", "  ", "500", true, -5]) {
            const res = await postSupport(req("/api/insentif-sales/support", row(bad)));
            assert.equal(res.status, 400, `supportAmount ${JSON.stringify(bad)}`);
        }
        // Nol yang dikirim sebagai number = nol sah: lolos validasi lalu sampai ke tulis DB (di sini dimatikan).
        await assert.rejects(postSupport(req("/api/insentif-sales/support", row(0))), /DB disentuh/);
    });
});
