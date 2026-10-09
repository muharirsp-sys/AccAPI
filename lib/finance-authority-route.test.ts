/* Owner D-14/D-18 (2026-09-30): aksi yang membuka kiriman ulang ke Accurate hanya untuk kewenangan Finance,
 * DITEGAKKAN backend, satu kunci semantik per kapabilitas (sesi 5): resolve = `finance.resolve_unknown`,
 * override = `finance.override_duplicate` (repost D-15 = `finance.repost_payment`, belum ada route).
 * Memegang kunci kapabilitas LAIN (termasuk `finance.retry_post` lama) tidak cukup.
 * Uji perilaku: sesi & grup dipalsukan, tanpa DB/jaringan. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST as resolvePurchasePayment } from "../app/api/finance/purchase-payment/resolve/route.ts";
import { POST as postPurchasePayment } from "../app/api/finance/purchase-payment/route.ts";
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

/** Semua kunci finance KECUALI `except` — membuktikan kapabilitas tidak saling menggantikan. */
const financeAllBut = (except: string) => ["finance.view", "finance.update", "finance.retry_post", "finance.resolve_unknown",
    "finance.override_duplicate", "finance.repost_payment", "api_wrapper.view", "api_wrapper.execute"].filter((k) => k !== except);

const PP_PAYLOAD = [{ bankNo: "1101", vendorNo: "V-01", chequeAmount: 1000, transDate: "29/09/2026", chequeDate: "29/09/2026",
    paymentMethod: "BANK_TRANSFER", description: "SPPD: 001", detailInvoice: [{ invoiceNo: "INV-1", paymentAmount: 1000 }] }];

test("tinjauan S6-0a: POST /api/finance/purchase-payment tanpa finance.update -> 403 sebelum sesi/DB/jaringan", async () => {
    const denied = await asUserWith(financeAllBut("finance.update"), () => postPurchasePayment(jsonPost("/api/finance/purchase-payment", { clientRef: "k", payload: PP_PAYLOAD })));
    assert.equal(denied.status, 403);
});

test("tinjauan S6-0a: galat SEBELUM klaim (baca sesi Accurate melempar) -> 503 {claimed:false}, tidak dikirim", async () => {
    // asUserWith: select().from().where() tanpa .limit -> getAccurateSession melempar (mis. DB putus saat baca sesi).
    const res = await asUserWith(["finance.update"], () => postPurchasePayment(jsonPost("/api/finance/purchase-payment", { clientRef: "k", payload: PP_PAYLOAD })));
    assert.equal(res.status, 503);
    const body = await res.json() as { claimed?: boolean; error?: string };
    assert.equal(body.claimed, false);
    assert.match(String(body.error), /tidak ada yang dikirim/i);
});

test("D-14 resolve purchase-payment: hanya finance.resolve_unknown (retry_post/override/repost tidak cukup)", async () => {
    const denied = await asUserWith(financeAllBut("finance.resolve_unknown"), () => resolvePurchasePayment(jsonPost("/api/finance/purchase-payment/resolve", {})));
    assert.equal(denied.status, 403, "tanpa finance.resolve_unknown harus 403");
    // Kontrol positif: gate lolos, lalu validasi body (kosong) menjawab 400 — 403 di atas memang dari izin.
    const allowed = await asUserWith(["finance.resolve_unknown"], () => resolvePurchasePayment(jsonPost("/api/finance/purchase-payment/resolve", {})));
    assert.equal(allowed.status, 400);
});

test("D-18 override sales-receipt: hanya finance.override_duplicate -> lolos; alasan wajib; tanpa tulis DB", async () => {
    const successRow = [{ key: "PAY_C1_01/09/2026_INV-1|1000|", status: "SUCCESS", updatedAt: new Date(), createdAt: null }];
    const body = (overrideReason = "") => ({ keys: [{ key: successRow[0].key }], allowLockedKeys: [successRow[0].key], overrideReason });
    const denied = await asUserWith(financeAllBut("finance.override_duplicate"), () => lockIdempotency(jsonPost("/api/idempotency/lock", body("alasan override yang cukup panjang"))), successRow);
    assert.equal(denied.status, 403, "override tanpa finance.override_duplicate harus 403");
    const noReason = await asUserWith(["finance.override_duplicate"], () => lockIdempotency(jsonPost("/api/idempotency/lock", body("pendek"))), successRow);
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

test("S6-0d E4: proxy menolak tulis sales-invoice (403) sebelum sesi Accurate & jaringan — hanya lewat Antrean Faktur", async () => {
    for (const endpointPath of ["/api/sales-invoice/save.do", "/api/sales-invoice/bulk-save.do", "/api/./sales-invoice/%62ulk-save.do"]) {
        for (const method of ["POST", "GET"]) {
            const res = await asUserWith(["api_wrapper.view", "api_wrapper.execute", "order.edit"], () => proxyPost(jsonPost("/api/proxy", { endpointPath, method, payload: { customerNo: "C1" } })));
            assert.equal(res.status, 403, `${method} ${endpointPath}`);
            const body = await res.json();
            assert.equal(body.code, "SALES_INVOICE_VIA_OUTBOX");
            assert.match(body.error, /Antrean Faktur/);
        }
    }
});

test("AM-024: proxy menolak tulis sales-receipt tanpa lock (409) sebelum sesi Accurate & jaringan", async () => {
    for (const endpointPath of ["/api/sales-receipt/bulk-save.do", "/api/sales-receipt/save.do", "/api/./sales-receipt/%62ulk-save.do"]) {
        const res = await asUserWith([], () => proxyPost(jsonPost("/api/proxy", { endpointPath, method: "POST", payload: [{ customerNo: "C1" }] })));
        assert.equal(res.status, 409, endpointPath);
        assert.equal((await res.json()).code, "SALES_RECEIPT_LOCK_REQUIRED");
    }
});

test("AM-024 (re-review M1): path non-kanonik & bentuk payload salah ditolak 409 walau membawa lockId", async () => {
    const cases: Array<[string, unknown]> = [
        ["/api/sales-receipt/BULK-SAVE.DO", [{ customerNo: "C1" }]],        // lolos regex, tidak di-flatten
        ["/api/sales-receipt/bulk%2Dsave.do", [{ customerNo: "C1" }]],
        ["/api/sales-receipt/bulk-save.do", { data: [{ customerNo: "C1" }] }], // objek ke bulk-save: kabel tak rata
        ["/api/sales-receipt/save.do", [{ customerNo: "C1" }]],               // daftar ke save.do
        ["/api/sales-receipt/bulk-save.do", [{ customerNo: "C1", "detailInvoice[0].invoiceNo": "X" }]],
    ];
    for (const [endpointPath, payload] of cases) {
        const res = await asUserWith([], () => proxyPost(jsonPost("/api/proxy", { endpointPath, method: "POST", payload, idempotencyLockId: "lock-x" })));
        assert.equal(res.status, 409, `${endpointPath} ${JSON.stringify(payload)}`);
    }
});

test("AM-024 (re-review d60433f2 LOW): tulis sales-receipt hanya POST; elemen detail rusak = 409, bukan 500", async () => {
    const cases: Array<[string, unknown]> = [
        ["GET", [{ customerNo: "C1", detailInvoice: [{ invoiceNo: "I1", paymentAmount: 1 }] }]],
        ["POST", [{ customerNo: "C1", detailInvoice: [null] }]],
        ["POST", [{ customerNo: "C1", detailInvoice: [[{ invoiceNo: "I1" }]] }]],
        ["POST", [{ customerNo: "C1", detailInvoice: [{ invoiceNo: "I1", detailDiscount: { amount: 1 } }] }]],
        ["POST", [{ customerNo: "C1", detailInvoice: [{ invoiceNo: "I1", detailDiscount: [null] }] }]],
    ];
    for (const [method, payload] of cases) {
        const res = await asUserWith([], () => proxyPost(jsonPost("/api/proxy", { endpointPath: "/api/sales-receipt/bulk-save.do", method, payload, idempotencyLockId: "lock-x" })));
        assert.equal(res.status, 409, `${method} ${JSON.stringify(payload)}`);
    }
});

test("AM-024 (re-review 597a4b82 LOW): field skalar berbentuk objek = 409, bukan 500", async () => {
    for (const payload of [
        [{ customerNo: { toString: 1 }, detailInvoice: [] }],
        [{ customerNo: "C1", transDate: ["01/09/2026"], detailInvoice: [] }],
        [{ customerNo: "C1", detailInvoice: [{ invoiceNo: { a: 1 }, paymentAmount: 1 }] }],
        [{ customerNo: "C1", detailInvoice: [{ invoiceNo: "I1", paymentAmount: { v: 1 } }] }],
        [{ customerNo: "C1", detailInvoice: [{ invoiceNo: "I1", detailDiscount: [{ accountNo: { a: 1 }, amount: 1 }] }] }],
    ]) {
        const res = await asUserWith([], () => proxyPost(jsonPost("/api/proxy", { endpointPath: "/api/sales-receipt/bulk-save.do", method: "POST", payload, idempotencyLockId: "lock-x" })));
        assert.equal(res.status, 409, JSON.stringify(payload));
    }
});
