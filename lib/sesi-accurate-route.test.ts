/* S7-sesi / AM-033: route ASLI masuk Accurate (`/api/auth/accurate-login`) dan callback (`/api/auth/callback`) tanpa jaringan/DB nyata.
 * Sesi app, tabel sesi Accurate, dan tukar token dipalsukan. Cookie state diambil dari Set-Cookie route login (pulang-pergi nyata),
 * lalu dikirim ke callback. Juga: gerbang halaman "salah satu kunci" /sesi-accurate dan route sesi yang cukup sesi app. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET as loginGet } from "../app/api/auth/accurate-login/route.ts";
import { GET as callbackGet } from "../app/api/auth/callback/route.ts";
import { GET as sesiGet } from "../app/api/auth/accurate-session/route.ts";
import { GET as dbListGet } from "../app/api/auth/db-list/route.ts";
import * as openDbRoute from "../app/api/auth/open-db/route.ts";
import { upsertAccurateSession } from "./accurate-session.ts";
import { ACCURATE_SCOPE, STATE_COOKIE, kabarAccurate, returnToAman } from "./accurate-oauth.ts";
import { SESI_ACCURATE_KEYS, canAccessPathWithKeys } from "./rbac.ts";
import { auth } from "./auth.ts";
import { db } from "./db.ts";

const RAHASIA = "TOKEN-RAHASIA-JANGAN-DICETAK";
type Catatan = { fetch: Array<{ url: string; body: string }>; insert: unknown[]; update: unknown[]; log: string };
type Opsi = { sesiApp?: boolean | "lempar"; fetch?: (url: string) => Promise<Response>; sesiRow?: Record<string, unknown> };

const ENV = { BETTER_AUTH_URL: "https://app.test", ACCURATE_CLIENT_ID: "cid", ACCURATE_CLIENT_SECRET: "csecret",
    NEXT_PUBLIC_ACCURATE_REDIRECT_URI: "https://app.test/api/auth/callback", ACCURATE_TOKEN_ENCRYPTION_KEY: "kunci-uji", NEXT_PUBLIC_ACCURATE_CLIENT_ID: undefined,
    LOCAL_AUTH_BYPASS: undefined } as Record<string, string | undefined>;

/** Jalankan `fn` dengan env uji, sesi app (opsional), DB palsu (tanpa sesi Accurate lama; insert dicatat), fetch palsu, console.error dicatat. */
async function dengan<T>(opsi: Opsi, fn: (c: Catatan) => Promise<T>): Promise<T> {
    const c: Catatan = { fetch: [], insert: [], update: [], log: "" };
    const simpanEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(ENV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    const saved = [
        [auth.api, "getSession", Object.getOwnPropertyDescriptor(auth.api, "getSession")],
        [db, "select", Object.getOwnPropertyDescriptor(db, "select")],
        [db, "insert", Object.getOwnPropertyDescriptor(db, "insert")],
        [db, "update", Object.getOwnPropertyDescriptor(db, "update")],
        [globalThis, "fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch")],
        [console, "error", Object.getOwnPropertyDescriptor(console, "error")],
    ] as const;
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => {
        if (opsi.sesiApp === "lempar") throw new Error(`koneksi DB putus ${RAHASIA}`);
        return opsi.sesiApp === false ? null : { user: { id: "u-fakturist", role: "staff" }, session: { id: "s1" } };
    } });
    Object.defineProperty(db, "select", { configurable: true, value: () => ({ from: () => ({ where: () => ({ limit: async () => (opsi.sesiRow ? [opsi.sesiRow] : []) }) }) }) });
    Object.defineProperty(db, "insert", { configurable: true, value: () => ({ values: async (v: unknown) => { c.insert.push(v); } }) });
    Object.defineProperty(db, "update", { configurable: true, value: () => ({ set: (v: unknown) => ({ where: async () => { c.update.push(v); } }) }) });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string | URL, init?: RequestInit) => {
        c.fetch.push({ url: String(url), body: String(init?.body ?? "") });
        if (!opsi.fetch) throw new Error("TIDAK BOLEH ke jaringan");
        return opsi.fetch(String(url));
    } });
    Object.defineProperty(console, "error", { configurable: true, value: (...a: unknown[]) => { c.log += `${a.map(String).join(" ")}\n`; } });
    try {
        return await fn(c);
    } finally {
        for (const [obj, k, d] of saved) {
            if (d) Object.defineProperty(obj, k, d);
            else delete (obj as unknown as Record<string, unknown>)[k];
        }
        for (const [k, v] of Object.entries(simpanEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
}

/** Mulai masuk lewat route login → { state, cookie (pasangan nama=nilai seperti dikirim peramban), setCookie, location }. */
async function mulai(returnTo: string) {
    const res = await loginGet(new Request(`https://app.test/api/auth/accurate-login?returnTo=${encodeURIComponent(returnTo)}`));
    const setCookie = res.headers.get("set-cookie") ?? "";
    const location = res.headers.get("location") ?? "";
    const state = new URL(location).searchParams.get("state") ?? "";
    return { res, setCookie, location, state, cookie: setCookie.split(";")[0] };
}

const panggil = (query: string, cookie?: string) => callbackGet(new NextRequest(`https://app.test/api/auth/callback?${query}`, { headers: cookie ? { cookie } : {} }));
const tokenOk = async () => new Response(JSON.stringify({ access_token: RAHASIA, token_type: "bearer" }), { status: 200 });
const lokasi = (res: Response) => {
    const u = new URL(res.headers.get("location") ?? "");
    return `${u.origin}${u.pathname}?${u.searchParams.toString()}`;
};
const cookieDihapus = (res: Response) => /accurate_oauth_state=;.*Max-Age=0/i.test(res.headers.get("set-cookie") ?? "");
const openDbPost = openDbRoute.POST;

test("login: URL authorize membawa state acak + scope tetap; cookie httpOnly/Secure/Lax/10 menit hanya ke callback", async () => {
    await dengan({}, async (c) => {
        const a = await mulai("/pelunasan");
        const b = await mulai("/pelunasan");
        const u = new URL(a.location);
        assert.equal(`${u.origin}${u.pathname}`, "https://account.accurate.id/oauth/authorize");
        assert.equal(u.searchParams.get("client_id"), "cid");
        assert.equal(u.searchParams.get("redirect_uri"), "https://app.test/api/auth/callback");
        assert.equal(u.searchParams.get("response_type"), "code");
        assert.equal(u.searchParams.get("scope"), ACCURATE_SCOPE);
        assert.ok(a.state.length >= 40, "state minimal 32 byte acak");
        assert.notEqual(a.state, b.state, "state tiap permintaan berbeda");
        assert.equal(decodeURIComponent(a.cookie), `${STATE_COOKIE}=${a.state}:/pelunasan`);
        for (const attr of [/HttpOnly/i, /Secure/i, /SameSite=lax/i, /Max-Age=600/i, /Path=\/api\/auth\/callback/i]) assert.match(a.setCookie, attr);
        assert.equal(c.fetch.length, 0, "login tidak memanggil Accurate");
    });
});

test("login: returnTo di luar daftar putih → bawaan /sesi-accurate; tanpa konfigurasi → galat berkode tanpa cookie", async () => {
    await dengan({}, async () => {
        for (const jahat of ["https://evil.example/x", "//evil.example", "/pelunasan?x=1", "/admin/users", ""]) {
            const a = await mulai(jahat);
            assert.equal(decodeURIComponent(a.cookie), `${STATE_COOKIE}=${a.state}:/sesi-accurate`, jahat);
        }
        delete process.env.ACCURATE_CLIENT_ID;
        const res = await loginGet(new Request("https://app.test/api/auth/accurate-login?returnTo=/api-wrapper"));
        assert.equal(lokasi(res), "https://app.test/api-wrapper?accurate=error&alasan=konfigurasi");
        assert.equal(res.headers.get("set-cookie"), null);
    });
});

test("callback: state benar → tukar code (sekali) → simpan sesi → mendarat di halaman berkartu; cookie dihapus", async () => {
    await dengan({ fetch: tokenOk }, async (c) => {
        const a = await mulai("/api-wrapper");
        const res = await panggil(`code=KODE-1&state=${a.state}`, a.cookie);
        assert.equal(lokasi(res), "https://app.test/api-wrapper?accurate=connected");
        assert.ok(cookieDihapus(res));
        assert.equal(c.fetch.length, 1);
        assert.equal(c.fetch[0].url, "https://account.accurate.id/oauth/token");
        assert.match(c.fetch[0].body, /code=KODE-1/);
        assert.equal(c.insert.length, 1);
        const row = c.insert[0] as { userId: string; accessToken: string; databaseId: unknown };
        assert.equal(row.userId, "u-fakturist");
        assert.ok(!row.accessToken.includes(RAHASIA), "token disimpan terenkripsi");
        assert.equal(row.databaseId, null);
        assert.ok(!c.log.includes(RAHASIA));

        // Tujuan selain Konsol mendarat di /sesi-accurate (pilih database dulu), returnTo diteruskan untuk tombol Kembali.
        const p = await mulai("/pelunasan");
        assert.equal(lokasi(await panggil(`code=KODE-2&state=${p.state}`, p.cookie)), "https://app.test/sesi-accurate?accurate=connected&returnTo=%2Fpelunasan");
        const s = await mulai("/sesi-accurate");
        assert.equal(lokasi(await panggil(`code=KODE-3&state=${s.state}`, s.cookie)), "https://app.test/sesi-accurate?accurate=connected");
    });
});

test("callback: state hilang/beda → code TIDAK ditukar, galat berkode; state beda TIDAK menghapus cookie", async () => {
    await dengan({ fetch: tokenOk }, async (c) => {
        const a = await mulai("/api-wrapper");
        const tanpaCookie = await panggil(`code=K&state=${a.state}`);
        assert.equal(lokasi(tanpaCookie), "https://app.test/sesi-accurate?accurate=error&alasan=state_hilang");
        assert.ok(cookieDihapus(tanpaCookie));
        const beda = await panggil(`code=K&state=${a.state}x`, a.cookie);
        assert.equal(lokasi(beda), "https://app.test/api-wrapper?accurate=error&alasan=state_beda");
        assert.ok(!cookieDihapus(beda) && beda.headers.get("set-cookie") === null, "state_beda tidak membatalkan masuk yang sedang berjalan");
        assert.equal(lokasi(await panggil("code=K", a.cookie)), "https://app.test/api-wrapper?accurate=error&alasan=state_beda");
        const b = await mulai("/api-wrapper");
        assert.equal(lokasi(await panggil(`code=K&state=${a.state}`, b.cookie)), "https://app.test/api-wrapper?accurate=error&alasan=state_beda", "state permintaan lain");
        assert.equal(c.fetch.length, 0, "code tidak boleh ditukar");
        assert.equal(c.insert.length, 0);
    });
});

test("callback: returnTo cookie di luar daftar putih → bawaan /sesi-accurate", async () => {
    await dengan({ fetch: tokenOk }, async () => {
        for (const jahat of ["https://evil.example", "//evil.example", "/admin/users"]) {
            const cookie = `${STATE_COOKIE}=${encodeURIComponent(`abc:${jahat}`)}`;
            assert.equal(lokasi(await panggil("code=K&state=abc", cookie)), "https://app.test/sesi-accurate?accurate=connected", jahat);
        }
    });
});

test("callback: tanpa sesi app → /login dengan nilai lama (dibaca S7c), tanpa tukar code", async () => {
    const a = await dengan({}, async () => mulai("/pelunasan")); // sesi app berakhir SESUDAH masuk dimulai
    await dengan({ sesiApp: false, fetch: tokenOk }, async (c) => {
        const res = await panggil(`code=K&state=${a.state}`, a.cookie);
        const u = new URL(res.headers.get("location") ?? "");
        assert.equal(u.pathname, "/login");
        assert.equal(u.searchParams.get("error"), "Accurate login requires app session");
        assert.ok(cookieDihapus(res));
        assert.equal(c.fetch.length, 0);
    });
});

test("callback: tanpa code / konfigurasi kurang / tukar token gagal / exception → kode tetap, log tanpa token & isi Accurate", async () => {
    await dengan({ fetch: async () => new Response(`{"error":"invalid_grant","echo":"${RAHASIA}"}`, { status: 400 }) }, async (c) => {
        const a = await mulai("/finance");
        assert.equal(lokasi(await panggil(`state=${a.state}&error=access_denied`, a.cookie)), "https://app.test/sesi-accurate?accurate=error&alasan=tanpa_kode&returnTo=%2Ffinance");
        assert.equal(lokasi(await panggil(`code=K&state=${a.state}`, a.cookie)), "https://app.test/sesi-accurate?accurate=error&alasan=tukar_token_gagal&returnTo=%2Ffinance");
        assert.match(c.log, /HTTP 400/);
        assert.ok(!c.log.includes(RAHASIA) && !c.log.includes("invalid_grant"), "isi jawaban Accurate tidak dicetak");
        assert.equal(c.insert.length, 0);
        delete process.env.ACCURATE_CLIENT_SECRET;
        assert.equal(lokasi(await panggil(`code=K&state=${a.state}`, a.cookie)), "https://app.test/sesi-accurate?accurate=error&alasan=konfigurasi&returnTo=%2Ffinance");
    });
    await dengan({ fetch: async () => { throw new Error(`koneksi putus ${RAHASIA}`); } }, async (c) => {
        const a = await mulai("/api-wrapper");
        assert.equal(lokasi(await panggil(`code=K&state=${a.state}`, a.cookie)), "https://app.test/api-wrapper?accurate=error&alasan=galat_server");
        assert.ok(!c.log.includes(RAHASIA));
    });
    await dengan({ fetch: async () => new Response(`bukan json ${RAHASIA}`, { status: 200 }) }, async (c) => {
        const a = await mulai("/api-wrapper");
        assert.equal(lokasi(await panggil(`code=K&state=${a.state}`, a.cookie)), "https://app.test/api-wrapper?accurate=error&alasan=tukar_token_gagal");
        assert.ok(!c.log.includes(RAHASIA));
        assert.equal(c.insert.length, 0);
    });
});

test("kabar: kode → kalimat tetap; kode tak dikenal tidak menampilkan teks query", () => {
    assert.equal(kabarAccurate("connected", null)?.tone, "pos");
    assert.match(kabarAccurate("error", "state_hilang")?.text ?? "", /kedaluwarsa/);
    const asing = kabarAccurate("error", "<script>teks bebas</script>");
    assert.equal(asing?.tone, "neg");
    assert.ok(!(asing?.text ?? "").includes("teks bebas"));
    assert.ok(!(kabarAccurate("error", "toString")?.text ?? "").includes("function"), "properti prototipe bukan kode");
    assert.equal(kabarAccurate(null, null), null);
    assert.equal(returnToAman("/antrean-faktur"), "/antrean-faktur");
    assert.equal(returnToAman(["/pelunasan"]), "/sesi-accurate");
});

test("gerbang halaman /sesi-accurate: salah satu dari 5 kunci; kunci lain ditolak; halaman lain tidak berubah", () => {
    assert.deepEqual([...SESI_ACCURATE_KEYS], ["api_wrapper.view", "order.edit", "pelunasan.kirim", "finance.update", "finance.resolve_unknown"]);
    for (const key of SESI_ACCURATE_KEYS) assert.ok(canAccessPathWithKeys("/sesi-accurate", [key]), key);
    assert.ok(!canAccessPathWithKeys("/sesi-accurate", []));
    assert.ok(!canAccessPathWithKeys("/sesi-accurate", ["order.view", "finance.view", "api_wrapper.execute", "dashboard.view", "finance.post_accurate"]));
    // Konsol TIDAK ikut terbuka oleh kunci kirim (owner Q2: Fakturist/Admin Incaso tanpa api_wrapper.view).
    for (const key of ["order.edit", "pelunasan.kirim", "finance.update", "finance.resolve_unknown"]) assert.ok(!canAccessPathWithKeys("/api-wrapper", [key]), key);
    assert.ok(canAccessPathWithKeys("/api-wrapper", ["api_wrapper.view"]));
});

test("route sesi cukup sesi app (pemegang order.edit saja tidak 403); tanpa sesi 401", async () => {
    await dengan({}, async () => {
        const res = await sesiGet(new NextRequest("https://app.test/api/auth/accurate-session"));
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, connected: false, databaseConnected: false, sessionHost: null, databaseId: null, databaseAlias: null });
    });
    await dengan({ sesiApp: false }, async () => {
        assert.equal((await sesiGet(new NextRequest("https://app.test/api/auth/accurate-session"))).status, 401);
    });
});

/** Baris accurate_oauth_session terenkripsi (dibuat lewat upsert asli) berisi token RAHASIA. */
async function barisSesi() {
    return dengan({}, async (c) => {
        await upsertAccurateSession("u-fakturist", { accessToken: RAHASIA, sessionHost: null, sessionId: null, databaseId: null, databaseAlias: null });
        return c.insert[0] as Record<string, unknown>;
    });
}
const tanpaRahasia = (teks: string) => !teks.includes(RAHASIA) && !teks.includes("pesan-accurate");

test("db-list: galat Accurate/exception → kode tetap + kalimat netral; isi jawaban & pesan tidak ke peramban/log", async () => {
    const sesiRow = await barisSesi();
    const kasus: Array<[(url: string) => Promise<Response>, number, string]> = [
        [async () => new Response(`{"error":"pesan-accurate ${RAHASIA}"}`, { status: 401 }), 502, "ACCURATE_MENOLAK"],
        [async () => new Response(JSON.stringify({ s: false, d: [`pesan-accurate ${RAHASIA}`] }), { status: 200 }), 502, "ACCURATE_MENOLAK"],
        [async () => { throw new Error(`pesan-accurate ${RAHASIA}`); }, 500, "GALAT_SERVER"],
    ];
    for (const [fetch, status, code] of kasus) {
        await dengan({ sesiRow, fetch }, async (c) => {
            const res = await dbListGet(new NextRequest("https://app.test/api/auth/db-list"));
            const teks = await res.text();
            assert.equal(res.status, status);
            assert.equal(JSON.parse(teks).code, code);
            assert.ok(tanpaRahasia(teks), teks);
            assert.ok(tanpaRahasia(c.log), c.log);
        });
    }
    await dengan({ sesiRow, fetch: async () => new Response(JSON.stringify({ s: true, d: [{ id: 77, alias: "PT CONTOH" }] }), { status: 200 }) }, async () => {
        const res = await dbListGet(new NextRequest("https://app.test/api/auth/db-list"));
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { s: true, d: [{ id: 77, alias: "PT CONTOH" }] });
    });
    await dengan({}, async (c) => {
        const res = await dbListGet(new NextRequest("https://app.test/api/auth/db-list"));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).code, "SESI_BELUM_TERHUBUNG");
        assert.equal(c.fetch.length, 0);
    });
});

test("open-db: galat Accurate/exception → kode tetap tanpa isi mentah, sesi tidak diubah; sukses menyimpan database", async () => {
    const sesiRow = await barisSesi();
    const buka = (body: unknown) => openDbPost(new NextRequest("https://app.test/api/auth/open-db", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const kasus: Array<[(url: string) => Promise<Response>, number, string]> = [
        [async () => new Response(`pesan-accurate ${RAHASIA}`, { status: 403 }), 502, "ACCURATE_MENOLAK"],
        [async () => new Response(JSON.stringify({ s: false, d: [`pesan-accurate ${RAHASIA}`] }), { status: 200 }), 502, "ACCURATE_MENOLAK"],
        [async () => { throw new Error(`pesan-accurate ${RAHASIA}`); }, 500, "GALAT_SERVER"],
    ];
    for (const [fetch, status, code] of kasus) {
        await dengan({ sesiRow, fetch }, async (c) => {
            const res = await buka({ id: "77", alias: "PT CONTOH" });
            const teks = await res.text();
            assert.equal(res.status, status);
            assert.equal(JSON.parse(teks).code, code);
            assert.ok(tanpaRahasia(teks), teks);
            assert.ok(tanpaRahasia(c.log), c.log);
            assert.equal(c.update.length + c.insert.length, 0, "sesi tidak berubah");
        });
    }
    await dengan({ sesiRow, fetch: async () => new Response(JSON.stringify({ s: true, host: "https://contoh.accurate.id", session: "sesi-db" }), { status: 200 }) }, async (c) => {
        const res = await buka({ id: "77", alias: "PT CONTOH" });
        assert.equal(res.status, 200);
        assert.match(c.fetch[0].url, /open-db\.do\?id=77$/);
        const v = c.update[0] as { databaseId: string; databaseAlias: string; sessionHost: string };
        assert.deepEqual([v.databaseId, v.databaseAlias, v.sessionHost], ["77", "PT CONTOH", "https://contoh.accurate.id"]);
    });
    await dengan({ sesiRow }, async (c) => {
        const res = await buka({});
        assert.equal(res.status, 400);
        assert.equal((await res.json()).code, "DATABASE_ID_KOSONG");
        assert.equal(c.fetch.length, 0);
    });
});

test("login: wajib sesi app, tolak navigasi lintas situs, baca sesi gagal = galat berkode (tanpa cookie)", async () => {
    await dengan({}, async () => {
        const lintas = await loginGet(new Request("https://app.test/api/auth/accurate-login?returnTo=/pelunasan", { headers: { "sec-fetch-site": "cross-site" } }));
        assert.equal(lokasi(lintas), "https://app.test/sesi-accurate?accurate=error&alasan=lintas_situs&returnTo=%2Fpelunasan");
        assert.equal(lintas.headers.get("set-cookie"), null);
        const sama = await loginGet(new Request("https://app.test/api/auth/accurate-login?returnTo=/pelunasan", { headers: { "sec-fetch-site": "same-origin" } }));
        assert.match(sama.headers.get("location") ?? "", /^https:\/\/account\.accurate\.id\/oauth\/authorize\?/);
        assert.match(sama.headers.get("set-cookie") ?? "", /^__Secure-accurate_oauth_state=/);
    });
    await dengan({ sesiApp: false }, async () => {
        const res = await loginGet(new Request("https://app.test/api/auth/accurate-login?returnTo=/pelunasan"));
        const u = new URL(res.headers.get("location") ?? "");
        assert.equal(u.pathname, "/login");
        assert.equal(u.searchParams.get("error"), "Accurate login requires app session");
        assert.equal(res.headers.get("set-cookie"), null);
    });
    await dengan({ sesiApp: "lempar" }, async (c) => {
        const res = await loginGet(new Request("https://app.test/api/auth/accurate-login?returnTo=/api-wrapper"));
        assert.equal(lokasi(res), "https://app.test/api-wrapper?accurate=error&alasan=galat_server");
        assert.ok(!c.log.includes(RAHASIA));
    });
});

test("callback: baca sesi app melempar → galat_server berkode (bukan 500), cookie dihapus, code tidak ditukar", async () => {
    const a = await dengan({}, async () => mulai("/api-wrapper"));
    await dengan({ sesiApp: "lempar", fetch: tokenOk }, async (c) => {
        const res = await panggil(`code=K&state=${a.state}`, a.cookie);
        assert.equal(res.status, 307);
        assert.equal(lokasi(res), "https://app.test/api-wrapper?accurate=error&alasan=galat_server");
        assert.ok(cookieDihapus(res));
        assert.equal(c.fetch.length, 0);
        assert.ok(!c.log.includes(RAHASIA));
    });
});

test("open-db: hanya POST; jawaban sukses tidak membawa session Accurate", async () => {
    assert.ok(!("GET" in openDbRoute), "handler GET open-db harus tidak ada");
    const sesiRow = await barisSesi();
    await dengan({ sesiRow, fetch: async () => new Response(JSON.stringify({ s: true, host: "https://contoh.accurate.id", session: "SESI-DB-RAHASIA" }), { status: 200 }) }, async () => {
        const res = await openDbPost(new NextRequest("https://app.test/api/auth/open-db", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "77", alias: "PT CONTOH" }) }));
        const teks = await res.text();
        assert.equal(res.status, 200);
        assert.ok(!teks.includes("SESI-DB-RAHASIA"), teks);
        assert.deepEqual(JSON.parse(teks), { ok: true, databaseId: "77", databaseAlias: "PT CONTOH", host: "https://contoh.accurate.id" });
    });
});
