/* AM-014 / C.14: /api/proxy menolak tulis purchase-payment SEBELUM membaca sesi Accurate atau
 * memanggil jaringan — guard command server tidak bisa dilewati lewat proxy generik.
 * S7-1b (AM-024; owner PK-1..3 12 Okt): tulis non-sales-receipt = `api_wrapper.execute` + katalog Konsol; baca kanonik = sesi app. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "../app/api/proxy/route.ts";
import { isAccurateRead, isCatalogWrite } from "./accurate-forward.ts";
import { accurateOAuthSession } from "../db/schema.ts";
import { auth } from "./auth.ts";
import { db } from "./db.ts";
import { sesiAccurate } from "./pelunasan/uji/sesi-accurate.ts";

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
            assert.equal((await res.json()).sent, false, "ditolak sebelum diteruskan = tidak terkirim");
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

// ---------------- S7-1b ----------------

type Catatan = { sesiDibaca: number; transaksi: number; kiriman: Array<{ url: string; method: string; body: unknown }> };

/** Satu permintaan proxy sebagai user bergrup dengan izin `keys`; sesi Accurate palsu, `fetch` tiruan yang mencatat. */
async function proxySebagai(keys: string[], body: Record<string, unknown>, opsi: { bypass?: boolean } = {}) {
    const saved = [
        [auth.api, "getSession", Object.getOwnPropertyDescriptor(auth.api, "getSession")],
        [db, "select", Object.getOwnPropertyDescriptor(db, "select")],
        [db, "transaction", Object.getOwnPropertyDescriptor(db, "transaction")],
        [globalThis, "fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch")],
    ] as const;
    const env = { bypass: process.env.LOCAL_AUTH_BYPASS, node: process.env.NODE_ENV };
    if (opsi.bypass) process.env.LOCAL_AUTH_BYPASS = "true";
    else delete process.env.LOCAL_AUTH_BYPASS;
    const c: Catatan = { sesiDibaca: 0, transaksi: 0, kiriman: [] };
    const grup = keys.map((key) => ({ groupId: "g1", key }));
    const rows = (r: unknown[]) => Object.assign(Promise.resolve(r), { limit: async () => r });
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => (opsi.bypass ? null : { user: { id: "u-p", role: "staff" }, session: { id: "s1" } }) });
    Object.defineProperty(db, "select", { configurable: true, value: () => ({ from: (t: unknown) => ({
        leftJoin: () => ({ where: async () => grup }),
        where: () => {
            if (t === accurateOAuthSession) { c.sesiDibaca += 1; return rows([sesiAccurate({ userId: opsi.bypass ? "local-dev-admin" : "u-p" })]); }
            return rows([]);
        },
    }) }) });
    Object.defineProperty(db, "transaction", { configurable: true, value: () => { c.transaksi += 1; throw new Error("TIDAK BOLEH menulis DB"); } });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string, init: RequestInit) => {
        c.kiriman.push({ url: String(url), method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify({ s: true, d: [{ s: true, r: { id: 7 } }] }), { status: 200 });
    } });
    try {
        const req = new NextRequest(opsi.bypass ? "http://localhost:3030/api/proxy" : "http://app.test/api/proxy", {
            method: "POST", headers: { "content-type": "application/json", host: opsi.bypass ? "localhost:3030" : "app.test" }, body: JSON.stringify(body),
        });
        const res = await POST(req);
        return { res, json: await res.json() as Record<string, unknown>, c };
    } finally {
        for (const [obj, k, d] of saved) {
            if (d) Object.defineProperty(obj, k, d);
            else delete (obj as unknown as Record<string, unknown>)[k];
        }
        if (env.bypass === undefined) delete process.env.LOCAL_AUTH_BYPASS; else process.env.LOCAL_AUTH_BYPASS = env.bypass;
    }
}

const RETUR = [{ customerNo: "C1", transDate: "01/10/2026", detailItem: [{ itemNo: "I1", quantity: 1 }] }];

test("S7-1b: isAccurateRead — hanya GET ke jalur baca kanonik; save/delete/tak dikenal/varian = tulis", () => {
    for (const p of ["/api/vendor/list.do", "/api/sales-invoice/detail.do", "/api/item/get-stock.do", "/api/item/list-stock.do", "/api/pos/customer/list.do"]) {
        assert.equal(isAccurateRead(p, "GET"), true, p);
        assert.equal(isAccurateRead(p, "get"), true, `${p} (method huruf kecil: kabel mengirim GET)`);
        assert.equal(isAccurateRead(p, "POST"), false, `POST ${p}`);
    }
    for (const p of [
        "/api/sales-return/save.do", "/api/sales-return/bulk-save.do", "/api/purchase-payment/delete.do", "/api/vendor/unknown.do",
        "/api/./x/%62ulk-save.do", "/api/vendor/list.do;jsessionid=x", "/api/VENDOR/LIST.DO", "/api/vendor/List.do", "//api/vendor/list.do",
        "/api//vendor/list.do", "/api/vendor/list.do/", "/api/vendor/list.do?x=1", "/api/vendor/save.do?x=/list.do", "/api/vendor/save.do#/list.do",
        "/api/x/../vendor/list.do", "/api/vendor%2Flist.do", "/api/vendor\\list.do", " /api/vendor/list.do", "/api/vendor/list.do ",
        "/purchase-payment/save.do/api/list.do", "/api/purchase-payment/save.do/list.do", "/api/list.do", "", "vendor/list.do",
    ]) {
        assert.equal(isAccurateRead(p, "GET"), false, `GET ${JSON.stringify(p)} harus tulis`);
    }
});

test("S7-1b PK-3: isCatalogWrite — save/bulk-save katalog Konsol saja, path & method persis", () => {
    for (const p of ["/api/sales-return/bulk-save.do", "/api/purchase-order/save.do", "/api/purchase-return/bulk-save.do", "/api/item/save.do", "/api/customer/bulk-save.do"]) {
        assert.equal(isCatalogWrite(p, "POST"), true, p);
        assert.equal(isCatalogWrite(p, "post"), true, `${p} (method huruf kecil)`);
        assert.equal(isCatalogWrite(p, "GET"), false, `GET ${p}`);
        assert.equal(isCatalogWrite(p, "DELETE"), false, `DELETE ${p}`);
    }
    for (const p of ["/api/purchase-payment/delete.do", "/api/sales-return/delete.do", "/api/vendor/list.do", "/api/x/bulk-save.do", "/api/./sales-return/bulk-save.do",
        "/api//sales-return/bulk-save.do", "/api/SALES-RETURN/BULK-SAVE.DO", "/api/sales-return/bulk%2Dsave.do", "/api/sales-return/bulk-save.do;x", "/api/sales-return/bulk-save.do?x=1"]) {
        assert.equal(isCatalogWrite(p, "POST"), false, p);
    }
});

test("S7-1b: GET baca kanonik tanpa kunci apa pun -> diteruskan (tidak berubah)", async () => {
    for (const endpointPath of ["/api/customer/list.do", "/api/vendor/detail.do", "/api/item/get-stock.do", "/api/item/list-stock.do"]) {
        const { res, c } = await proxySebagai([], { endpointPath, method: "GET", payload: { "sp.pageSize": 1 } });
        assert.equal(res.status, 200, endpointPath);
        assert.equal(c.kiriman.length, 1);
        assert.equal(c.kiriman[0].method, "GET");
        assert.equal(new URL(c.kiriman[0].url).pathname, `/accurate${endpointPath}`);
    }
});

test("S7-1b: POST sales-return/bulk-save.do tanpa api_wrapper.execute -> 403 berkode SEBELUM sesi Accurate, DB, jaringan", async () => {
    for (const keys of [[], ["api_wrapper.view"], ["pelunasan.kirim", "finance.update", "finance.override_duplicate", "order.edit"]]) {
        const { res, json, c } = await proxySebagai(keys, { endpointPath: "/api/sales-return/bulk-save.do", method: "POST", payload: RETUR });
        assert.equal(res.status, 403, keys.join(","));
        assert.deepEqual(json, {
            error: "Tulis ke Accurate lewat Konsol butuh izin Konsol · Eksekusi (api_wrapper.execute). Tidak ada yang dikirim.",
            code: "PERMISSION_REQUIRED", permission: "api_wrapper.execute", sent: false,
        });
        assert.deepEqual([c.sesiDibaca, c.transaksi, c.kiriman.length], [0, 0, 0], "tidak menyentuh sesi Accurate/DB/jaringan");
    }
});

test("S7-1b: dengan api_wrapper.view + execute -> diteruskan (URL + flatten bulk), id pengguna di log", async () => {
    const logs: string[] = [];
    const asli = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
        const { res, json, c } = await proxySebagai(["api_wrapper.view", "api_wrapper.execute"], { endpointPath: "/api/sales-return/bulk-save.do", method: "POST", payload: RETUR });
        assert.equal(res.status, 200);
        assert.deepEqual(json, { s: true, d: [{ s: true, r: { id: 7 } }] });
        assert.equal(c.kiriman.length, 1);
        assert.equal(c.kiriman[0].url, "https://public.accurate.id/accurate/api/sales-return/bulk-save.do");
        assert.equal(c.kiriman[0].method, "POST");
        assert.deepEqual(c.kiriman[0].body, { "data[0].customerNo": "C1", "data[0].transDate": "01/10/2026", "data[0].detailItem[0].itemNo": "I1", "data[0].detailItem[0].quantity": 1 });
        const single = await proxySebagai(["api_wrapper.execute"], { endpointPath: "/api/purchase-order/save.do", method: "POST", payload: { vendorNo: "V1" } });
        assert.equal(single.res.status, 200);
        assert.deepEqual(single.c.kiriman[0].body, { vendorNo: "V1" });
    } finally {
        console.log = asli;
    }
    const fire = logs.filter((l) => l.startsWith("[PROXY FIRE]"));
    assert.deepEqual(fire, ["[PROXY FIRE] POST /api/sales-return/bulk-save.do user=u-p", "[PROXY FIRE] POST /api/purchase-order/save.do user=u-p"]);
});

test("S7-1b: GET save.do / delete.do / tak dikenal / varian path = tulis -> butuh execute; dengan execute di luar katalog = 403 ENDPOINT_TIDAK_DIIZINKAN", async () => {
    const varian: Array<[string, string]> = [
        ["/api/sales-return/save.do", "GET"], ["/api/sales-return/bulk-save.do", "GET"], ["/api/purchase-payment/delete.do", "POST"],
        ["/api/sales-return/delete.do", "GET"], ["/api/vendor/unknown.do", "GET"], ["/api/./x/%62ulk-save.do", "POST"],
        ["/api/SALES-RETURN/BULK-SAVE.DO", "POST"], ["/api/VENDOR/LIST.DO", "GET"],
        ["//api/sales-return//bulk-save.do", "POST"], ["/api//vendor/list.do", "GET"], ["/api/sales-return/bulk-save.do", "PUT"],
    ];
    for (const [endpointPath, method] of varian) {
        const tanpa = await proxySebagai(["api_wrapper.view"], { endpointPath, method, payload: RETUR });
        assert.equal(tanpa.res.status, 403, `${method} ${endpointPath} tanpa execute`);
        assert.equal(tanpa.json.code, "PERMISSION_REQUIRED");
        const dengan = await proxySebagai(["api_wrapper.view", "api_wrapper.execute"], { endpointPath, method, payload: RETUR });
        assert.equal(dengan.res.status, 403, `${method} ${endpointPath} dengan execute`);
        assert.equal(dengan.json.code, "ENDPOINT_TIDAK_DIIZINKAN");
        assert.equal(dengan.json.sent, false);
        for (const r of [tanpa, dengan]) assert.deepEqual([r.c.sesiDibaca, r.c.transaksi, r.c.kiriman.length], [0, 0, 0], `${method} ${endpointPath}`);
    }
    // `;param` (jsessionid) sudah ditolak penjaga purchase-payment (matchesWritePath: setiap ";" = tulis) — lebih awal lagi.
    const sesiJava = await proxySebagai(["api_wrapper.view", "api_wrapper.execute"], { endpointPath: "/api/vendor/list.do;jsessionid=x", method: "GET", payload: {} });
    assert.equal(sesiJava.res.status, 403);
    assert.equal(sesiJava.json.sent, false);
    assert.deepEqual([sesiJava.c.sesiDibaca, sesiJava.c.kiriman.length], [0, 0]);
});

test("S7-1b: cabang sales-receipt tidak berubah — pelunasan.kirim saja tidak dihadang execute; execute saja tetap 403 pelunasan.kirim", async () => {
    const kirim = { endpointPath: "/api/sales-receipt/bulk-save.do", method: "POST", idempotencyLockId: "lock-1", expectedDatabaseId: "DB-1",
        payload: [{ customerNo: "C1", transDate: "01/10/2026", detailInvoice: [{ invoiceNo: "INV-1", paymentAmount: 1000 }] }] };
    const lolos = await proxySebagai(["pelunasan.kirim"], kirim);
    // Melewati izin & sesi sampai penjaga lock (transaksi tiruan melempar = 500, pola pelunasan-server-route butir 2), bukan 403 izin.
    assert.equal(lolos.res.status, 500);
    assert.notEqual(lolos.json.code, "PERMISSION_REQUIRED");
    assert.equal(lolos.c.sesiDibaca, 1, "sesi Accurate dibaca (lolos izin)");
    assert.ok(lolos.c.transaksi >= 1, "sampai ke penjaga lock");
    assert.equal(lolos.c.kiriman.length, 0);
    const exe = await proxySebagai(["api_wrapper.view", "api_wrapper.execute"], kirim);
    assert.equal(exe.res.status, 403);
    assert.equal(exe.json.code, "PERMISSION_REQUIRED");
    assert.match(String(exe.json.error), /pelunasan\.kirim/);
    assert.deepEqual([exe.c.sesiDibaca, exe.c.kiriman.length], [0, 0]);
});

test("S7-1b: purchase-payment & sales-invoice tetap 403 walau memegang api_wrapper.execute", async () => {
    for (const [endpointPath, code] of [["/api/purchase-payment/bulk-save.do", "PURCHASE_PAYMENT_VIA_FINANCE"], ["/api/sales-invoice/save.do", "SALES_INVOICE_VIA_OUTBOX"]]) {
        const { res, json, c } = await proxySebagai(["api_wrapper.view", "api_wrapper.execute", "finance.update", "order.edit"], { endpointPath, method: "POST", payload: [{ x: 1 }] });
        assert.equal(res.status, 403, endpointPath);
        assert.equal(json.code, code);
        assert.equal(json.sent, false);
        assert.deepEqual([c.sesiDibaca, c.kiriman.length], [0, 0]);
    }
});

test("S7-1b: bypass lokal tetap admin (memegang execute) -> tulis katalog diteruskan", async () => {
    const savedNode = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "development";
    try {
        const { res, c } = await proxySebagai([], { endpointPath: "/api/sales-return/bulk-save.do", method: "POST", payload: RETUR }, { bypass: true });
        assert.equal(res.status, 200);
        assert.equal(c.kiriman.length, 1);
    } finally {
        (process.env as Record<string, string | undefined>).NODE_ENV = savedNode;
    }
});

test("S7-1b: Finance [finance.view, finance.update] GET vendor/list.do & glaccount/list.do -> 200 (baca tanpa api_wrapper.*)", async () => {
    for (const endpointPath of ["/api/vendor/list.do", "/api/glaccount/list.do"]) {
        const { res, c } = await proxySebagai(["finance.view", "finance.update"], { endpointPath, method: "GET", payload: { fields: "id,name", "sp.pageSize": 1000, "sp.page": 1 } });
        assert.equal(res.status, 200, endpointPath);
        assert.equal(c.kiriman.length, 1);
    }
});

test("S7-1b PK-3: jalur tulis non-proxy tidak terputus — Antrean Faktur (order.edit) & Finance purchase-payment (finance.update) tidak lewat /api/proxy maupun api_wrapper.*", async () => {
    const { readFileSync } = await import("node:fs");
    const baca = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
    for (const [route, kunci] of [["app/api/invoice-outbox/send/route.ts", "order.edit"], ["app/api/finance/purchase-payment/route.ts", "finance.update"]]) {
        const src = baca(route);
        assert.match(src, new RegExp(`["']${kunci.replace(".", "\.")}["']`), `${route} dijaga ${kunci}`);
        assert.doesNotMatch(src, /api_wrapper|\/api\/proxy/, `${route} tidak bergantung pada kunci/route Konsol`);
    }
    // Klien: kirim Antrean & posting Finance memanggil route command masing-masing; Finance hanya MEMBACA lewat proxy (method GET).
    assert.match(baca("app/(dashboard)/antrean-faktur/Dialog.tsx"), /"\/api\/invoice-outbox\/send"/);
    const posting = baca("app/(dashboard)/finance/posting.ts");
    assert.match(posting, /fetch\("\/api\/finance\/purchase-payment"/);
    assert.match(posting, /JSON\.stringify\(\{ endpointPath, method: "GET"/);
    // Gerbang dinamis Finance (finance.update saja, tanpa api_wrapper.*, lolos izin) = lib/finance-authority-route.test.ts "galat SEBELUM klaim".
});
