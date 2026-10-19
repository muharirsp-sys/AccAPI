/* Penyaji foto Form Kontrol (app/api/uploads/form-kontrol/[file], 14 Okt 2026) di Postgres EVALUASI (AM040_DATABASE_URL, bukan produksi):
 * route ASLI pada SKEMA SEKALI-PAKAI (tabel disalin `LIKE public.*`, search_path hanya skema itu, DROP di akhir); sesi Better Auth dipalsukan.
 * Berkas uji `uji-<acak>-*.jpg` ditulis ke UPLOAD_DIR dan dihapus di akhir. Data contoh generik. Tanpa env dilewati. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { UPLOAD_DIR } from "./uploads.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";

const TABEL = ["user", "sales_profile", "ao_control_daily", "merchandising_check", "item", "customer"];
const skema = `uji_foto_${randomUUID().slice(0, 8)}`;
const awal = `uji-${randomUUID().slice(0, 8)}`;
const nama = (k: string) => `${awal}-${k}.jpg`;
const url = (k: string) => `/api/uploads/form-kontrol/${nama(k)}`;
const ISI = Buffer.from("bukan-jpeg-sungguhan");
const LUAR = path.join(UPLOAD_DIR, "..", `${awal}-luar.jpg`); // satu folder di atas UPLOAD_DIR: target traversal
let admin: Pool;
let pool: Pool;
let m: { GET: (req: Request, ctx: { params: Promise<{ file: string }> }) => Promise<Response>; pool: Pool };

let sesi: { id: string; name: string; role: string } | null = null;
async function minta(userId: string | null, file: string) {
    sesi = userId ? (await pool.query(`SELECT id, name, role FROM "user" WHERE id = $1`, [userId])).rows[0] ?? null : null;
    return m.GET(new Request(`http://app.test/api/uploads/form-kontrol/${encodeURIComponent(file)}`), { params: Promise.resolve({ file }) });
}
const status = async (userId: string | null, k: string) => (await minta(userId, nama(k))).status;

before(async () => {
    if (!PG_URL) return;
    admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${skema}`);
    for (const t of TABEL) await admin.query(`CREATE TABLE ${skema}."${t}" (LIKE public."${t}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    const u = new URL(PG_URL);
    u.searchParams.set("options", `-c search_path=${skema}`);
    pool = new Pool({ connectionString: u.toString(), max: 2 });
    // sales_profile.accurate_linked = migrasi repo 0033 (DB evaluasi bisa tertinggal).
    await pool.query(await readFile(new URL("../../db/migrations/0033_order_cabang.sql", import.meta.url), "utf8"));
    // Supervisor Review (SR-1): sales_profile.no_hp — Drizzle memilih semua kolom sales_profile.
    await pool.query(await readFile(new URL("../../db/migrations/0036_supervisor_review.sql", import.meta.url), "utf8"));
    await pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt") VALUES
        ('u-sla', 'Sales A', 'sla@uji.test', true, 'staff', now(), now()),
        ('u-slb', 'Sales B', 'slb@uji.test', true, 'staff', now(), now()),
        ('u-slc', 'Sales C', 'slc@uji.test', true, 'staff', now(), now()),
        ('u-tanpa', 'Staf Tanpa Profil', 'tanpa@uji.test', true, 'staff', now(), now()),
        ('u-spva', 'SPV A (SPV)', 'spva@uji.test', true, 'spv', now(), now()),
        ('u-spvb', 'SPV B (SPV)', 'spvb@uji.test', true, 'spv', now(), now()),
        ('u-sma', 'SM A (SM)', 'sma@uji.test', true, 'sm', now(), now()),
        ('u-admin', 'Admin A', 'admin@uji.test', true, 'admin', now(), now())`);
    await pool.query(`INSERT INTO sales_profile (id, user_id, sales_code, sales_name, principle, branch, channel, spv_name, sm_name, created_at, updated_at) VALUES
        ('sp-a', 'u-sla', 'M-SLA', 'SALES A', 'PRINCIPLE A', 'CABANG A', 'TT', 'SPV A', 'SM A', now(), now()),
        ('sp-b', 'u-slb', 'M-SLB', 'SALES B', 'PRINCIPLE A', 'CABANG A', 'TT', 'SPV A', 'SM A', now(), now()),
        ('sp-c', 'u-slc', 'M-SLC', 'SALES C', 'PRINCIPLE A', 'CABANG B', 'TT', 'SPV B', NULL, now(), now())`);
    // M-SLA: check-in + check-out toko tutup (R15) + merchandising (foto utama + butir). M-SLC: check-in (tim lain).
    await pool.query(`INSERT INTO ao_control_daily (id, sales_code, cust_code, principle, date, period_month, period_year, status, no_order_reason_code,
            checkin_photo_url, checkout_photo_url, created_at, updated_at) VALUES
        ('ao-1', 'M-SLA', 'C-100001', 'PRINCIPLE A', '2026-10-14', 10, 2026, 'not_order', 'R15', $1, $2, now(), now()),
        ('ao-2', 'M-SLC', 'C-100002', 'PRINCIPLE A', '2026-10-14', 10, 2026, 'ordered', NULL, $3, NULL, now(), now()),
        ('ao-3', 'M-SLA', 'C-100003', 'PRINCIPLE A', '2026-10-14', 10, 2026, 'ordered', NULL, $4, NULL, now(), now())`,
    [url("ci"), url("tutup"), url("tim-lain"), url("hilang")]);
    await pool.query(`INSERT INTO merchandising_check (id, sales_code, cust_code, principle, date, photo_url, step_photos, created_at) VALUES
        ('mc-1', 'M-SLA', 'C-100001', 'PRINCIPLE A', '2026-10-14', $1, $2::jsonb, now())`,
    [url("merch"), JSON.stringify({ produkJelas: url("butir"), displayRapi: url("butir2") })]);

    await mkdir(UPLOAD_DIR, { recursive: true });
    for (const k of ["ci", "tutup", "merch", "butir", "butir2", "tim-lain", "yatim", "yatim-lama"]) await writeFile(path.join(UPLOAD_DIR, nama(k)), ISI);
    const tigaJam = (Date.now() - 3 * 60 * 60 * 1000) / 1000;
    await utimes(path.join(UPLOAD_DIR, nama("yatim-lama")), tigaJam, tigaJam);
    await writeFile(LUAR, ISI);

    process.env.DATABASE_URL = u.toString();
    delete process.env.LOCAL_AUTH_BYPASS;
    const auth = (await import("../auth.ts")).auth;
    Object.defineProperty(auth.api, "getSession", { configurable: true,
        value: async () => (sesi ? { user: { ...sesi, email: `${sesi.id}@uji.test` }, session: { id: "s" } } : null) });
    m = { ...await import("../../app/api/uploads/form-kontrol/[file]/route.ts"), pool: (await import("../db.ts")).pool } as typeof m;
});

after(async () => {
    if (!PG_URL) return;
    for (const k of ["ci", "tutup", "merch", "butir", "butir2", "tim-lain", "yatim", "yatim-lama"]) await rm(path.join(UPLOAD_DIR, nama(k)), { force: true });
    await rm(LUAR, { force: true });
    await pool?.end();
    await m?.pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${skema} CASCADE`);
    await admin.end();
});

test("pemilik, SPV/SM timnya, admin = 200 + Cache-Control private (bukan public/immutable); isi berkas utuh", { skip: pgSkip }, async () => {
    for (const k of ["ci", "tutup", "merch", "butir", "butir2"]) {
        for (const u of ["u-sla", "u-spva", "u-sma", "u-admin"]) {
            const res = await minta(u, nama(k));
            assert.equal(res.status, 200, `${u} membuka ${k}`);
            assert.equal(res.headers.get("cache-control"), "private, max-age=3600");
            assert.deepEqual(Buffer.from(await res.arrayBuffer()), ISI);
        }
    }
});

test("di luar cakupan = 403: salesman lain setim, SPV/salesman tim lain, staf tanpa profil; tanpa sesi = 401", { skip: pgSkip }, async () => {
    for (const k of ["ci", "tutup", "merch", "butir"]) {
        for (const u of ["u-slb", "u-spvb", "u-slc", "u-tanpa"]) assert.equal(await status(u, k), 403, `${u} membuka ${k}`);
        assert.equal(await status(null, k), 401);
    }
    assert.equal(await status("u-slc", "tim-lain"), 200, "pemilik tim lain tetap bisa");
    assert.equal(await status("u-spvb", "tim-lain"), 200);
    assert.equal(await status("u-sla", "tim-lain"), 403);
    assert.equal(await status("u-spva", "tim-lain"), 403);
});

test("foto yatim (butir merchandising belum disimpan): baru = pengguna bercakupan sales; > 2 jam / tanpa cakupan = 403; admin selalu", { skip: pgSkip }, async () => {
    assert.equal(await status("u-sla", "yatim"), 200);
    assert.equal(await status("u-spva", "yatim"), 200);
    assert.equal(await status("u-tanpa", "yatim"), 403);
    assert.equal(await status("u-sla", "yatim-lama"), 403);
    assert.equal(await status("u-admin", "yatim-lama"), 200);
    assert.equal(await status("u-sla", "tak-ada"), 403, "berkas tak ada di luar cakupan: tidak membocorkan keberadaan");
});

test("baris ada tapi berkas sudah dibersihkan cron = 404 bagi yang berhak", { skip: pgSkip }, async () => {
    assert.equal(await status("u-sla", "hilang"), 404);
    assert.equal(await status("u-admin", "hilang"), 404);
});

test("path traversal / nama aneh ditolak 404 sebelum menyentuh disk, juga untuk admin", { skip: pgSkip }, async () => {
    const luar = path.basename(LUAR);
    for (const f of [`../${luar}`, `..\\${luar}`, `..%2F${luar}`, `x/../${luar}`, "../../sqlite.db", "..", ".jpg", `${awal}-ci.jpg.png`, `${awal}-ci.JPG `, `${awal}.ci.jpg`]) {
        assert.equal((await minta("u-admin", f)).status, 404, f);
    }
});
