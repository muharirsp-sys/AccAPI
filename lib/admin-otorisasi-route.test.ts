/* S7-1 (BL-61/62/63): uji TANPA DB — putusan penjaga (murni), definisi admin (grup vs role lama), gerbang 401/403 semua titik
 * tulis/baca admin, dan validasi 400 sebelum transaksi. Perilaku DB nyata (409 penjaga per celah, atomik, balapan) ada di
 * lib/admin-otorisasi-pg.test.ts. Sesi & db dipalsukan; transaksi DILARANG (403/400 harus terjadi sebelum DB tulis). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { auth } from "./auth.ts";
import { db } from "./db.ts";
import { adminDariBaris, evaluasiPenjaga } from "./rbac/otorisasi.ts";
import * as grup from "../app/api/admin/groups/route.ts";
import * as grupId from "../app/api/admin/groups/[id]/route.ts";
import * as anggota from "../app/api/admin/groups/[id]/members/route.ts";
import * as userGrup from "../app/api/admin/users/[id]/group/route.ts";
import * as daftar from "../app/api/admin/users/permissions/route.ts";
import * as buatUser from "../app/api/admin/users/route.ts";
import * as sandi from "../app/api/admin/users/[id]/password/route.ts";
import * as status from "../app/api/admin/users/[id]/status/route.ts";

type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

/** Sesi palsu (null = tanpa sesi) + kunci grup; db.transaction & db tulis melempar (tidak boleh tersentuh). */
async function sebagai<T>(keys: string[] | null, fn: () => Promise<T>): Promise<T> {
    const saved = (["select", "transaction", "insert", "update", "delete", "execute"] as const).map((k) => [db, k, Object.getOwnPropertyDescriptor(db, k)] as const);
    const savedSes = Object.getOwnPropertyDescriptor(auth.api, "getSession");
    const env = process.env.LOCAL_AUTH_BYPASS;
    delete process.env.LOCAL_AUTH_BYPASS;
    const dilarang = () => { throw new Error("DB tulis/transaksi tidak boleh tersentuh di uji ini"); };
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => (keys ? { user: { id: "u-uji", name: "Uji", role: "admin" }, session: { id: "s" } } : null) });
    const rows = (keys ?? []).map((key) => ({ groupId: "g", key }));
    Object.defineProperty(db, "select", { configurable: true, value: () => ({ from: () => ({ leftJoin: () => ({ where: async () => rows }) }) }) });
    for (const k of ["transaction", "insert", "update", "delete", "execute"]) Object.defineProperty(db, k, { configurable: true, value: dilarang });
    try {
        return await fn();
    } finally {
        for (const [o, k, d] of saved) { if (d) Object.defineProperty(o, k, d); else delete (o as unknown as Record<string, unknown>)[k]; }
        if (savedSes) Object.defineProperty(auth.api, "getSession", savedSes);
        if (env !== undefined) process.env.LOCAL_AUTH_BYPASS = env;
    }
}

const req = (method: string, body?: unknown) => new NextRequest("http://localhost/api/admin/x", {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const ctx = { params: Promise.resolve({ id: "g1" }) };

// Semua titik TULIS admin: users.manage wajib (bukan role lama "admin" — sesi palsu ber-role admin tetap 403).
const TULIS: Array<[string, Handler, string]> = [
    ["POST groups", grup.POST as unknown as Handler, "POST"],
    ["PATCH groups/[id]", grupId.PATCH, "PATCH"],
    ["DELETE groups/[id]", grupId.DELETE, "DELETE"],
    ["POST members", anggota.POST, "POST"],
    ["DELETE members", anggota.DELETE, "DELETE"],
    ["POST users/[id]/group", userGrup.POST, "POST"],
    ["POST users", buatUser.POST as unknown as Handler, "POST"],
    ["POST users/[id]/password", sandi.POST, "POST"],
    ["POST users/[id]/status", status.POST, "POST"],
];

test("penjaga murni: AKSES_SENDIRI, ADMIN_TERAKHIR, aman bila tersisa admin; aktor bukan admin sebelumnya tidak dicek diri", () => {
    const s = (...ids: string[]) => new Set(ids);
    assert.equal(evaluasiPenjaga(s("a", "b"), s("b"), "a")?.code, "AKSES_SENDIRI");
    assert.equal(evaluasiPenjaga(s("a"), s(), "a")?.code, "AKSES_SENDIRI", "aktor terakhir mencabut diri -> pesan diri lebih tepat");
    assert.equal(evaluasiPenjaga(s("a", "b"), s(), "x")?.code, "ADMIN_TERAKHIR");
    assert.equal(evaluasiPenjaga(s("a", "b"), s("a"), "a"), null);
    assert.equal(evaluasiPenjaga(s("a"), s("a", "b"), "a"), null);
    assert.equal(evaluasiPenjaga(s(), s(), "local-dev-admin"), null, "keadaan rusak sebelumnya (0 admin) tidak memblokir");
    assert.equal(evaluasiPenjaga(s("a"), s(), null)?.code, "ADMIN_TERAKHIR");
});

test("definisi admin: punya grup -> hanya kunci grup; tanpa grup -> preset role lama / user.permissions", () => {
    const ids = adminDariBaris([
        { id: "grup-ok", role: "viewer", permissions: "{}", punya_grup: true, grup_kelola: true },
        { id: "grup-tanpa", role: "admin", permissions: "{}", punya_grup: true, grup_kelola: false }, // role lama diabaikan
        { id: "lama-admin", role: "admin", permissions: "{}", punya_grup: false, grup_kelola: false },
        { id: "lama-staff", role: "staff", permissions: "{}", punya_grup: false, grup_kelola: false },
        { id: "lama-kustom", role: "viewer", permissions: JSON.stringify({ users: ["manage"] }), punya_grup: false, grup_kelola: false },
    ]);
    assert.deepEqual([...ids].sort(), ["grup-ok", "lama-admin", "lama-kustom"]);
});

test("401 tanpa sesi, 403 tanpa users.manage (role lama 'admin' + users.view saja) di semua titik tulis — tanpa sentuh DB tulis", async () => {
    for (const [nama, h, method] of TULIS) {
        const tanpa = await sebagai(null, () => h(req(method, { userId: "u2", name: "X", groupId: "g1" }), ctx));
        assert.equal(tanpa.status, 401, `${nama} tanpa sesi`);
        const res = await sebagai(["users.view", "dashboard.view"], () => h(req(method, { userId: "u2", name: "X", groupId: "g1" }), ctx));
        assert.equal(res.status, 403, nama);
    }
});

test("baca daftar user: users.view cukup (D-01 §E), tanpa keduanya 403", async () => {
    const res = await sebagai(["dashboard.view"], () => daftar.GET(req("GET")));
    assert.equal(res.status, 403);
});

test("400 sebelum transaksi: kunci izin tak terdaftar (berkode + daftar), userId kosong, nama grup kosong", async () => {
    const k = await sebagai(["users.manage"], () => grupId.PATCH(req("PATCH", { name: "Baru", permissions: ["finance.view", "finance.nope", 5] }), ctx));
    assert.equal(k.status, 400);
    assert.deepEqual(await k.json(), { ok: false, code: "KUNCI_TIDAK_VALID", error: "Key tidak valid: finance.nope, 5", invalid: ["finance.nope", "5"] });
    for (const h of [anggota.POST, anggota.DELETE]) {
        const r = await sebagai(["users.manage"], () => h(req(h === anggota.POST ? "POST" : "DELETE", { userId: "  " }), ctx));
        assert.equal(r.status, 400);
        assert.equal((await r.json() as { code: string }).code, "INPUT_TIDAK_VALID");
    }
    const n = await sebagai(["users.manage"], () => grup.POST(req("POST", { name: " " })));
    assert.equal(n.status, 400);
    const kosong = await sebagai(["users.manage"], () => grupId.PATCH(req("PATCH", { name: "  " }), ctx));
    assert.equal(kosong.status, 400);
});

test("plugin admin Better Auth ditutup dari browser: SEMUA endpoint /admin/* plugin -> HTTP 404 (cocok persis, juga ?query)", async () => {
    const api = auth.api as unknown as Record<string, { path?: string; options?: { method?: string | string[] } }>;
    const admin = Object.values(api).filter((e) => typeof e?.path === "string" && e.path.startsWith("/admin/"));
    assert.ok(admin.length >= 15, `endpoint plugin admin terdeteksi: ${admin.length}`);
    const tertutup = new Set((auth.options as { disabledPaths?: string[] }).disabledPaths ?? []);
    for (const e of admin) {
        assert.ok(tertutup.has(e.path!), `${e.path} belum ada di disabledPaths`);
        const method = [e.options?.method ?? "POST"].flat()[0] === "GET" ? "GET" : "POST";
        for (const q of ["", "?userId=x"]) {
            const res = await auth.handler(new Request(`http://localhost:3000/api/auth${e.path}${q}`, {
                method, headers: { "content-type": "application/json", origin: "http://localhost:3000" }, ...(method === "POST" ? { body: "{}" } : {}),
            }));
            assert.equal(res.status, 404, `${method} ${e.path}${q}`);
        }
    }
    // Kontrol: endpoint bukan admin tetap hidup (tanpa sesi -> 200 null, bukan 404).
    const ses = await auth.handler(new Request("http://localhost:3000/api/auth/get-session", { headers: { origin: "http://localhost:3000" } }));
    assert.notEqual(ses.status, 404);
});
