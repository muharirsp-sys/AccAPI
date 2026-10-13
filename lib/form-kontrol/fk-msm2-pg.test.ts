/* FK-MSM2 (kunjungan luar rute + konfirmasi masuk JKS, pilot Form Kontrol cabang, 12 Okt 2026) di Postgres EVALUASI (AM040_DATABASE_URL,
 * bukan produksi): route ASLI pada SKEMA SEKALI-PAKAI (tabel disalin `LIKE public.*` + db/migrations/0033 + 0034, search_path hanya skema
 * itu, DROP di akhir). Sesi Better Auth dipalsukan; izin dari tabel grup nyata; route memakai `headers()` -> lingkup permintaan Next tiruan
 * (pola fk-msm-pg.test.ts). Juga DDL_FK_MSM2 (dua kali idempoten + VERIFIKASI + sabotase hak/CHECK), migrate-pg OK->SKIP, = 0034 = Drizzle.
 * "Hari ini" = tanggal WITA saat uji berjalan (route menolak tanggal lain). Data contoh generik. Tanpa env dilewati. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { getTableConfig } from "drizzle-orm/pg-core";
import { kunjunganLuarRute } from "../../db/schema.ts";
import { DAY_TO_HARI } from "./constants.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";

const TABEL = ["user", "access_group", "user_group", "group_permission", "sales_profile", "jks_master", "ao_control_daily",
    "salesman_daily_report", "merchandising_check", "kontrol_audit_log", "customer", "branch", "accurate_employee", "item"];
const skema = `uji_fkmsm2_${randomUUID().slice(0, 8)}`;
const skemaLain: string[] = [];
let admin: Pool;
let pool: Pool;
const urlSkema = (s = skema) => { const u = new URL(PG_URL); u.searchParams.set("options", `-c search_path=${s}`); return u.toString(); };
const berkas = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

const wita = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(d);
const HARI_INI = wita(new Date());
const BESOK = wita(new Date(Date.now() + 86_400_000));
const KEMARIN = wita(new Date(Date.now() - 86_400_000));
const [y, mo, da] = HARI_INI.split("-").map(Number);
/** Nama hari JKS hari ini (undefined = Minggu: tanpa rute JKS) dan satu hari kerja LAIN. */
const HARI = DAY_TO_HARI[new Date(y, mo - 1, da).getDay()];
const HARI_LAIN = HARI === "Senin" ? "Selasa" : "Senin";

type Route = (req: Request) => Promise<Response>;
async function muat() {
    (globalThis as Record<string, unknown>).AsyncLocalStorage ??= AsyncLocalStorage;
    const r = (p: string) => import(p) as Promise<Record<string, Route>>;
    return {
        ...await import("next/dist/server/app-render/work-async-storage.external.js"),
        ...await import("next/dist/server/app-render/work-unit-async-storage.external.js"),
        auth: (await import("../auth.ts")).auth,
        dbMod: await import("../db.ts"),
        luar: await r("../../app/api/form-kontrol/luar-rute/route.ts"),
        konf: await r("../../app/api/form-kontrol/luar-rute/konfirmasi/route.ts"),
        batal: await r("../../app/api/form-kontrol/luar-rute/batal/route.ts"),
        ao: await r("../../app/api/form-kontrol/ao-control/route.ts"),
        visit: await r("../../app/api/form-kontrol/visit/route.ts"),
        checkin: await r("../../app/api/form-kontrol/checkin/route.ts"),
        jks: await r("../../app/api/form-kontrol/jks/route.ts"),
        reports: await r("../../app/api/form-kontrol/reports/route.ts"),
        spv: await r("../../app/api/form-kontrol/spv-dashboard/route.ts"),
        myScope: await r("../../app/api/form-kontrol/my-scope/route.ts"),
        lr: await import("./luar-rute.ts"),
        fk: await import("./db.ts"),
    };
}
let m: Awaited<ReturnType<typeof muat>>;

let sesi: { id: string; name: string; role: string } | null = null;
async function sebagai<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    sesi = (await pool.query(`SELECT id, name, role FROM "user" WHERE id = $1`, [userId])).rows[0] ?? null;
    const store = { route: "/uji", forceStatic: false, dynamicShouldError: false };
    const unit = { type: "private-cache", phase: "render", headers: new Headers({ host: "app.test" }) };
    return m.workAsyncStorage.run(store as never, () => m.workUnitAsyncStorage.run(unit as never, fn));
}
const req = (url: string, method = "GET", body?: unknown) => new Request(`http://app.test${url}`, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});
type J = { status: number; body: Record<string, unknown> };
async function jawab(res: Response): Promise<J> { return { status: res.status, body: await res.json() as Record<string, unknown> }; }

const tambah = async (u: string, customerNo: string, o: { salesCode?: string; principle?: string; date?: string } = {}) =>
    jawab(await sebagai(u, () => m.luar.POST(req("/api/form-kontrol/luar-rute", "POST",
        { salesCode: o.salesCode ?? "M-SLA", principle: o.principle ?? "PRINCIPLE A", date: o.date ?? HARI_INI, customerNo }))));
const konfirmasi = async (u: string, id: string, isi: Record<string, unknown>, salesCode = "M-SLA") =>
    jawab(await sebagai(u, () => m.konf.POST(req("/api/form-kontrol/luar-rute/konfirmasi", "POST", { id, salesCode, ...isi }))));
const daftar = async (u: string, date = HARI_INI, salesCode = "M-SLA") =>
    jawab(await sebagai(u, () => m.luar.GET(req(`/api/form-kontrol/luar-rute?${new URLSearchParams({ salesCode, date })}`))));
type Rute = { custCode: string; custName: string; luarRute: boolean };
const rute = async (u: string, principle = "PRINCIPLE A", salesCode = "M-SLA") => {
    const r = await jawab(await sebagai(u, () => m.ao.GET(req(`/api/form-kontrol/ao-control?${new URLSearchParams({ salesCode, principle, date: HARI_INI })}`))));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.rows as Rute[];
};
/** Kunjungan nyata tanpa baris AO (merchandising saja) — syarat konfirmasi masuk JKS (peninjau A R-2). */
const kunjungi = async (custCode: string, tanggal = HARI_INI) => pool.query(`INSERT INTO merchandising_check (id, sales_code, cust_code, principle, date,
    created_at) VALUES ($1, 'M-SLA', $2, 'PRINCIPLE A', $3, now())`, [randomUUID(), custCode, tanggal]);
const idLuar = async (custCode: string, salesCode = "M-SLA") =>
    (await pool.query(`SELECT id FROM kunjungan_luar_rute WHERE sales_code = $1 AND cust_code = $2 AND tanggal = $3`, [salesCode, custCode, HARI_INI])).rows[0]?.id as string;

before(async () => {
    if (!PG_URL) return;
    admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${skema}`);
    for (const t of TABEL) await admin.query(`CREATE TABLE ${skema}."${t}" (LIKE public."${t}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    pool = new Pool({ connectionString: urlSkema(), max: 2 });
    // Kolom O1 + tabel FK-MSM2 = migrasi repo (bukan bentuk DB evaluasi yang bisa tertinggal).
    await pool.query(await berkas("../../db/migrations/0033_order_cabang.sql"));
    await pool.query(await berkas("../../db/migrations/0034_kunjungan_luar_rute.sql"));
    const p = pool;
    await p.query(`INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt") VALUES
        ('u-sla', 'Sales A', 'sla@uji.test', true, 'staff', now(), now()),
        ('u-slb', 'Sales B', 'slb@uji.test', true, 'staff', now(), now()),
        ('u-sld', 'Sales D', 'sld@uji.test', true, 'staff', now(), now()),
        ('u-sle', 'Sales E', 'sle@uji.test', true, 'staff', now(), now()),
        ('u-spva', 'SPV A (SPV)', 'spva@uji.test', true, 'spv', now(), now()),
        ('u-admin', 'Admin A', 'admin@uji.test', true, 'admin', now(), now())`);
    await p.query(`INSERT INTO access_group (id, name, created_at, updated_at) VALUES ('g-sales', 'Salesman', now(), now()),
        ('g-spv', 'SPV', now(), now()), ('g-admin', 'Admin', now(), now())`);
    await p.query(`INSERT INTO group_permission (group_id, permission_key) SELECT 'g-sales', k FROM unnest(ARRAY['form_kontrol.view',
        'form_kontrol.submit', 'websales.view', 'websales.create']) k`);
    await p.query(`INSERT INTO group_permission (group_id, permission_key) SELECT 'g-spv', k FROM unnest(ARRAY['form_kontrol.view', 'form_kontrol.submit']) k`);
    await p.query(`INSERT INTO group_permission (group_id, permission_key) SELECT 'g-admin', k FROM unnest(ARRAY['form_kontrol.view', 'form_kontrol.submit',
        'form_kontrol.manage', 'order.view', 'order.create', 'websales.create']) k`);
    await p.query(`INSERT INTO user_group (user_id, group_id, assigned_at) SELECT u, g, now() FROM (VALUES ('u-sla', 'g-sales'), ('u-slb', 'g-sales'),
        ('u-sld', 'g-sales'), ('u-sle', 'g-sales'), ('u-spva', 'g-spv'), ('u-admin', 'g-admin')) v(u, g)`);
    // M-SLD: tertaut, tanpa JKS (principal = cabang). M-SLE: profil TANPA tautan Accurate, tanpa JKS.
    await p.query(`INSERT INTO sales_profile (id, user_id, sales_code, sales_name, principle, branch, channel, spv_name, accurate_linked, created_at, updated_at) VALUES
        ('sp-a', 'u-sla', 'M-SLA', 'SALES A', 'PRINCIPLE A', 'CABANG A', 'TT', 'SPV A', true, now(), now()),
        ('sp-b', 'u-slb', 'M-SLB', 'SALES B', 'PRINCIPLE A', 'CABANG A', 'TT', 'SPV A', true, now(), now()),
        ('sp-d', 'u-sld', 'M-SLD', 'SALES D', 'CABANG A', 'CABANG A', 'TT', 'SPV A', true, now(), now()),
        ('sp-e', 'u-sle', 'M-SLE', 'SALES E', 'CABANG A', 'CABANG A', 'TT', NULL, false, now(), now())`);
    await p.query(`INSERT INTO branch (id, name) VALUES (201, 'CABANG A'), (202, 'CABANG B')`);
    await p.query(`INSERT INTO accurate_employee (id, number, name, branch_id, salesman, suspended) VALUES
        (1, 'M-SLA', 'SALES A', 201, true, false), (2, 'M-SLB', 'SALES B', 201, true, false), (4, 'M-SLD', 'SALES D', 201, true, false)`);
    await p.query(`INSERT INTO customer (id, "customerNo", name, alamat, branch_id, branch_name, category_name, suspended) VALUES
        (1, 'C-100001-CBA', 'PELANGGAN A', 'JL. A', 201, 'CABANG A', 'TT', false),
        (2, 'C-100002-CBA', 'PELANGGAN B', 'JL. B', 201, 'CABANG A', 'TT', false),
        (3, 'C-100003-CBA', 'PELANGGAN C', NULL, 201, 'CABANG A', 'TT', false),
        (4, 'C-100004-CBA', 'PELANGGAN D', NULL, 201, 'CABANG A', 'TT', false),
        (5, 'C-100005-CBA', 'PELANGGAN NONAKTIF', NULL, 201, 'CABANG A', 'TT', true),
        (6, 'C-100006-CBB', 'PELANGGAN CABANG B', NULL, 202, 'CABANG B', 'TT', false),
        (7, 'C-100007-CBA', 'PELANGGAN G', NULL, 201, 'CABANG A', 'TT', false),
        (8, 'C-100008-CBA', 'PELANGGAN H', NULL, 201, 'CABANG A', 'TT', false)`);
    // JKS unggahan (kode TANPA akhiran cabang, seperti data pilot): M-SLA C-100001 HARI INI, C-100004 hari lain; M-SLB C-100003 (principal sama).
    await p.query(`INSERT INTO jks_master (id, sales_code, sales_name, cust_code, cust_name, hari_kunjungan, minggu_pattern, principle, channel,
            visit_frequency, is_active, created_at, updated_at) VALUES
        ('j1', 'M-SLA', 'SALES A', 'C-100001', 'PELANGGAN A', $1, 'all', 'PRINCIPLE A', 'MT', 4, true, now(), now()),
        ('j2', 'M-SLA', 'SALES A', 'C-100004', 'PELANGGAN D', $2, 'all', 'PRINCIPLE A', 'MT', 4, true, now(), now()),
        ('j3', 'M-SLB', 'SALES B', 'C-100003', 'PELANGGAN C', $2, 'ganjil', 'PRINCIPLE A', 'TT', 2, true, now(), now())`,
    [(HARI ?? "SENIN").toUpperCase(), HARI_LAIN.toUpperCase()]);

    process.env.DATABASE_URL = urlSkema();
    delete process.env.LOCAL_AUTH_BYPASS;
    m = await muat();
    Object.defineProperty(m.auth.api, "getSession", { configurable: true,
        value: async () => (sesi ? { user: { ...sesi, email: `${sesi.id}@uji.test` }, session: { id: "s" } } : null) });
});

after(async () => {
    if (!PG_URL) return;
    await pool?.end();
    await m?.dbMod.pool.end();
    for (const s of [skema, ...skemaLain]) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await admin.end();
});

// =========================================================================== butir 1: tambah kunjungan luar rute

test("butir 1: pelanggan cabang sendiri -> kunjungan HARI INI bertanda luar rute; dibuka + check-in seperti toko JKS; tambah ulang = baris sama", { skip: pgSkip }, async () => {
    const a = await tambah("u-sla", " c-100002-cba ");
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const row = a.body.row as Record<string, unknown>;
    assert.equal(row.custCode, "C-100002-CBA", "kode pelanggan Accurate LENGKAP (bukan ketikan)");
    assert.equal(row.custName, "PELANGGAN B");
    assert.equal(row.konfirmasi, "menunggu");
    const ulang = await tambah("u-sla", "C-100002-CBA");
    assert.equal(ulang.status, 200);
    assert.equal(ulang.body.baru, false);
    assert.equal((ulang.body.row as { id: string }).id, row.id, "tidak ganda");
    assert.equal((await pool.query(`SELECT count(*)::int n FROM kunjungan_luar_rute`)).rows[0].n, 1);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM kontrol_audit_log WHERE entity = 'luar_rute' AND action = 'tambah'`)).rows[0].n, 1);

    const r = await rute("u-sla");
    const luar = r.find((x) => x.custCode === "C-100002-CBA");
    assert.deepEqual({ nama: luar?.custName, luar: luar?.luarRute }, { nama: "PELANGGAN B", luar: true });
    if (HARI) assert.equal(r.find((x) => x.custCode === "C-100001")?.luarRute, false, "toko JKS tetap baris JKS");

    const q = new URLSearchParams({ salesCode: "M-SLA", custCode: "C-100002-CBA", principle: "PRINCIPLE A", date: HARI_INI });
    const v = await jawab(await sebagai("u-sla", () => m.visit.GET(req(`/api/form-kontrol/visit?${q}`))));
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.deepEqual({ ...(v.body.store as Record<string, unknown>) }, { ...(v.body.store as Record<string, unknown>), luarRute: true, custName: "PELANGGAN B", salesName: "SALES A" });
    const besok = await jawab(await sebagai("u-sla", () => m.visit.GET(req(`/api/form-kontrol/visit?${new URLSearchParams({ ...Object.fromEntries(q), date: BESOK })}`))));
    assert.equal(besok.status, 404, "luar rute hanya untuk tanggalnya");
    const ci = await jawab(await sebagai("u-sla", () => m.checkin.POST(req("/api/form-kontrol/checkin", "POST",
        { salesCode: "M-SLA", custCode: "C-100002-CBA", principle: "PRINCIPLE A", date: HARI_INI, photoUrl: "/api/uploads/form-kontrol/a.jpg" }))));
    assert.equal(ci.status, 200);
    const v2 = await jawab(await sebagai("u-sla", () => m.visit.GET(req(`/api/form-kontrol/visit?${q}`))));
    assert.ok((v2.body.ao as { checkinAt: string | null }).checkinAt, "check-in tercatat di ao_control_daily");
});

test("butir 1: ditolak — cabang lain, nonaktif, sudah di rute hari ini, bukan pemilik (SPV/admin/salesman lain), tanggal lain, principal lain", { skip: pgSkip }, async () => {
    const kode = (j: J) => [j.status, j.body.kode];
    assert.deepEqual(kode(await tambah("u-sla", "C-100006-CBB")), [404, "PELANGGAN_TIDAK_DITEMUKAN"], "pelanggan cabang lain tidak bisa ditambah");
    assert.deepEqual(kode(await tambah("u-sla", "C-100005-CBA")), [404, "PELANGGAN_TIDAK_DITEMUKAN"], "nonaktif");
    if (HARI) {
        const g = await tambah("u-sla", "C-100001-CBA");
        assert.deepEqual(kode(g), [409, "SUDAH_DI_RUTE"], "JKS C-100001 (tanpa akhiran) = toko yang sama di rute hari ini");
        assert.match(String(g.body.error), /sudah ada di rute Anda hari ini/);
    }
    assert.deepEqual(kode(await tambah("u-spva", "C-100007-CBA")), [403, "BUKAN_PEMILIK"]);
    assert.deepEqual(kode(await tambah("u-admin", "C-100007-CBA")), [403, "BUKAN_PEMILIK"]);
    assert.deepEqual(kode(await tambah("u-sla", "C-100007-CBA", { salesCode: "M-SLB" })), [403, "BUKAN_PEMILIK"]);
    assert.deepEqual(kode(await tambah("u-sla", "C-100007-CBA", { date: KEMARIN })), [400, "TANGGAL_BUKAN_HARI_INI"]);
    assert.deepEqual(kode(await tambah("u-sla", "C-100007-CBA", { principle: "PRINCIPLE B" })), [403, "PRINCIPAL_LUAR_CAKUPAN"]);
    assert.deepEqual(kode(await tambah("u-sle", "C-100007-CBA", { salesCode: "M-SLE", principle: "CABANG A" })), [403, "SALESMAN_BELUM_TERHUBUNG"],
        "tanpa tautan karyawan Accurate = kode O1");
    assert.equal((await pool.query(`SELECT count(*)::int n FROM kunjungan_luar_rute`)).rows[0].n, 1, "tidak ada yang tertulis");
});

test("butir 1: salesman TANPA JKS — principal = cabang Accurate (my-scope), tambah + rute jalan; tanpa tautan = alasan; ber-JKS = tanpa principal cabang", { skip: pgSkip }, async () => {
    const sc = async (u: string) => (await jawab(await sebagai(u, () => m.myScope.GET(req("/api/form-kontrol/my-scope"))))).body;
    const d = await sc("u-sld");
    assert.deepEqual([d.principles, d.principalCabang, d.alasanCabang], [[], "CABANG A", null]);
    const e = await sc("u-sle");
    assert.equal(e.principalCabang, null);
    assert.match(String(e.alasanCabang), /belum terhubung ke karyawan salesman Accurate/);
    assert.equal((await sc("u-sla")).principalCabang, null);
    assert.equal((await tambah("u-sld", "C-100008-CBA", { salesCode: "M-SLD", principle: "CABANG A" })).status, 201);
    assert.deepEqual((await rute("u-sld", "CABANG A", "M-SLD")).map((x) => [x.custCode, x.luarRute]), [["C-100008-CBA", true]]);
    assert.equal((await tambah("u-sld", "C-100007-CBA", { salesCode: "M-SLD", principle: "PRINCIPLE A" })).body.kode, "PRINCIPAL_LUAR_CAKUPAN");
});

// =========================================================================== butir 2 + 3: konfirmasi -> JKS + jejak

test("butir 2+3: konfirmasi -> baris JKS salesman (kode LENGKAP, hari baku, minggu, channel JKS-nya); jejak di Kontrol JKS SPV; JKS salesman lain = peringatan", { skip: pgSkip }, async () => {
    assert.equal((await tambah("u-sla", "C-100003-CBA")).status, 201);
    const id = await idLuar("C-100003-CBA");
    const dft = await daftar("u-sla");
    assert.equal(dft.status, 200);
    const baris = (dft.body.rows as { custCode: string; jksLain: { salesCode: string }[]; konfirmasi: string }[]).find((r) => r.custCode === "C-100003-CBA")!;
    assert.deepEqual(baris.jksLain.map((j) => j.salesCode), ["M-SLB"], "peringatan sebelum konfirmasi");
    assert.equal((await daftar("u-spva")).status, 200, "SPV membaca daftar timnya");
    assert.equal((await konfirmasi("u-spva", id, { keputusan: "jks", hari: "Selasa", mingguPattern: "genap" })).body.kode, "BUKAN_PEMILIK");
    assert.equal((await konfirmasi("u-sla", id, { keputusan: "jks", hari: "Minggu", mingguPattern: "genap" })).body.kode, "KEPUTUSAN_TIDAK_SAH");
    assert.equal((await konfirmasi("u-sla", id, { keputusan: "jks", hari: "Selasa", mingguPattern: "tiap" })).body.kode, "KEPUTUSAN_TIDAK_SAH");

    await kunjungi("C-100003-CBA");
    const k = await konfirmasi("u-sla", id, { keputusan: "jks", hari: "SELASA", mingguPattern: "Genap" });
    assert.equal(k.status, 200, JSON.stringify(k.body));
    assert.deepEqual((k.body.jksLain as { salesCode: string }[]).map((j) => j.salesCode), ["M-SLB"]);
    const jks = (await pool.query(`SELECT id, sales_code, sales_name, cust_code, cust_name, hari_kunjungan, minggu_pattern, principle, channel,
        visit_frequency, is_active FROM jks_master WHERE cust_code = 'C-100003-CBA'`)).rows;
    assert.equal(jks.length, 1);
    const { id: jksId, ...isi } = jks[0];
    assert.deepEqual(isi, { sales_code: "M-SLA", sales_name: "SALES A", cust_code: "C-100003-CBA", cust_name: "PELANGGAN C", hari_kunjungan: "Selasa",
        minggu_pattern: "genap", principle: "PRINCIPLE A", channel: "MT", visit_frequency: 2, is_active: true });
    const e = (await pool.query(`SELECT konfirmasi, hari, minggu_pattern, jks_id, dikonfirmasi_oleh, dikonfirmasi_oleh_nama, dikonfirmasi_pada IS NOT NULL ada
        FROM kunjungan_luar_rute WHERE id = $1`, [id])).rows[0];
    assert.deepEqual(e, { konfirmasi: "jks", hari: "Selasa", minggu_pattern: "genap", jks_id: jksId, dikonfirmasi_oleh: "u-sla", dikonfirmasi_oleh_nama: "Sales A", ada: true });
    assert.equal((await pool.query(`SELECT count(*)::int n FROM kontrol_audit_log WHERE entity = 'luar_rute' AND action = 'konfirmasi_jks' AND entity_id = $1`, [id])).rows[0].n, 1);
    assert.deepEqual([(await konfirmasi("u-sla", id, { keputusan: "tidak" })).body.kode], ["SUDAH_DIKONFIRMASI"], "tidak diputuskan ulang");

    // Jejak terlihat di Kontrol JKS (SPV, cakupan timnya): siapa, kapan, dari kunjungan tanggal berapa; baris unggahan tanpa jejak.
    const j = await jawab(await sebagai("u-spva", () => m.jks.GET(req("/api/form-kontrol/jks?salesCode=M-SLA"))));
    assert.equal(j.status, 200);
    const per = Object.fromEntries((j.body.rows as { custCode: string; tambahanSalesman: Record<string, unknown> | null }[]).map((r) => [r.custCode, r.tambahanSalesman]));
    assert.equal(per["C-100001"], null, "unggahan");
    assert.deepEqual({ ...per["C-100003-CBA"], pada: typeof per["C-100003-CBA"]?.pada }, { oleh: "Sales A", dariKunjungan: HARI_INI, pada: "string" });
});

test("butir 2: toko di JKS sendiri hari lain = sudah_jks (tanpa konfirmasi); 'tidak' tanpa JKS; 'nanti' tidak menahan laporan + tetap menunggu esok hari", { skip: pgSkip }, async () => {
    const s = await tambah("u-sla", "C-100004-CBA");
    assert.equal((s.body.row as { konfirmasi: string }).konfirmasi, "sudah_jks");
    assert.equal((await konfirmasi("u-sla", await idLuar("C-100004-CBA"), { keputusan: "jks", hari: "Rabu", mingguPattern: "all" })).body.kode, "SUDAH_DI_JKS");

    assert.equal((await tambah("u-sla", "C-100007-CBA")).status, 201);
    const t = await konfirmasi("u-sla", await idLuar("C-100007-CBA"), { keputusan: "tidak" });
    assert.equal(t.status, 200);
    assert.equal((t.body.row as { konfirmasi: string }).konfirmasi, "tidak");
    assert.equal((await pool.query(`SELECT count(*)::int n FROM jks_master WHERE cust_code LIKE 'C-100007%'`)).rows[0].n, 0);

    // "Nanti": C-100002-CBA tetap menunggu; laporan harian tetap terkirim.
    const lap = await jawab(await sebagai("u-sla", () => m.reports.POST(req("/api/form-kontrol/reports", "POST", { salesCode: "M-SLA", date: HARI_INI, tindakLanjut: "x" }))));
    assert.equal(lap.status, 200);
    const esok = (await daftar("u-sla", BESOK)).body.rows as { custCode: string; konfirmasi: string; tanggal: string }[];
    assert.deepEqual(esok.map((r) => [r.custCode, r.konfirmasi, r.tanggal]), [["C-100002-CBA", "menunggu", HARI_INI]],
        "yang menunggu + sudah dikunjungi terbawa; yang sudah diputuskan / belum dikunjungi tidak");
});

// =========================================================================== butir 4: unggah JKS berikutnya

test("butir 4: unggah JKS tidak menghapus baris tambahan salesman; berkas berkode pendek untuk toko yang sama -> tambahan dinonaktifkan + dilaporkan", { skip: pgSkip }, async () => {
    const unggah = async (rows: unknown[]) => jawab(await sebagai("u-admin", () => m.jks.POST(req("/api/form-kontrol/jks", "POST", { rows }))));
    const b = (cust: string, hari = "Senin", sales = "M-SLA") => ({ salesCode: sales, salesName: "SALES A", custCode: cust, custName: `TOKO ${cust}`,
        principle: "PRINCIPLE A", hariKunjungan: hari, mingguPattern: "all" });
    const aktif = async (cust: string, sales = "M-SLA") => (await pool.query(`SELECT is_active FROM jks_master WHERE sales_code = $1 AND cust_code = $2`, [sales, cust])).rows[0]?.is_active;

    const u1 = await unggah([b("C-200001")]);
    assert.equal(u1.status, 200);
    assert.deepEqual(u1.body.digantikan, []);
    assert.equal(await aktif("C-100003-CBA"), true, "baris tambahan salesman tetap (tidak ada di berkas)");

    const u2 = await unggah([b("c-100003 ", "Rabu"), b("C-100003", "Rabu", "M-SLB")]);
    assert.equal(u2.status, 200);
    assert.deepEqual(u2.body.digantikan, [{ salesCode: "M-SLA", principle: "PRINCIPLE A", custCode: "C-100003-CBA", custName: "PELANGGAN C", kodeBerkas: "C-100003" }]);
    assert.equal(await aktif("C-100003-CBA"), false, "dinonaktifkan (tidak dihapus)");
    assert.equal(await aktif("c-100003 "), true);
    assert.equal(await aktif("C-100003", "M-SLB"), true, "salesman lain tidak tersentuh");
    assert.equal((await pool.query(`SELECT konfirmasi FROM kunjungan_luar_rute WHERE cust_code = 'C-100003-CBA'`)).rows[0].konfirmasi, "jks", "jejak tetap");
});

test("Dashboard SPV menandai kunjungan luar rute (nama toko dari kunjungannya)", { skip: pgSkip }, async () => {
    const d = await jawab(await sebagai("u-spva", () => m.spv.GET(req(`/api/form-kontrol/spv-dashboard?date=${HARI_INI}`))));
    assert.equal(d.status, 200);
    const sla = (d.body.rows as { salesCode: string; visits: { custCode: string; custName: string; luarRute: boolean }[] }[]).find((r) => r.salesCode === "M-SLA")!;
    assert.deepEqual(sla.visits.map((v) => [v.custCode, v.custName, v.luarRute]), [["C-100002-CBA", "PELANGGAN B", true]]);
});

// =========================================================================== Batalkan kunjungan salah tambah (owner 13 Okt)

test("Batalkan: hanya milik sendiri + hari ini + belum ada check-in/status/merchandising; serentak satu 200; hilang dari rute; tambah ulang = baris baru", { skip: pgSkip }, async () => {
    await pool.query(`INSERT INTO customer (id, "customerNo", name, alamat, branch_id, branch_name, category_name, suspended) VALUES
        (10, 'C-100010-CBA', 'PELANGGAN J', NULL, 201, 'CABANG A', 'TT', false), (11, 'C-100011-CBA', 'PELANGGAN K', NULL, 201, 'CABANG A', 'TT', false),
        (12, 'C-100012-CBA', 'PELANGGAN L', NULL, 201, 'CABANG A', 'TT', false), (13, 'C-100013-CBA', 'PELANGGAN M', NULL, 201, 'CABANG A', 'TT', false)`);
    const batal = async (u: string, id: string) => jawab(await sebagai(u, () => m.batal.POST(req("/api/form-kontrol/luar-rute/batal", "POST", { id }))));
    const kode = (j: J) => [j.status, j.body.kode];
    for (const c of ["C-100010-CBA", "C-100011-CBA", "C-100012-CBA", "C-100013-CBA"]) assert.equal((await tambah("u-sla", c)).status, 201);
    const [j, k, l, mm] = await Promise.all(["C-100010-CBA", "C-100011-CBA", "C-100012-CBA", "C-100013-CBA"].map((c) => idLuar(c)));

    assert.deepEqual(kode(await batal("u-slb", j)), [403, "BUKAN_MILIK"], "salesman lain");
    assert.deepEqual(kode(await batal("u-spva", j)), [403, "BUKAN_MILIK"], "SPV bukan pemilik");
    assert.deepEqual(kode(await batal("u-sla", "tidak-ada")), [404, "LUAR_RUTE_TIDAK_ADA"]);
    // Sudah check-in / status AO TANPA check-in / merchandising saja -> SUDAH_DIKUNJUNGI.
    assert.equal((await jawab(await sebagai("u-sla", () => m.checkin.POST(req("/api/form-kontrol/checkin", "POST",
        { salesCode: "M-SLA", custCode: "C-100011-CBA", principle: "PRINCIPLE A", date: HARI_INI, photoUrl: "/api/uploads/form-kontrol/k.jpg" }))))).status, 200);
    assert.deepEqual(kode(await batal("u-sla", k)), [409, "SUDAH_DIKUNJUNGI"], "sudah check-in");
    // Baris AO tanpa check-in, status "tidak dikunjungi" (bentuk kiriman "Kirim status rute") — status apa pun menahan batal.
    await pool.query(`INSERT INTO ao_control_daily (id, sales_code, cust_code, principle, date, period_month, period_year, status, created_at, updated_at)
        VALUES ('ao-l', 'M-SLA', 'C-100012-CBA', 'PRINCIPLE A', $1, 10, 2026, 'not_visited', now(), now())`, [HARI_INI]);
    assert.deepEqual(kode(await batal("u-sla", l)), [409, "SUDAH_DIKUNJUNGI"], "status AO tanpa check-in");
    await pool.query(`INSERT INTO merchandising_check (id, sales_code, cust_code, principle, date, created_at) VALUES ('mc-m', 'M-SLA', 'C-100013-CBA', 'PRINCIPLE A', $1, now())`, [HARI_INI]);
    assert.deepEqual(kode(await batal("u-sla", mm)), [409, "SUDAH_DIKUNJUNGI"], "merchandising saja");
    // Tanggal lain (baris kemarin, langsung di DB) dan baris yang sudah masuk JKS.
    await pool.query(`INSERT INTO kunjungan_luar_rute (id, sales_code, principle, tanggal, cust_code, cust_name, dibuat_oleh) VALUES
        ('klr-kemarin', 'M-SLA', 'PRINCIPLE A', $1, 'C-100010-CBA', 'PELANGGAN J', 'u-sla')`, [KEMARIN]);
    assert.deepEqual(kode(await batal("u-sla", "klr-kemarin")), [409, "BUKAN_HARI_INI"]);
    assert.deepEqual(kode(await batal("u-sla", await idLuar("C-100003-CBA"))), [409, "SUDAH_DIKONFIRMASI"], "baris jks = asal baris JKS");

    // Serentak: dua batal baris sama = satu 200 + satu 409 SUDAH_DIBATALKAN, satu audit.
    const dua = await Promise.all([batal("u-sla", j), batal("u-sla", j)]);
    assert.deepEqual(dua.map(kode).sort(), [[200, undefined], [409, "SUDAH_DIBATALKAN"]]);
    const jejak = (await pool.query(`SELECT dibatalkan_oleh, dibatalkan_pada IS NOT NULL ada, konfirmasi FROM kunjungan_luar_rute WHERE id = $1`, [j])).rows[0];
    assert.deepEqual(jejak, { dibatalkan_oleh: "u-sla", ada: true, konfirmasi: "menunggu" }, "baris tetap (jejak), tidak dihapus");
    assert.equal((await pool.query(`SELECT count(*)::int n FROM kontrol_audit_log WHERE entity = 'luar_rute' AND action = 'batal' AND entity_id = $1`, [j])).rows[0].n, 1);

    // Baris batal: hilang dari rute, kunjungan, daftar konfirmasi; konfirmasi ditolak; tambah ulang = baris BARU (UNIQUE parsial).
    assert.equal((await rute("u-sla")).some((r) => r.custCode === "C-100010-CBA"), false, "keluar dari rute hari ini");
    const v = new URLSearchParams({ salesCode: "M-SLA", custCode: "C-100010-CBA", principle: "PRINCIPLE A", date: HARI_INI });
    assert.equal((await jawab(await sebagai("u-sla", () => m.visit.GET(req(`/api/form-kontrol/visit?${v}`))))).status, 404);
    assert.equal(((await daftar("u-sla")).body.rows as { id: string }[]).some((r) => r.id === j), false, "keluar dari daftar konfirmasi");
    assert.deepEqual(kode(await konfirmasi("u-sla", j, { keputusan: "tidak" })), [409, "SUDAH_DIBATALKAN"]);
    const lagi = await tambah("u-sla", "C-100010-CBA");
    assert.deepEqual([lagi.status, lagi.body.baru], [201, true]);
    assert.notEqual((lagi.body.row as { id: string }).id, j);
    assert.deepEqual((await rute("u-sla")).filter((r) => r.custCode === "C-100010-CBA").map((r) => r.luarRute), [true]);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM kunjungan_luar_rute WHERE cust_code = 'C-100010-CBA' AND tanggal = $1`, [HARI_INI])).rows[0].n, 2);
});

// =========================================================================== peninjau A (13 Okt): SEDANG-1/2, R-1, R-2, R-3, R-5

test("peninjau A: toko sudah di JKS sendiri -> baris lain jadi sudah_jks (berurutan, 'tidak', serentak, kode pendek); bukan pemilik 404; belum dikunjungi 409", { skip: pgSkip }, async () => {
    await pool.query(`INSERT INTO customer (id, "customerNo", name, alamat, branch_id, branch_name, category_name, suspended)
        SELECT n, 'C-1000' || n || '-CBA', 'PELANGGAN ' || n, NULL, 201, 'CABANG A', 'TT', false FROM generate_series(14, 19) n`);
    const kode = (j: J) => [j.status, j.body.kode];
    const status = async (id: string) => (await pool.query(`SELECT konfirmasi FROM kunjungan_luar_rute WHERE id = $1`, [id])).rows[0].konfirmasi;
    const lampau = async (id: string, cust: string, tanggal: string) => {
        await pool.query(`INSERT INTO kunjungan_luar_rute (id, sales_code, principle, tanggal, cust_code, cust_name, dibuat_oleh) VALUES
            ($1, 'M-SLA', 'PRINCIPLE A', $3, $2, 'PELANGGAN LAMA', 'u-sla')`, [id, cust, tanggal]);
        await kunjungi(cust, tanggal);
    };
    const DUA_HARI = wita(new Date(Date.now() - 2 * 86_400_000));
    const aktif = async (like: string) => (await pool.query(`SELECT hari_kunjungan, minggu_pattern FROM jks_master WHERE sales_code = 'M-SLA'
        AND cust_code LIKE $1 AND is_active`, [like])).rows;

    // SEDANG-1 berurutan: "nanti" kemarin + 2 hari lalu, hari ini toko sama dikonfirmasi -> baris lama jadi sudah_jks (jks maupun 'tidak').
    await lampau("klr-16a", "C-100016-CBA", KEMARIN);
    await lampau("klr-16b", "C-100016-CBA", DUA_HARI);
    assert.equal((await tambah("u-sla", "C-100016-CBA")).status, 201);
    await kunjungi("C-100016-CBA");
    assert.equal((await konfirmasi("u-sla", await idLuar("C-100016-CBA"), { keputusan: "jks", hari: "Senin", mingguPattern: "ganjil" })).status, 200);
    assert.deepEqual(kode(await konfirmasi("u-sla", "klr-16a", { keputusan: "jks", hari: "Rabu", mingguPattern: "all" })), [409, "SUDAH_DI_JKS"]);
    assert.deepEqual(kode(await konfirmasi("u-sla", "klr-16b", { keputusan: "tidak" })), [409, "SUDAH_DI_JKS"], "bukan 'tidak' palsu");
    assert.deepEqual([await status("klr-16a"), await status("klr-16b")], ["sudah_jks", "sudah_jks"]);
    assert.deepEqual(await aktif("C-100016%"), [{ hari_kunjungan: "Senin", minggu_pattern: "ganjil" }]);
    assert.equal(((await daftar("u-sla")).body.rows as { custCode: string; konfirmasi: string }[])
        .some((r) => r.custCode === "C-100016-CBA" && r.konfirmasi === "menunggu"), false, "tidak menunggu selamanya");
    assert.equal((await pool.query(`SELECT count(*)::int n FROM kontrol_audit_log WHERE action = 'konfirmasi_sudah_jks' AND entity_id IN ('klr-16a', 'klr-16b')`)).rows[0].n, 2);

    // SEDANG-1 serentak: dua baris toko sama, jadwal berbeda -> satu 200 + satu 409; jadwal jks_master = baris yang 'jks'.
    await lampau("klr-17a", "C-100017-CBA", KEMARIN);
    assert.equal((await tambah("u-sla", "C-100017-CBA")).status, 201);
    await kunjungi("C-100017-CBA");
    const id17 = await idLuar("C-100017-CBA");
    const hasil = await Promise.all([konfirmasi("u-sla", "klr-17a", { keputusan: "jks", hari: "Senin", mingguPattern: "ganjil" }),
        konfirmasi("u-sla", id17, { keputusan: "jks", hari: "Sabtu", mingguPattern: "genap" })]);
    assert.deepEqual(hasil.map(kode).sort(), [[200, undefined], [409, "SUDAH_DI_JKS"]]);
    const jejak = (await pool.query(`SELECT konfirmasi, hari, minggu_pattern FROM kunjungan_luar_rute WHERE cust_code = 'C-100017-CBA' ORDER BY konfirmasi`)).rows;
    assert.deepEqual(jejak.map((r) => r.konfirmasi), ["jks", "sudah_jks"]);
    assert.deepEqual(await aktif("C-100017%"), [{ hari_kunjungan: jejak[0].hari, minggu_pattern: jejak[0].minggu_pattern }], "jadwal JKS = jejak");

    // S12 kode pendek + S03 bukan pemilik: baris menunggu, lalu JKS unggahan berkode PENDEK -> 409, tanpa baris JKS kedua.
    assert.equal((await tambah("u-sla", "C-100018-CBA")).status, 201);
    const id18 = await idLuar("C-100018-CBA");
    await pool.query(`INSERT INTO jks_master (id, sales_code, sales_name, cust_code, cust_name, hari_kunjungan, minggu_pattern, principle, channel,
        visit_frequency, is_active, created_at, updated_at) VALUES ('j18', 'M-SLA', 'SALES A', 'C-100018', 'PELANGGAN 18', 'Rabu', 'all', 'PRINCIPLE A', 'MT', 4, true, now(), now())`);
    await kunjungi("C-100018-CBA");
    assert.deepEqual(kode(await konfirmasi("u-slb", id18, { keputusan: "tidak" }, "M-SLB")), [404, "LUAR_RUTE_TIDAK_ADA"], "salesman B tidak memutuskan baris A");
    assert.deepEqual(kode(await konfirmasi("u-sla", id18, { keputusan: "jks", hari: "Senin", mingguPattern: "all" })), [409, "SUDAH_DI_JKS"]);
    assert.deepEqual(await aktif("C-100018%"), [{ hari_kunjungan: "Rabu", minggu_pattern: "all" }], "tanpa baris JKS kedua");

    // R-2: "jks" butuh kunjungan nyata; baris AO "tidak dikunjungi" (Kirim status rute) bukan kunjungan.
    assert.equal((await tambah("u-sla", "C-100019-CBA")).status, 201);
    const id19 = await idLuar("C-100019-CBA");
    assert.deepEqual(kode(await konfirmasi("u-sla", id19, { keputusan: "jks", hari: "Kamis", mingguPattern: "all" })), [409, "BELUM_DIKUNJUNGI"]);
    await pool.query(`INSERT INTO ao_control_daily (id, sales_code, cust_code, principle, date, period_month, period_year, status, created_at, updated_at)
        VALUES ('ao-19', 'M-SLA', 'C-100019-CBA', 'PRINCIPLE A', $1, 10, 2026, 'not_visited', now(), now())`, [HARI_INI]);
    assert.deepEqual(kode(await konfirmasi("u-sla", id19, { keputusan: "jks", hari: "Kamis", mingguPattern: "all" })), [409, "BELUM_DIKUNJUNGI"]);
    await pool.query(`UPDATE ao_control_daily SET status = 'ordered' WHERE id = 'ao-19'`);
    // R-5 S13: dua konfirmasi serentak baris SAMA = satu 200 + satu 409 SUDAH_DIKONFIRMASI (kunci baris).
    const sama = await Promise.all([1, 2].map(() => konfirmasi("u-sla", id19, { keputusan: "jks", hari: "Kamis", mingguPattern: "all" })));
    assert.deepEqual(sama.map(kode).sort(), [[200, undefined], [409, "SUDAH_DIKONFIRMASI"]]);
    assert.equal(await status(id19), "jks");

    // R-5 S17: daftar luar rute salesman lain = 403.
    assert.equal((await daftar("u-slb", HARI_INI, "M-SLA")).status, 403);
});

test("peninjau A: R-1 satu toko satu kartu (JKS kode pendek diunggah sesudah luar rute); R-3 berkas TANPA hari tidak menggantikan tambahan berhari", { skip: pgSkip }, async () => {
    assert.equal((await tambah("u-sla", "C-100014-CBA")).status, 201);
    if (HARI) {
        await pool.query(`INSERT INTO jks_master (id, sales_code, sales_name, cust_code, cust_name, hari_kunjungan, minggu_pattern, principle, channel,
            visit_frequency, is_active, created_at, updated_at) VALUES ('j14', 'M-SLA', 'SALES A', 'C-100014', 'PELANGGAN 14', $1, 'all', 'PRINCIPLE A', 'MT', 4, true, now(), now())`, [HARI]);
        assert.deepEqual((await rute("u-sla")).filter((r) => r.custCode.startsWith("C-100014")).map((r) => [r.custCode, r.luarRute]), [["C-100014-CBA", true]]);
    }
    assert.equal((await tambah("u-sla", "C-100015-CBA")).status, 201);
    await kunjungi("C-100015-CBA");
    assert.equal((await konfirmasi("u-sla", await idLuar("C-100015-CBA"), { keputusan: "jks", hari: "Rabu", mingguPattern: "all" })).status, 200);
    const unggah = async (hari: string) => jawab(await sebagai("u-admin", () => m.jks.POST(req("/api/form-kontrol/jks", "POST", { rows: [{ salesCode: "M-SLA",
        salesName: "SALES A", custCode: "C-100015", custName: "PELANGGAN 15", principle: "PRINCIPLE A", hariKunjungan: hari, mingguPattern: "all" }] }))));
    const aktif15 = async () => (await pool.query(`SELECT is_active FROM jks_master WHERE cust_code = 'C-100015-CBA'`)).rows[0].is_active;
    assert.deepEqual((await unggah("")).body.digantikan, [], "berkas tanpa hari");
    assert.equal(await aktif15(), true, "tambahan berhari tetap di rute");
    assert.equal(((await unggah("Kamis")).body.digantikan as unknown[]).length, 1, "berkas berhari menggantikan");
    assert.equal(await aktif15(), false);
});

// =========================================================================== paritas minggu (FK-MSM putaran 2)

test("paritas lintas tahun = acuan owner (12 Okt 2026 genap, selang-seling): rute + cek ganda luar rute — Senin 28 Des 2026 ganjil, Senin 4 Jan 2027 genap; Minggu tetap memuat luar rute", { skip: pgSkip }, async () => {
    // Fungsi lib langsung (route hanya menerima hari ini). Minggu ISO % 2 memberi keduanya ganjil (2026 = 53 minggu ISO).
    await pool.query(`INSERT INTO jks_master (id, sales_code, sales_name, cust_code, cust_name, hari_kunjungan, minggu_pattern, principle, channel,
        visit_frequency, is_active, created_at, updated_at) VALUES ('j9', 'M-SLA', 'SALES A', 'C-100009', 'PELANGGAN I', 'SENIN', 'ganjil', 'PRINCIPLE A', 'MT', 2, true, now(), now())`);
    try {
        const tambahPada = (tanggal: string) => m.lr.tambahLuarRute({ salesCode: "M-SLA", principle: "PRINCIPLE A", tanggal, aktorId: "u-sla", aktorNama: "Sales A",
            pelanggan: { id: 9, customerNo: "C-100009-CBA", name: "PELANGGAN I", alamat: null } });
        const ruteC9 = async (tanggal: string) => (await m.fk.getTodayRoute("M-SLA", "PRINCIPLE A", tanggal))
            .filter((r) => r.custCode.startsWith("C-100009")).map((r) => [r.custCode, r.luarRute]);
        const ganjil = await tambahPada("2026-12-28");
        assert.equal("galat" in ganjil ? ganjil.galat.kode : "tertulis", "SUDAH_DI_RUTE", "28 Des 2026 = ganjil: toko JKS Senin-ganjil sudah di rute");
        assert.deepEqual(await ruteC9("2026-12-28"), [["C-100009", false]]);
        const genap = await tambahPada("2027-01-04");
        assert.equal("galat" in genap ? genap.galat.kode : genap.row.konfirmasi, "sudah_jks", "4 Jan 2027 = genap: tidak di rute, boleh ditambah (sudah di JKS hari lain)");
        assert.deepEqual(await ruteC9("2027-01-04"), [["C-100009-CBA", true]]);
        // Hari tanpa jadwal JKS (Minggu 3 Jan 2027): kunjungan luar rute tetap ada di rute (merge FK-MSM: tanpa `if (!dayName) return []`).
        assert.ok(!("galat" in await tambahPada("2027-01-03")));
        assert.deepEqual(await ruteC9("2027-01-03"), [["C-100009-CBA", true]]);
    } finally {
        await pool.query(`DELETE FROM kunjungan_luar_rute WHERE cust_code = 'C-100009-CBA'`);
        await pool.query(`DELETE FROM jks_master WHERE id = 'j9'`);
    }
});

// =========================================================================== DDL / migrasi

type Cek = { cek: string; ok: boolean | null };
const barisTerakhir = (hasil: unknown) => { const h = (Array.isArray(hasil) ? hasil : [hasil]) as { rows: Cek[] }[]; return h[h.length - 1].rows; };
async function skemaBaru(dasar: boolean) {
    const s = `uji_fkmsm2d_${randomUUID().slice(0, 8)}`;
    await admin.query(`CREATE SCHEMA ${s}`);
    skemaLain.push(s);
    if (dasar) for (const t of ["jks_master", "customer", "branch", "accurate_employee", "sales_profile", "kontrol_audit_log", "user"]) {
        await admin.query(`CREATE TABLE ${s}."${t}" (LIKE public."${t}" INCLUDING DEFAULTS)`);
    }
    return { skema: s, pool: new Pool({ connectionString: urlSkema(s), max: 2 }) };
}
async function katalog(p: Pool) {
    const kol = (await p.query(`SELECT a.attname AS c, format_type(a.atttypid, a.atttypmod) AS tipe, a.attnotnull AS wajib,
            pg_get_expr(d.adbin, d.adrelid) AS bawaan FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = to_regclass('kunjungan_luar_rute') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`)).rows;
    const cek = (await p.query(`SELECT conname, pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid = to_regclass('kunjungan_luar_rute') ORDER BY 1`)).rows;
    const idx = (await p.query(`SELECT indexname, regexp_replace(indexdef, ' ON [^ ]+ ', ' ON ') d FROM pg_indexes WHERE schemaname = current_schema()
        AND tablename = 'kunjungan_luar_rute' ORDER BY 1`)).rows;
    return { kol, cek, idx };
}

test("PG FK-MSM2: DDL dua kali idempoten + VERIFIKASI (+ sabotase hak/CHECK); migrate-pg OK->SKIP; = 0034 = Drizzle", { skip: pgSkip }, async () => {
    const ddl = await berkas("../../docs/handover/DDL_FK_MSM2.sql");
    const { migrations } = await import(new URL("../../scripts/migrate-pg.mjs", import.meta.url).href) as { migrations: { nama: string; sudahAda: string; sql: string }[] };
    const entri = migrations.find((x) => x.nama === "kunjungan_luar_rute (FK-MSM2)");
    assert.ok(entri, "entri migrate-pg");
    const migrasi = async (p: Pool) => ((await p.query(entri.sudahAda)).rowCount ? "SKIP" : (await p.query(entri.sql), "OK"));

    const a = await skemaBaru(false);
    assert.equal(await migrasi(a.pool), "OK");
    assert.equal(await migrasi(a.pool), "SKIP", "sesudah tabel ada entri dilewati (tanpa CREATE = tanpa crash loop non-pemilik)");
    const b = await skemaBaru(true);
    for (let i = 0; i < 2; i++) {
        const v = barisTerakhir(await b.pool.query(ddl));
        assert.equal(v.length, 10, "VERIFIKASI lengkap");
        for (const x of v) assert.notEqual(x.ok, false, `VERIFIKASI gagal: ${x.cek}`);
    }
    assert.equal(await migrasi(b.pool), "SKIP", "DDL manual sebelum image -> migrate-pg SKIP");
    const c = await skemaBaru(false);
    await c.pool.query(await berkas("../../db/migrations/0034_kunjungan_luar_rute.sql"));
    const [ka, kb, kc] = [await katalog(a.pool), await katalog(b.pool), await katalog(c.pool)];
    assert.equal(ka.kol.length, 20);
    assert.equal(ka.cek.length, 6, "PK + 5 CHECK");
    assert.deepEqual(kb, ka, "DDL = migrate-pg");
    assert.deepEqual(kc, ka, "0034 = migrate-pg");
    // = Drizzle (db/schema.ts): nama, tipe, wajib, ada bawaan; nama CHECK + indeks.
    const cfg = getTableConfig(kunjunganLuarRute);
    assert.deepEqual(cfg.columns.map((x) => ({ c: x.name, tipe: x.getSQLType().replace("timestamp with time zone", "timestamptz"), wajib: x.notNull, bawaan: x.hasDefault })),
        ka.kol.map((x) => ({ c: x.c, tipe: String(x.tipe).replace("timestamp with time zone", "timestamptz"), wajib: x.wajib, bawaan: x.bawaan !== null })));
    assert.deepEqual(cfg.checks.map((x) => x.name).sort(), ka.cek.map((x) => x.conname).filter((n) => n.endsWith("_pkey") === false).sort());
    assert.deepEqual(cfg.indexes.map((x) => x.config.name).sort(), ka.idx.map((x) => x.indexname).filter((n) => !n.endsWith("_pkey")).sort());
    assert.ok(cfg.indexes.find((x) => x.config.name === "idx_klr_unik")?.config.where, "UNIQUE parsial (belum batal) juga di Drizzle");
    assert.match(String(ka.idx.find((x) => x.indexname === "idx_klr_unik")?.d), /WHERE \(dibatalkan_pada IS NULL\)$/);

    // Sebagian: tabel ada tanpa indeks unik -> sudahAda false -> entri melengkapi.
    const d = await skemaBaru(false);
    await d.pool.query(entri.sql);
    await d.pool.query("DROP INDEX idx_klr_unik");
    assert.equal(await migrasi(d.pool), "OK", "tanpa idx_klr_unik = belum ada");
    assert.deepEqual(await katalog(d.pool), ka);

    // VERIFIKASI hak + CHECK (role sementara di transaksi yang di-ROLLBACK). Galat "role accapi_app already exists" = uji lain di cluster
    // yang sama sedang memakainya: jalankan berkas ini sendirian.
    const verif = ddl.slice(ddl.lastIndexOf("COMMIT;") + "COMMIT;".length);
    const k = await b.pool.connect();
    try {
        await k.query("BEGIN");
        await k.query("CREATE ROLE accapi_app NOLOGIN");
        await k.query(`GRANT USAGE ON SCHEMA ${b.skema} TO accapi_app`);
        await k.query("GRANT SELECT, INSERT, UPDATE ON kunjungan_luar_rute, jks_master TO accapi_app");
        await k.query(`GRANT SELECT ON customer, branch, accurate_employee, sales_profile TO accapi_app`);
        await k.query("GRANT INSERT ON kontrol_audit_log TO accapi_app");
        // S20 (peninjau A): default privileges L1g memberi DELETE/TRUNCATE -> blok 2 DDL (REVOKE) mencabutnya.
        await k.query("GRANT DELETE, TRUNCATE ON kunjungan_luar_rute TO accapi_app");
        await k.query(ddl.slice(ddl.indexOf("DO $$"), ddl.indexOf("END $$;") + "END $$;".length));
        for (const v of (await k.query(verif)).rows as Cek[]) assert.equal(v.ok, true, `hak penuh: ${v.cek}`);
        await k.query("GRANT DELETE ON kunjungan_luar_rute TO accapi_app");
        await k.query("REVOKE UPDATE ON jks_master FROM accapi_app");
        await k.query("REVOKE SELECT ON branch FROM accapi_app");
        await k.query("ALTER TABLE kunjungan_luar_rute DROP CONSTRAINT kunjungan_luar_rute_jks");
        await k.query("ALTER TABLE kunjungan_luar_rute ADD CONSTRAINT kunjungan_luar_rute_jks CHECK (true)");
        const kurang = (await k.query(verif)).rows as Cek[];
        const nilai = (awal: string) => kurang.find((v) => v.cek.startsWith(awal))?.ok;
        assert.equal(nilai("accapi_app tanpa DELETE"), false, "sabotase DELETE terbaca");
        assert.equal(nilai("prasyarat: accapi_app boleh SELECT/INSERT/UPDATE jks_master"), false);
        assert.equal(nilai("prasyarat: accapi_app boleh SELECT customer"), false);
        assert.equal(nilai("CHECK konfirmasi"), false, "CHECK dilemahkan terbaca");
        assert.equal(kurang.filter((v) => v.ok === false).length, 4, "hanya yang disabotase");
    } finally {
        await k.query("ROLLBACK");
        k.release();
    }
    for (const x of [a, b, c, d]) await x.pool.end();
});
