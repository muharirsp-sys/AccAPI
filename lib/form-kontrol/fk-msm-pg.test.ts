/* FK-MSM (pilot Form Kontrol cabang, 12 Okt 2026) di Postgres EVALUASI (AM040_DATABASE_URL, bukan produksi): route ASLI Form Kontrol +
 * /api/customers/rute pada SKEMA SEKALI-PAKAI (tabel disalin `LIKE public.*` + db/migrations/0033, search_path hanya skema itu, DROP di
 * akhir). Sesi Better Auth dipalsukan; izin dari tabel grup nyata. Route Form Kontrol memakai `headers()` (next/headers): dijalankan dalam
 * lingkup permintaan tiruan (AsyncLocalStorage internal Next, pola lib/off-program-control/manager-route.test.ts — plafon: Next mengubah
 * internal ini = uji gagal keras, bukan lolos diam-diam). Data contoh generik (SALES A, SPV A, CABANG A, PRINCIPLE A). Tanpa env dilewati. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";

const TABEL = ["user", "access_group", "user_group", "group_permission", "sales_profile", "jks_master", "ao_control_daily",
    "salesman_daily_report", "merchandising_check", "kontrol_audit_log", "customer", "branch", "accurate_employee", "item", "spv_briefing", "sm_control"];
const skema = `uji_fkmsm_${randomUUID().slice(0, 8)}`;
let admin: Pool;
let pool: Pool;
const urlSkema = () => { const u = new URL(PG_URL); u.searchParams.set("options", `-c search_path=${skema}`); return u.toString(); };

type Route = (req: Request) => Promise<Response>;
async function muat() {
    // Next membuat store-nya saat modul dimuat dan memakai globalThis.AsyncLocalStorage — pasang dulu, lalu impor dinamis.
    (globalThis as Record<string, unknown>).AsyncLocalStorage ??= AsyncLocalStorage;
    const r = (p: string) => import(p) as Promise<Record<string, Route>>;
    return {
        ...await import("next/dist/server/app-render/work-async-storage.external.js"),
        ...await import("next/dist/server/app-render/work-unit-async-storage.external.js"),
        NextRequest: (await import("next/server")).NextRequest,
        auth: (await import("../auth.ts")).auth,
        dbMod: await import("../db.ts"),
        ao: await r("../../app/api/form-kontrol/ao-control/route.ts"),
        jks: await r("../../app/api/form-kontrol/jks/route.ts"),
        reports: await r("../../app/api/form-kontrol/reports/route.ts"),
        ack: await r("../../app/api/form-kontrol/reports/ack/route.ts"),
        spv: await r("../../app/api/form-kontrol/spv-dashboard/route.ts"),
        myScope: await r("../../app/api/form-kontrol/my-scope/route.ts"),
        profil: await r("../../app/api/form-kontrol/sales-profiles/route.ts"),
        frek: await r("../../app/api/form-kontrol/frequency/route.ts"),
        rute: await r("../../app/api/customers/rute/route.ts"),
        briefing: await r("../../app/api/form-kontrol/briefing/route.ts"),
        smBriefings: await r("../../app/api/form-kontrol/sm-briefings/route.ts"),
        smControl: await r("../../app/api/form-kontrol/sm-control/route.ts"),
    };
}
let m: Awaited<ReturnType<typeof muat>>;

let sesi: { id: string; name: string; role: string } | null = null;
/** Jalankan route sebagai `userId` di dalam lingkup permintaan Next tiruan (untuk `headers()`). */
async function sebagai<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const u = (await pool.query(`SELECT id, name, role FROM "user" WHERE id = $1`, [userId])).rows[0];
    sesi = u ?? null;
    const store = { route: "/uji", forceStatic: false, dynamicShouldError: false };
    const unit = { type: "private-cache", phase: "render", headers: new Headers({ host: "app.test" }) };
    return m.workAsyncStorage.run(store as never, () => m.workUnitAsyncStorage.run(unit as never, fn));
}
const req = (url: string, method = "GET", body?: unknown) => new Request(`http://app.test${url}`, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});
async function jawab(res: Response) { return { status: res.status, body: await res.json() as Record<string, unknown> }; }

before(async () => {
    if (!PG_URL) return;
    admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${skema}`);
    for (const t of TABEL) await admin.query(`CREATE TABLE ${skema}."${t}" (LIKE public."${t}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    pool = new Pool({ connectionString: urlSkema(), max: 2 });
    // Kolom O1 (customer.suspended, sales_profile.accurate_linked, ...) = migrasi repo, bukan bentuk DB evaluasi yang bisa tertinggal.
    await pool.query(await readFile(new URL("../../db/migrations/0033_order_cabang.sql", import.meta.url), "utf8"));
    // FK-MSM2: rute, unggah JKS, dan Dashboard SPV membaca kunjungan_luar_rute.
    await pool.query(await readFile(new URL("../../db/migrations/0034_kunjungan_luar_rute.sql", import.meta.url), "utf8"));
    const p = pool;
    await p.query(`INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt") VALUES
        ('u-sla', 'Sales A', 'sla@uji.test', true, 'staff', now(), now()),
        ('u-slb', 'Sales B', 'slb@uji.test', true, 'staff', now(), now()),
        ('u-slc', 'Sales C', 'slc@uji.test', true, 'staff', now(), now()),
        ('u-sld', 'Sales D', 'sld@uji.test', true, 'staff', now(), now()),
        ('u-spva', 'SPV A (SPV)', 'spva@uji.test', true, 'spv', now(), now()),
        ('u-spvb', 'SPV B', 'spvb@uji.test', true, 'spv', now(), now()),
        ('u-spvx', '(SPV)', 'spvx@uji.test', true, 'spv', now(), now()),
        ('u-sma', 'SM A (SM)', 'sma@uji.test', true, 'sm', now(), now()),
        ('u-admin', 'Admin A', 'admin@uji.test', true, 'admin', now(), now())`);
    await p.query(`INSERT INTO access_group (id, name, created_at, updated_at) VALUES ('g-sales', 'Salesman', now(), now()),
        ('g-spv', 'SPV', now(), now()), ('g-admin', 'Admin', now(), now())`);
    await p.query(`INSERT INTO group_permission (group_id, permission_key) SELECT 'g-sales', k FROM unnest(ARRAY['form_kontrol.view',
        'form_kontrol.submit', 'websales.view', 'websales.create']) k`);
    await p.query(`INSERT INTO group_permission (group_id, permission_key) SELECT 'g-spv', k FROM unnest(ARRAY['form_kontrol.view', 'form_kontrol.submit']) k`);
    await p.query(`INSERT INTO group_permission (group_id, permission_key) SELECT 'g-admin', k FROM unnest(ARRAY['form_kontrol.view', 'form_kontrol.submit',
        'form_kontrol.manage', 'order.view', 'order.create', 'websales.create']) k`);
    await p.query(`INSERT INTO user_group (user_id, group_id, assigned_at) SELECT u, g, now() FROM (VALUES ('u-sla', 'g-sales'),
        ('u-slb', 'g-sales'), ('u-slc', 'g-sales'), ('u-sld', 'g-sales'), ('u-spva', 'g-spv'), ('u-spvx', 'g-spv'), ('u-sma', 'g-spv'), ('u-spvb', 'g-spv'), ('u-admin', 'g-admin')) v(u, g)`);
    // Nama SPV di Hierarki tidak rapi (spasi, huruf) — sengaja: butir 5. SPV A = profil M-SLA + M-SLB; SPV B = M-SLC. Akun SPV tanpa profil.
    // SM A membawahi M-SLA + M-SLB (nama SM juga tidak rapi). M-SLE = profil dengan nama SPV KOSONG (spasi) — penjaga nama kosong (S16).
    await p.query(`INSERT INTO sales_profile (id, user_id, sales_code, sales_name, principle, branch, spv_name, sm_name, accurate_linked, created_at, updated_at) VALUES
        ('sp-a', 'u-sla', 'M-SLA', 'SALES A', 'PRINCIPLE A', 'CABANG A', ' spv a ', 'sm a ', true, now(), now()),
        ('sp-b', 'u-slb', 'M-SLB', 'SALES B', 'PRINCIPLE B', 'CABANG A', 'SPV A', 'SM A', false, now(), now()),
        ('sp-c', 'u-slc', 'M-SLC', 'SALES C', 'PRINCIPLE C', 'CABANG B', 'SPV B', NULL, true, now(), now()),
        ('sp-d', 'u-sld', 'M-SLD', 'SALES D', 'PRINCIPLE A', 'CABANG A', NULL, NULL, false, now(), now()),
        ('sp-e', 'u-sle', 'M-SLE', 'SALES E', 'PRINCIPLE A', 'CABANG A', '   ', '  ', false, now(), now())`);
    await p.query(`INSERT INTO branch (id, name) VALUES (201, 'CABANG A'), (202, 'CABANG B')`);
    await p.query(`INSERT INTO accurate_employee (id, number, name, branch_id, salesman, suspended) VALUES
        (1, 'M-SLA', 'SALES A', 201, true, false), (3, 'M-SLC', 'SALES C', 202, true, false)`);
    // JKS seperti data pilot di produksi: hari HURUF BESAR / berspasi / JUM'AT, pola minggu ganjil/genap, kode toko TANPA akhiran cabang.
    await p.query(`INSERT INTO jks_master (id, sales_code, sales_name, cust_code, cust_name, hari_kunjungan, minggu_pattern, principle, channel,
            visit_frequency, is_active, created_at, updated_at) VALUES
        ('j1', 'M-SLA', 'SALES A', 'C-100001', 'PELANGGAN A', 'SENIN', 'ganjil', 'PRINCIPLE A', 'TT', 2, true, now(), now()),
        ('j2', 'M-SLA', 'SALES A', 'C-100003', 'PELANGGAN C', 'SENIN', 'GENAP', 'PRINCIPLE A', 'TT', 2, true, now(), now()),
        ('j3', 'M-SLA', 'SALES A', 'C-100004', 'PELANGGAN D', ' senin ', 'all', 'PRINCIPLE A', 'TT', 4, true, now(), now()),
        ('j4', 'M-SLA', 'SALES A', 'C-100005', 'PELANGGAN E', 'JUM''AT', 'all', 'PRINCIPLE A', 'TT', 4, true, now(), now()),
        ('j5', 'M-SLA', 'SALES A', 'C-100006', 'PELANGGAN F', 'SELASA', 'all', 'PRINCIPLE A', 'TT', 4, true, now(), now()),
        ('j6', 'M-SLA', 'SALES A', 'C-100099', 'PELANGGAN Z', 'SENIN', 'all', 'PRINCIPLE Z', 'TT', 4, false, now(), now()),
        ('j7', 'M-SLB', 'SALES B', 'C-200001', 'PELANGGAN G', 'Senin', 'all', 'PRINCIPLE B', 'TT', 4, true, now(), now()),
        ('j8', 'M-SLC', 'SALES C', 'C-300001', 'PELANGGAN H', 'Senin', 'all', 'PRINCIPLE C', 'TT', 4, true, now(), now())`);

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
    await admin.query(`DROP SCHEMA IF EXISTS ${skema} CASCADE`);
    await admin.end();
});

const rute = async (userId: string, date: string, principle = "PRINCIPLE A", salesCode = "M-SLA") => {
    const r = await jawab(await sebagai(userId, () => m.ao.GET(req(`/api/form-kontrol/ao-control?${new URLSearchParams({ salesCode, principle, date })}`))));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return (r.body.rows as { custCode: string }[]).map((x) => x.custCode).sort();
};

// =========================================================================== butir 2: hari kunjungan tak peka huruf + pola minggu

test("butir 2: JKS hari HURUF BESAR/berspasi/JUM'AT terbaca tanpa unggah ulang; minggu genap/ganjil (selang-seling dari acuan owner)", { skip: pgSkip }, async () => {
    // Senin 12 Okt 2026 = minggu acuan owner (genap): ganjil C-100001 TIDAK, genap C-100003 + all C-100004 ya; JKS nonaktif tidak.
    assert.deepEqual(await rute("u-sla", "2026-10-12"), ["C-100003", "C-100004"]);
    // Senin 19 Okt = 1 minggu sesudah acuan (ganjil).
    assert.deepEqual(await rute("u-sla", "2026-10-19"), ["C-100001", "C-100004"]);
    assert.deepEqual(await rute("u-sla", "2026-10-16"), ["C-100005"], "JUM'AT = Jumat");
    assert.deepEqual(await rute("u-sla", "2026-10-13"), ["C-100006"]);
    assert.deepEqual(await rute("u-sla", "2026-10-18"), [], "Minggu tanpa rute");
    // Owner 12 Okt: selang-seling dari acuan, bukan minggu ISO — Senin 4 Jan 2027 = 12 minggu sesudah acuan = genap (ISO minggu 1 = ganjil).
    assert.deepEqual(await rute("u-sla", "2027-01-04"), ["C-100003", "C-100004"]);
    assert.deepEqual(await rute("u-sla", "2026-10-05"), ["C-100001", "C-100004"], "minggu sebelum acuan = ganjil");
    // Laporan harian (live, belum dikirim) menghitung toko JKS hari itu dengan aturan yang sama (lintas principal).
    const lap = await jawab(await sebagai("u-sla", () => m.reports.GET(req("/api/form-kontrol/reports?salesCode=M-SLA&date=2026-10-12"))));
    assert.equal(Number((lap.body.rows as { totalTokoJks: unknown }[])[0].totalTokoJks), 2); // count(*) pg = teks (perilaku lama)
});

test("butir 2: unggah JKS menyimpan hari BAKU; hari tak dikenal ditolak per baris (tidak ditulis)", { skip: pgSkip }, async () => {
    const baris = (cust: string, hari: string, pola = "all") => ({ salesCode: "M-SLC", salesName: "SALES C", custCode: cust, custName: `TOKO ${cust}`,
        principle: "PRINCIPLE C", hariKunjungan: hari, mingguPattern: pola });
    const r = await jawab(await sebagai("u-admin", () => m.jks.POST(req("/api/form-kontrol/jks", "POST", { rows: [
        baris("U-1", "SABTU"), baris("U-2", " jum'at ", "GANJIL"), baris("U-3", "Minggu"), baris("U-4", "Senen"), baris("U-5", ""),
        baris("U-6", "1"), baris("U-7", "-"),
    ] }))));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.imported, 3);
    assert.deepEqual(r.body.ditolak, [
        { baris: 3, custCode: "U-3", hari: "Minggu" },
        { baris: 4, custCode: "U-4", hari: "Senen" },
        { baris: 6, custCode: "U-6", hari: "1" },
        { baris: 7, custCode: "U-7", hari: "-" },
    ]);
    const db = (await pool.query(`SELECT cust_code, hari_kunjungan, minggu_pattern FROM jks_master WHERE cust_code LIKE 'U-%' ORDER BY 1`)).rows;
    assert.deepEqual(db, [
        { cust_code: "U-1", hari_kunjungan: "Sabtu", minggu_pattern: "all" },
        { cust_code: "U-2", hari_kunjungan: "Jumat", minggu_pattern: "ganjil" },
        { cust_code: "U-5", hari_kunjungan: null, minggu_pattern: "all" },
    ]);
    await pool.query(`DELETE FROM jks_master WHERE cust_code LIKE 'U-%'`);
});

// =========================================================================== butir 3 + 5: Dashboard SPV, ack, nama SPV

test("butir 5: cakupan SPV = nama SPV Hierarki dibandingkan trim + tanpa beda huruf; simpan Hierarki ter-trim", { skip: pgSkip }, async () => {
    const sc = await jawab(await sebagai("u-spva", () => m.myScope.GET(req("/api/form-kontrol/my-scope"))));
    assert.equal(sc.status, 200);
    assert.deepEqual([...(sc.body.allowedSalesCodes as string[])].sort(), ["M-SLA", "M-SLB"], "' spv a ' dan 'SPV A' = tim SPV A");
    // S16: akun SPV bernama kosong ("(SPV)") TIDAK mewarisi profil yang nama SPV-nya kosong/spasi.
    const kosong = await jawab(await sebagai("u-spvx", () => m.myScope.GET(req("/api/form-kontrol/my-scope"))));
    assert.deepEqual(kosong.body.allowedSalesCodes, []);
    const dashKosong = await jawab(await sebagai("u-admin", () => m.spv.GET(req("/api/form-kontrol/spv-dashboard?date=2026-10-12&spvName=%20%20"))));
    assert.deepEqual(dashKosong.body.rows, [], "nama SPV spasi tidak cocok dengan profil bernama kosong");
    const put = await jawab(await sebagai("u-admin", () => m.profil.PUT(req("/api/form-kontrol/sales-profiles", "PUT", { salesCode: "M-SLC", spvName: "  SPV B  ", smName: " " }))));
    assert.equal(put.status, 200);
    assert.deepEqual((await pool.query(`SELECT spv_name, sm_name FROM sales_profile WHERE sales_code = 'M-SLC'`)).rows, [{ spv_name: "SPV B", sm_name: null }]);
});

test("butir 3: SPV TANPA sales_profile melihat dashboard timnya saja; salesman tidak; admin memilih SPV (tak peka huruf)", { skip: pgSkip }, async () => {
    const kode = (b: Record<string, unknown>) => (b.rows as { salesCode: string }[]).map((r) => r.salesCode).sort();
    const spv = await jawab(await sebagai("u-spva", () => m.spv.GET(req("/api/form-kontrol/spv-dashboard?date=2026-10-12&spvName=SPV%20B"))));
    assert.equal(spv.status, 200, JSON.stringify(spv.body));
    assert.deepEqual(kode(spv.body), ["M-SLA", "M-SLB"], "parameter spvName diabaikan untuk SPV");
    assert.equal(spv.body.spvName, "SPV A");
    const spvb = await jawab(await sebagai("u-spvb", () => m.spv.GET(req("/api/form-kontrol/spv-dashboard?date=2026-10-12"))));
    assert.deepEqual(kode(spvb.body), ["M-SLC"]);
    const sales = await jawab(await sebagai("u-sla", () => m.spv.GET(req("/api/form-kontrol/spv-dashboard?date=2026-10-12"))));
    assert.equal(sales.status, 403, "salesman tidak melihat dashboard tim");
    const adm = await jawab(await sebagai("u-admin", () => m.spv.GET(req("/api/form-kontrol/spv-dashboard?date=2026-10-12&spvName=spv%20b"))));
    assert.deepEqual(kode(adm.body), ["M-SLC"]);
});

test("butir 3: ack laporan hanya untuk tim sendiri (SPV tanpa profil)", { skip: pgSkip }, async () => {
    await pool.query(`INSERT INTO salesman_daily_report (id, sales_code, date, period_month, period_year, tindak_lanjut, submitted_at) VALUES
        ('r-a', 'M-SLA', '2026-10-12', 10, 2026, 'x', now()), ('r-c', 'M-SLC', '2026-10-12', 10, 2026, 'y', now())`);
    const ack = (u: string, salesCode: string) => sebagai(u, () => m.ack.POST(req("/api/form-kontrol/reports/ack", "POST", { salesCode, date: "2026-10-12" })));
    assert.equal((await ack("u-spva", "M-SLA")).status, 200);
    assert.equal((await ack("u-spva", "M-SLC")).status, 403, "tim lain");
    assert.equal((await ack("u-spvb", "M-SLC")).status, 200);
    assert.deepEqual((await pool.query(`SELECT sales_code, spv_ack FROM salesman_daily_report ORDER BY 1`)).rows,
        [{ sales_code: "M-SLA", spv_ack: true }, { sales_code: "M-SLC", spv_ack: true }]);
});

// =========================================================================== butir 4: cakupan JKS

test("butir 4: JKS — SPV hanya timnya, salesman hanya miliknya (salesCode luar cakupan 403), admin semua; frekuensi sama", { skip: pgSkip }, async () => {
    const jks = async (u: string, q = "") => jawab(await sebagai(u, () => m.jks.GET(req(`/api/form-kontrol/jks${q}`))));
    const kode = (b: Record<string, unknown>) => [...new Set((b.rows as { salesCode: string }[]).map((r) => r.salesCode))].sort();
    const spv = await jks("u-spva", "?salesCodes=M-SLC");
    assert.equal(spv.status, 200);
    assert.deepEqual(kode(spv.body), ["M-SLA", "M-SLB"], "parameter salesCodes klien diabaikan; cakupan dari server");
    assert.equal(Number(spv.body.total), 6, "total ikut cakupan (5 aktif M-SLA + 1 M-SLB)");
    assert.equal((await jks("u-spva", "?salesCode=M-SLC")).status, 403);
    assert.deepEqual(kode((await jks("u-spva", "?salesCode=M-SLB")).body), ["M-SLB"]);
    assert.deepEqual(kode((await jks("u-sla")).body), ["M-SLA"]);
    assert.equal((await jks("u-sla", "?salesCode=M-SLB")).status, 403);
    assert.deepEqual(kode((await jks("u-admin")).body), ["M-SLA", "M-SLB", "M-SLC"]);
    // Hari pada saringan dibandingkan lewat kunci (Kontrol JKS mengirim "Senin"; data "SENIN"/" senin ").
    assert.equal(Number((await jks("u-sla", "?hari=Senin")).body.total), 3);

    const frek = async (u: string, salesCode: string, principle: string) =>
        jawab(await sebagai(u, () => m.frek.GET(req(`/api/form-kontrol/frequency?${new URLSearchParams({ salesCode, principle, month: "10", year: "2026" })}`))));
    assert.equal((await frek("u-sla", "M-SLB", "PRINCIPLE B")).status, 403, "frekuensi memuat baris JKS: cakupan sama");
    const sendiri = await frek("u-sla", "M-SLA", "PRINCIPLE A");
    assert.equal(sendiri.status, 200);
    assert.equal((sendiri.body.rows as unknown[]).length, 5);
});

// =========================================================================== butir 1: principal dari JKS aktif

test("butir 1: my-scope mengirim principal JKS AKTIF milik cakupan (bukan daftar tetap); tanpa JKS = []", { skip: pgSkip }, async () => {
    const p = async (u: string) => {
        const r = await jawab(await sebagai(u, () => m.myScope.GET(req("/api/form-kontrol/my-scope"))));
        assert.equal(r.status, 200);
        return r.body.principles;
    };
    assert.deepEqual(await p("u-sla"), ["PRINCIPLE A"], "JKS nonaktif (PRINCIPLE Z) tidak ikut");
    assert.deepEqual(await p("u-spva"), ["PRINCIPLE A", "PRINCIPLE B"], "gabungan tim SPV");
    assert.deepEqual(await p("u-spvb"), ["PRINCIPLE C"]);
    assert.deepEqual(await p("u-sld"), [], "salesman tanpa JKS");
    assert.deepEqual(await p("u-admin"), ["PRINCIPLE A", "PRINCIPLE B", "PRINCIPLE C"]);
});

// =========================================================================== butir 6: toko rute JKS -> pelanggan cabang salesman

test("butir 6: kode JKS tanpa akhiran -> pelanggan CABANG salesman; kode yang hanya ada di cabang lain tidak ditawarkan", { skip: pgSkip }, async () => {
    await pool.query(`INSERT INTO customer (id, "customerNo", name, branch_id, branch_name, category_name, suspended) VALUES
        (1, 'C-100001-CBA', 'PELANGGAN A', 201, 'CABANG A', 'TT', false),
        (2, 'C-100001-CBB', 'PELANGGAN A (CABANG B)', 202, 'CABANG B', 'TT', false),
        (3, 'C-100002-CBB', 'PELANGGAN B', 202, 'CABANG B', 'TT', false),
        (4, 'C- FA0164-CBA', 'PELANGGAN SPASI', 201, 'CABANG A', 'MT', false),
        (5, 'C-100007-CBA', 'PELANGGAN G1', 201, 'CABANG A', 'TT', false),
        (6, 'C-100007-CBX', 'PELANGGAN G2', 201, 'CABANG A', 'TT', false),
        (7, 'C-100008-CBA', 'PELANGGAN NONAKTIF', 201, 'CABANG A', 'TT', true),
        (8, 'C-100009', 'PELANGGAN TANPA AKHIRAN', 201, 'CABANG A', 'TT', false),
        (9, 'C-2000-01-CBA', 'PELANGGAN DUA BAGIAN', 201, 'CABANG A', 'TT', false),
        (10, 'C-100010-CBA', 'PELANGGAN AWALAN', 201, 'CABANG A', 'TT', false),
        (11, 'C-7_A\\B-CBA', 'PELANGGAN TANDA', 201, 'CABANG A', 'TT', false)`);
    const PANJANG = `C-${"9".repeat(80)}`;
    const KODE = ["C-100001", "C-100002", "C- FA0164", "C-100007", "c-100008", "C-100009", "C-2000", "C-10001", "C-100001", "C-7_A\\B", PANJANG];
    const minta = async (u: string, kode = KODE) => {
        sesi = (await pool.query(`SELECT id, name, role FROM "user" WHERE id = $1`, [u])).rows[0];
        const q = new URLSearchParams(kode.map((k) => ["kode", k]));
        return jawab(await m.rute.GET(new m.NextRequest(`http://app.test/api/customers/rute?${q}`)));
    };
    type Baris = { kode: string; pelanggan: { customerNo: string; channel: string } | null; masalah: string | null; alasan: string };
    const r = await minta("u-sla");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.cakupan, { semua: false, branchId: 201, branchName: "CABANG A" });
    const per = Object.fromEntries((r.body.rute as Baris[]).map((x) => [x.kode, x]));
    assert.equal(Object.keys(per).length, 10, "kode ganda di permintaan digabung");
    // S17: `_` dan `\` di kode JKS = huruf biasa pada LIKE (tanpa escape, `\B` jadi B dan pelanggannya tak terkandidat).
    assert.equal(per["C-7_A\\B"].pelanggan?.customerNo, "C-7_A\\B-CBA");
    // KC3: kode > 80 huruf = alasan untuk toko itu saja, permintaan tetap 200.
    assert.equal(per[PANJANG].masalah, "KODE_TIDAK_SAH");
    assert.match(per[PANJANG].alasan, /80 huruf/);
    assert.equal(per["C-100001"].pelanggan?.customerNo, "C-100001-CBA", "cabang B tidak ikut");
    assert.equal(per["C-100001"].pelanggan?.channel, "GT");
    assert.equal(per["C-100002"].pelanggan, null, "hanya ada di cabang lain = TIDAK ditawarkan");
    assert.equal(per["C-100002"].masalah, "TIDAK_ADA");
    assert.match(per["C-100002"].alasan, /belum terdaftar sebagai pelanggan cabang Anda \(CABANG A\) di Accurate/i);
    assert.equal(per["C- FA0164"].pelanggan?.customerNo, "C- FA0164-CBA");
    assert.equal(per["C-100007"].masalah, "GANDA");
    assert.match(per["C-100007"].alasan, /C-100007-CBA, C-100007-CBX/);
    assert.equal(per["c-100008"].masalah, "NONAKTIF");
    assert.equal(per["C-100009"].pelanggan?.customerNo, "C-100009");
    assert.equal(per["C-2000"].masalah, "TIDAK_ADA");
    assert.equal(per["C-10001"].masalah, "TIDAK_ADA", "C-100010-CBA bukan C-10001 + akhiran");
    // Data JKS tidak disentuh.
    assert.equal((await pool.query(`SELECT count(*)::int n FROM jks_master WHERE cust_code LIKE 'C-%-%'`)).rows[0].n, 0);

    // Internal (order.view) = semua cabang: kode di dua cabang = GANDA, bukan menebak cabang.
    const adm = await minta("u-admin", ["C-100001", "C-100002"]);
    const perAdm = Object.fromEntries((adm.body.rute as Baris[]).map((x) => [x.kode, x]));
    assert.equal(perAdm["C-100001"].masalah, "GANDA");
    assert.equal(perAdm["C-100002"].pelanggan?.customerNo, "C-100002-CBB");

    // Akun sales belum tertaut ke karyawan Accurate = kode O1, bukan daftar kosong; tanpa kode = 400; tanpa izin Order Sales = 403.
    const belum = await minta("u-slb", ["C-100001"]);
    assert.equal(belum.status, 403);
    assert.equal(belum.body.kode, "SALESMAN_BELUM_TERHUBUNG");
    assert.equal((await minta("u-sla", [])).status, 400);
    // Lebih dari batas per permintaan = 400 berkalimat (pemilih memecah kode per 200 — components/order/order-cabang-api.ts).
    const banyak = await minta("u-sla", Array.from({ length: 201 }, (_, i) => `C-${i}`));
    assert.equal(banyak.status, 400);
    assert.match(String(banyak.body.error), /200/);
    assert.equal((await minta("u-spva", ["C-100001"])).status, 403);
});

// =========================================================================== putaran 2: briefing / Kontrol SM dari sesi (KC2 + SEDANG)

test("KC2: briefing & daftar SPV milik SM dicocokkan trim + tak peka huruf, tanpa baris ganda", { skip: pgSkip }, async () => {
    await pool.query(`INSERT INTO spv_briefing (id, spv_name, date, session, created_at) VALUES
        ('b1', 'SPV A', '2026-10-12', 'pagi', now()), ('b2', ' spv a ', '2026-10-12', 'sore', now()), ('b3', 'SPV B', '2026-10-12', 'pagi', now())`);
    const sm = await jawab(await sebagai("u-sma", () => m.smBriefings.GET(req("/api/form-kontrol/sm-briefings?date=2026-10-12"))));
    assert.equal(sm.status, 200);
    const rows = sm.body.rows as { spvName: string; briefings: { session: string }[] }[];
    assert.equal(rows.length, 1, "' spv a ' dan 'SPV A' = satu SPV");
    assert.deepEqual(rows[0].briefings.map((b) => b.session).sort(), ["pagi", "sore"]);
    const spv = await jawab(await sebagai("u-spva", () => m.briefing.GET(req("/api/form-kontrol/briefing?date=2026-10-12"))));
    assert.equal(spv.body.total, 2);
    // R-1 (peninjau FK-MSM 13 Okt): daftar SPV milik SM hanya untuk SM/admin — SPV 403 (bukan daftar atas namanya).
    assert.equal((await sebagai("u-spva", () => m.smBriefings.GET(req("/api/form-kontrol/sm-briefings?date=2026-10-12")))).status, 403);
});

test("SEDANG: briefing — salesman hanya SPV-nya, SPV hanya namanya, SM hanya SPV bawahannya + namanya; admin semua", { skip: pgSkip }, async () => {
    const get = async (u: string, q: string) => jawab(await sebagai(u, () => m.briefing.GET(req(`/api/form-kontrol/briefing?date=2026-10-12${q}`))));
    const post = async (u: string, body: Record<string, unknown>) =>
        jawab(await sebagai(u, () => m.briefing.POST(req("/api/form-kontrol/briefing", "POST", { date: "2026-10-13", session: "pagi", ...body }))));
    assert.equal((await get("u-sla", "&spvName=SPV%20B")).status, 403, "salesman membaca SPV lain");
    assert.equal((await get("u-sla", "")).body.total, 2, "salesman: briefing SPV-nya (profil ' spv a ')");
    assert.equal((await get("u-spva", "&spvName=SPV%20B")).status, 403);
    assert.equal((await get("u-spva", "&spvName=spv%20a")).body.total, 2);
    assert.equal((await get("u-sma", "&spvName=SPV%20A")).body.total, 2, "SM: SPV bawahannya");
    assert.equal((await get("u-sma", "&spvName=SPV%20B")).status, 403);
    assert.equal((await get("u-admin", "&spvName=SPV%20B")).body.total, 1);

    assert.equal((await post("u-spva", { spvName: "SPV B" })).status, 403, "SPV menulis atas nama SPV lain");
    assert.equal((await post("u-sla", { spvName: "SPV A" })).status, 403, "salesman tidak menulis briefing");
    assert.equal((await post("u-sma", { spvName: "SPV B" })).status, 403);
    assert.equal((await post("u-spva", {})).status, 200, "tanpa nama = namanya sendiri");
    assert.equal((await post("u-admin", { spvName: "SPV B" })).status, 200);
    assert.deepEqual((await pool.query(`SELECT spv_name FROM spv_briefing WHERE date = '2026-10-13' ORDER BY 1`)).rows.map((r) => r.spv_name), ["SPV A", "SPV B"]);
});

test("SEDANG: Kontrol SM — SM hanya atas namanya, peran lain 403, admin semua", { skip: pgSkip }, async () => {
    const get = async (u: string, q: string) => jawab(await sebagai(u, () => m.smControl.GET(req(`/api/form-kontrol/sm-control?date=2026-10-12${q}`))));
    const post = async (u: string, body: Record<string, unknown>) =>
        jawab(await sebagai(u, () => m.smControl.POST(req("/api/form-kontrol/sm-control", "POST", { date: "2026-10-12", ...body }))));
    assert.equal((await get("u-sma", "&smName=SM%20B")).status, 403);
    assert.equal((await get("u-sma", "")).status, 200);
    assert.equal((await get("u-spva", "&smName=SM%20A")).status, 403);
    assert.equal((await post("u-sma", { smName: "SM B" })).status, 403);
    assert.equal((await post("u-spva", { smName: "SM A" })).status, 403);
    assert.equal((await post("u-sma", { smName: "sm a" })).status, 200);
    assert.equal((await post("u-admin", { smName: "SM B" })).status, 200);
    assert.deepEqual((await pool.query(`SELECT sm_name FROM sm_control ORDER BY 1`)).rows.map((r) => r.sm_name), ["SM A", "SM B"]);
    assert.equal((await get("u-sma", "&smName=sm%20a")).body.total, 1);
    // R-2 (peninjau FK-MSM 13 Okt): baris lama berejaan lain (' sm a ', disimpan sebelum rilis) tetap terbaca SM A — upper(trim()).
    await pool.query(`INSERT INTO sm_control (id, sm_name, date, created_at) VALUES ('smc-lama', ' sm a ', '2026-10-11', now())`);
    const lama = await jawab(await sebagai("u-sma", () => m.smControl.GET(req("/api/form-kontrol/sm-control?date=2026-10-11"))));
    assert.deepEqual([lama.status, lama.body.total], [200, 1]);
});

// =========================================================================== Hierarki: SPV/SM dipilih dari akun (owner 13 Okt)

test("Hierarki: GET spvOptions/smOptions = nama akun AKTIF ber-role (akhiran dibuang); PUT wajib tepat satu akun — 400/409, ejaan akun, null melepas", { skip: pgSkip }, async () => {
    // Akun tambahan di akhir berkas (tidak memengaruhi uji sebelumnya): nonaktif, nonaktif kedaluwarsa (= aktif), nama ganda, kasus produksi.
    await pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", role, banned, "banExpires", "createdAt", "updatedAt") VALUES
        ('u-spvl', 'SPV LAMA (SPV)', 'spvl@uji.test', true, 'spv', true, NULL, now(), now()),
        ('u-spvk', 'SPV KEMBALI', 'spvk@uji.test', true, 'spv', true, now() - interval '1 day', now(), now()),
        ('u-spvg1', 'SPV GANDA', 'spvg1@uji.test', true, 'spv', false, NULL, now(), now()),
        ('u-spvg2', 'spv ganda (SPV)', 'spvg2@uji.test', true, 'spv', false, NULL, now(), now()),
        ('u-spvs', 'SPV_SYAMSUL', 'spvs@uji.test', true, 'spv', false, NULL, now(), now())`);
    await pool.query(`INSERT INTO user_group (user_id, group_id, assigned_at) VALUES ('u-spvs', 'g-spv', now())`);
    const g = await jawab(await sebagai("u-admin", () => m.profil.GET(req("/api/form-kontrol/sales-profiles"))));
    assert.equal(g.status, 200);
    assert.deepEqual((g.body.spvOptions as string[]).map((n) => n.toUpperCase()), ["SPV A", "SPV B", "SPV GANDA", "SPV KEMBALI", "SPV_SYAMSUL"],
        "nonaktif & nama kosong '(SPV)' tidak; ganda sekali");
    assert.deepEqual(g.body.smOptions, ["SM A"]);
    assert.equal((await sebagai("u-spva", () => m.profil.GET(req("/api/form-kontrol/sales-profiles")))).status, 403, "hanya cakupan global");

    const put = async (isi: Record<string, unknown>) => jawab(await sebagai("u-admin", () => m.profil.PUT(req("/api/form-kontrol/sales-profiles", "PUT", { salesCode: "M-SLD", ...isi }))));
    const simpanan = async () => (await pool.query(`SELECT spv_name, sm_name FROM sales_profile WHERE sales_code = 'M-SLD'`)).rows[0];
    const kode = (j: J) => [j.status, j.body.kode];
    assert.deepEqual(kode(await put({ spvName: "SYAMSUL", smName: null })), [400, "SPV_TIDAK_DIKENAL"], "kasus produksi: ketikan bukan nama akun");
    assert.deepEqual(kode(await put({ spvName: "SPV LAMA", smName: null })), [400, "SPV_TIDAK_DIKENAL"], "akun nonaktif");
    assert.deepEqual(kode(await put({ spvName: "SM A", smName: null })), [400, "SPV_TIDAK_DIKENAL"], "akun ber-role lain");
    assert.deepEqual(kode(await put({ spvName: null, smName: "SM X" })), [400, "SM_TIDAK_DIKENAL"]);
    assert.deepEqual(kode(await put({ spvName: "spv ganda", smName: null })), [409, "NAMA_GANDA"]);
    assert.deepEqual(await simpanan(), { spv_name: null, sm_name: null }, "penolakan tidak menulis apa pun");

    const ok = await put({ spvName: " spv_syamsul ", smName: "sm a" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(await simpanan(), { spv_name: "SPV_SYAMSUL", sm_name: "SM A" }, "ejaan akun");
    const sc = await jawab(await sebagai("u-spvs", () => m.myScope.GET(req("/api/form-kontrol/my-scope"))));
    assert.deepEqual(sc.body.allowedSalesCodes, ["M-SLD"], "akun SPV_SYAMSUL kini melihat timnya");
    assert.deepEqual(kode(await put({ spvName: "SPV KEMBALI", smName: "" })), [200, undefined], "nonaktif kedaluwarsa = aktif");
    assert.equal((await put({ spvName: null, smName: null })).status, 200);
    assert.deepEqual(await simpanan(), { spv_name: null, sm_name: null }, "null melepas");
});
