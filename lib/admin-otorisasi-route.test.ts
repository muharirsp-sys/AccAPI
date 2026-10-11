/* S7-1 (BL-61/62/63): uji TANPA DB — putusan penjaga (murni), definisi admin (grup vs role lama), gerbang 401/403 semua titik
 * tulis/baca admin, dan validasi 400 sebelum transaksi. Perilaku DB nyata (409 penjaga per celah, atomik, balapan) ada di
 * lib/admin-otorisasi-pg.test.ts. Sesi & db dipalsukan; transaksi DILARANG (403/400 harus terjadi sebelum DB tulis). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { auth } from "./auth.ts";
import { db } from "./db.ts";
import { adminDariBaris, evaluasiPenjaga, jawabGalat, pilihUtama, roleSisa, roleTurunan, type GrupUser } from "./rbac/otorisasi.ts";
import * as grup from "../app/api/admin/groups/route.ts";
import * as grupId from "../app/api/admin/groups/[id]/route.ts";
import * as anggota from "../app/api/admin/groups/[id]/members/route.ts";
import * as userGrup from "../app/api/admin/users/[id]/group/route.ts";
import * as daftar from "../app/api/admin/users/permissions/route.ts";
import * as buatUser from "../app/api/admin/users/route.ts";
import * as sandi from "../app/api/admin/users/[id]/password/route.ts";
import * as status from "../app/api/admin/users/[id]/status/route.ts";
import * as bintang from "../app/api/admin/users/[id]/primary-group/route.ts";
import * as riwayatUser from "../app/api/admin/users/[id]/history/route.ts";
import * as riwayatGrup from "../app/api/admin/groups/[id]/history/route.ts";
import { bacaKursor, kodeKursor } from "./rbac/riwayat.ts";

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
    ["PUT users/[id]/primary-group", bintang.PUT, "PUT"],
    ["DELETE users/[id]/primary-group", bintang.DELETE, "DELETE"],
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

const g = (groupId: string, name: string, isPreset: boolean, isPrimary = false): GrupUser => ({ groupId, name, isPreset, isPrimary });

test("BL-63 grup utama efektif: bintang; tanpa bintang + tepat 1 grup -> grup itu; >1 grup tanpa bintang -> null", () => {
    assert.equal(pilihUtama([]), null);
    assert.equal(pilihUtama([g("a", "A", false)])?.groupId, "a");
    assert.equal(pilihUtama([g("a", "A", false), g("b", "B", false)]), null);
    assert.equal(pilihUtama([g("a", "A", false), g("b", "B", false, true)])?.groupId, "b");
});

test("BL-63 role turunan: hanya saat utama berubah; preset berpeta -> peta; custom tidak mengubah; role turunan utama lama -> viewer", () => {
    const adm = g("ga", "Admin", true), mgr = g("gm", "Manager", true), cus = g("gc", "Promo Kino", false), fak = g("gf", "Fakturist", true);
    const palsu = g("gx", "Admin", false); // custom bernama "Admin" (tanpa preset) TIDAK menurunkan role
    assert.equal(roleTurunan(null, mgr, "viewer"), "manager");
    assert.equal(roleTurunan(cus, adm, "staff"), "admin");
    assert.equal(roleTurunan(mgr, mgr, "admin"), null, "utama tidak berubah -> role tidak disentuh");
    assert.equal(roleTurunan(null, cus, "staff"), null, "custom tidak mengubah role");
    assert.equal(roleTurunan(mgr, cus, "staff"), null, "role bukan turunan utama lama -> tetap");
    assert.equal(roleTurunan(adm, cus, "admin"), "viewer", "admin tidak tertinggal sesudah keluar dari grup Admin");
    assert.equal(roleTurunan(adm, null, "admin"), "viewer");
    assert.equal(roleTurunan(mgr, fak, "manager"), "viewer", "preset tanpa peta = tanpa role turunan");
    assert.equal(roleTurunan(null, palsu, "viewer"), null);
    assert.equal(roleTurunan(null, mgr, "manager"), null, "sudah sama -> tanpa tulis");
});

test("role sisa (tinjauan A #1): role = peta grup preset yang DITINGGALKAN dan tak ada lagi preset ber-peta itu -> viewer; lainnya tetap", () => {
    const adm = g("ga", "Admin", true), mgr = g("gm", "Manager", true), cus = g("gc", "Promo", false), palsu = g("gx", "Admin", false);
    assert.equal(roleSisa([adm, mgr, cus], [mgr, cus], "admin"), "viewer");
    assert.equal(roleSisa([adm, mgr], [adm], "admin"), null, "masih anggota Admin");
    assert.equal(roleSisa([cus], [cus, mgr], "staff"), null, "role lama tanpa asal preset tidak disentuh");
    assert.equal(roleSisa([palsu, cus], [cus], "admin"), null, "custom bernama Admin bukan asal role");
    assert.equal(roleSisa([adm], [], "viewer"), null);
});

test("23505 dikenal -> 409 berkode (BINTANG_BENTROK / NAMA_GRUP_TERPAKAI / EMAIL_TERPAKAI); lainnya 500 GAGAL_SIMPAN tanpa parameter kueri di log", async () => {
    const pg = (constraint: string) => Object.assign(new Error("Failed query: ... params: rahasia"), { cause: { code: "23505", constraint } });
    for (const [c, code] of [["uq_user_group_primary", "BINTANG_BENTROK"], ["access_group_name_unique", "NAMA_GRUP_TERPAKAI"], ["user_email_unique", "EMAIL_TERPAKAI"]]) {
        const r = jawabGalat(pg(c));
        assert.equal(r.status, 409);
        assert.equal((await r.json() as { code: string }).code, code);
    }
    const asli = console.error;
    const log: string[] = [];
    console.error = (...a: unknown[]) => { log.push(a.map(String).join(" ")); };
    try {
        const r = jawabGalat(new Error("Failed query: UPDATE account SET password = $1 params: hash-rahasia"));
        assert.equal(r.status, 500);
        assert.equal((await r.json() as { code: string }).code, "GAGAL_SIMPAN");
    } finally { console.error = asli; }
    assert.ok(!log.join(" ").includes("rahasia"), log.join(" "));
});

test("riwayat: 403 tanpa users.manage/users.view; 400 limit/cursor rusak SEBELUM DB; kursor bolak-balik presisi mikrodetik", async () => {
    const get = (qs: string) => new NextRequest(`http://localhost/api/admin/users/u1/history${qs}`);
    for (const h of [riwayatUser.GET, riwayatGrup.GET]) {
        assert.equal((await sebagai(["dashboard.view", "users.create_user"], () => h(get(""), ctx))).status, 403);
        for (const qs of ["?limit=0", "?limit=201", "?limit=abc", "?cursor=rusak", `?cursor=${Buffer.from("2026-10-11 01:02:03|x").toString("base64url")}`]) {
            const r = await sebagai(["users.view"], () => h(get(qs), ctx));
            assert.equal(r.status, 400, qs);
            assert.equal((await r.json() as { code: string }).code, "INPUT_TIDAK_VALID");
        }
    }
    const k = kodeKursor("2026-10-11T01:02:03.123456", "id|x");
    assert.equal(bacaKursor(k), null, "id dengan '|' ditolak (kursor ambigu)");
    assert.deepEqual(bacaKursor(kodeKursor("2026-10-11T01:02:03.123456", "abc")), { ts: "2026-10-11T01:02:03.123456", id: "abc" });
});

test("preset BL-37 SQL (statis): kunci = PERSIS D-01 §B di kedua blok, semua terdaftar di registry, tanpa kunci terlarang; grup lama tidak disentuh", async () => {
    const { readFileSync } = await import("node:fs");
    const { isValidPermissionKey } = await import("./rbac/registry.ts");
    const sql = readFileSync(new URL("../docs/handover/RBAC_PRESET_BL37.sql", import.meta.url), "utf8").replace(/--.*$/gm, "");
    const blok = [...sql.matchAll(/WITH isi\(grup, kunci\) AS \(VALUES([\s\S]*?)\n\)/g)].map((m) => [...m[1].matchAll(/\('([^']+)', '([^']+)'\)/g)].map((x) => `${x[1]}|${x[2]}`).sort());
    assert.equal(blok.length, 2, "blok isi + blok verifikasi");
    assert.deepEqual(blok[0], blok[1], "blok verifikasi = blok isi");
    const D01: Record<string, string[]> = {
        Fakturist: ["dashboard.view", "order.view", "order.create", "order.edit", "order.export", "sales_history.view", "principles.view"],
        "Admin Incaso": ["dashboard.view", "pelunasan.kirim", "sales_history.view"],
        Kasir: ["dashboard.view"],
        "Admin Gudang": ["dashboard.view", "rekapan_nota.view", "rekapan_nota.manage", "rekapan_nota.print", "rekapan_nota.approve_takeout", "order.view"],
    };
    assert.deepEqual(blok[0], Object.entries(D01).flatMap(([g, ks]) => ks.map((k) => `${g}|${k}`)).sort());
    for (const x of blok[0]) {
        const k = x.split("|")[1];
        assert.ok(isValidPermissionKey(k), k);
        assert.ok(!/^(users\.|api_wrapper\.)|^(finance\.resolve_unknown|finance\.override_duplicate|order\.resolve_unknown)$/.test(k), `kunci terlarang ${k}`);
    }
    assert.match(sql, /ON CONFLICT \(name\) DO NOTHING\s+RETURNING id, name/);
    assert.match(sql, /SELECT baru\.id, isi\.kunci FROM baru JOIN isi/, "izin hanya untuk grup yang BARU dibuat");
    assert.doesNotMatch(sql, /\b(UPDATE|DELETE)\b/i);
});

test("layar S7a (User & Akses Group): tanpa dialog native, tanpa /api/auth/admin (plugin ditutup), tanpa route lama users/[id]/group", async () => {
    const { readFileSync } = await import("node:fs");
    const baca = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
    // Komentar dibuang dulu: kepala berkas boleh menyebut window.prompt (yang digantikan), kode tidak.
    const layar = ["../app/(dashboard)/admin/users/Pengguna.tsx", "../app/(dashboard)/admin/groups/AksesGrup.tsx", "../components/admin/Bersama.tsx"]
        .map((p) => baca(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")).join("\n");
    assert.doesNotMatch(layar, /window\.(prompt|confirm|alert)|(?<![.\w])(prompt|confirm|alert)\(/, "sandi dan konfirmasi lewat dialog Fiori, bukan dialog native");
    assert.doesNotMatch(layar, /\/api\/auth\/admin/, "plugin admin Better Auth ditutup dari browser (kontrak §6)");
    assert.match(layar, /\/primary-group/, "bintang lewat PUT/DELETE primary-group (kontrak §5.6)");
    assert.doesNotMatch(layar, /\/api\/admin\/users\/\$\{[^}]+\}\/group`/, "route lama users/[id]/group (pensiun, semantik tambah+bintang) tidak dipakai layar baru");
});
