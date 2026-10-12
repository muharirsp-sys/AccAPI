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
    "salesman_daily_report", "merchandising_check", "kontrol_audit_log", "customer", "branch", "accurate_employee", "item"];
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
        auth: (await import("../auth.ts")).auth,
        dbMod: await import("../db.ts"),
        ao: await r("../../app/api/form-kontrol/ao-control/route.ts"),
        jks: await r("../../app/api/form-kontrol/jks/route.ts"),
        reports: await r("../../app/api/form-kontrol/reports/route.ts"),
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
    const p = pool;
    await p.query(`INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt") VALUES
        ('u-sla', 'Sales A', 'sla@uji.test', true, 'staff', now(), now()),
        ('u-slb', 'Sales B', 'slb@uji.test', true, 'staff', now(), now()),
        ('u-slc', 'Sales C', 'slc@uji.test', true, 'staff', now(), now()),
        ('u-spva', 'SPV A (SPV)', 'spva@uji.test', true, 'spv', now(), now()),
        ('u-spvb', 'SPV B', 'spvb@uji.test', true, 'spv', now(), now()),
        ('u-admin', 'Admin A', 'admin@uji.test', true, 'admin', now(), now())`);
    await p.query(`INSERT INTO access_group (id, name, created_at, updated_at) VALUES ('g-sales', 'Salesman', now(), now()),
        ('g-spv', 'SPV', now(), now()), ('g-admin', 'Admin', now(), now())`);
    await p.query(`INSERT INTO group_permission (group_id, permission_key) SELECT 'g-sales', k FROM unnest(ARRAY['form_kontrol.view',
        'form_kontrol.submit', 'websales.view', 'websales.create']) k`);
    await p.query(`INSERT INTO group_permission (group_id, permission_key) SELECT 'g-spv', k FROM unnest(ARRAY['form_kontrol.view', 'form_kontrol.submit']) k`);
    await p.query(`INSERT INTO group_permission (group_id, permission_key) SELECT 'g-admin', k FROM unnest(ARRAY['form_kontrol.view', 'form_kontrol.submit',
        'form_kontrol.manage', 'order.view', 'order.create', 'websales.create']) k`);
    await p.query(`INSERT INTO user_group (user_id, group_id, assigned_at) SELECT u, g, now() FROM (VALUES ('u-sla', 'g-sales'),
        ('u-slb', 'g-sales'), ('u-slc', 'g-sales'), ('u-spva', 'g-spv'), ('u-spvb', 'g-spv'), ('u-admin', 'g-admin')) v(u, g)`);
    // Nama SPV di Hierarki tidak rapi (spasi, huruf) — sengaja: butir 5. SPV A = profil M-SLA + M-SLB; SPV B = M-SLC. Akun SPV tanpa profil.
    await p.query(`INSERT INTO sales_profile (id, user_id, sales_code, sales_name, principle, branch, spv_name, accurate_linked, created_at, updated_at) VALUES
        ('sp-a', 'u-sla', 'M-SLA', 'SALES A', 'PRINCIPLE A', 'CABANG A', ' spv a ', true, now(), now()),
        ('sp-b', 'u-slb', 'M-SLB', 'SALES B', 'PRINCIPLE B', 'CABANG A', 'SPV A', false, now(), now()),
        ('sp-c', 'u-slc', 'M-SLC', 'SALES C', 'PRINCIPLE C', 'CABANG B', 'SPV B', true, now(), now())`);
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

test("butir 2: JKS hari HURUF BESAR/berspasi/JUM'AT terbaca tanpa unggah ulang; minggu genap/ganjil (minggu ISO)", { skip: pgSkip }, async () => {
    // Senin 12 Okt 2026 = minggu ISO 42 (genap): ganjil C-100001 TIDAK, genap C-100003 + all C-100004 ya; JKS nonaktif tidak.
    assert.deepEqual(await rute("u-sla", "2026-10-12"), ["C-100003", "C-100004"]);
    // Senin 19 Okt = minggu 43 (ganjil).
    assert.deepEqual(await rute("u-sla", "2026-10-19"), ["C-100001", "C-100004"]);
    assert.deepEqual(await rute("u-sla", "2026-10-16"), ["C-100005"], "JUM'AT = Jumat");
    assert.deepEqual(await rute("u-sla", "2026-10-13"), ["C-100006"]);
    assert.deepEqual(await rute("u-sla", "2026-10-18"), [], "Minggu tanpa rute");
    // Laporan harian (live, belum dikirim) menghitung toko JKS hari itu dengan aturan yang sama (lintas principal).
    const lap = await jawab(await sebagai("u-sla", () => m.reports.GET(req("/api/form-kontrol/reports?salesCode=M-SLA&date=2026-10-12"))));
    assert.equal(Number((lap.body.rows as { totalTokoJks: unknown }[])[0].totalTokoJks), 2); // count(*) pg = teks (perilaku lama)
});

test("butir 2: unggah JKS menyimpan hari BAKU; hari tak dikenal ditolak per baris (tidak ditulis)", { skip: pgSkip }, async () => {
    const baris = (cust: string, hari: string, pola = "all") => ({ salesCode: "M-SLC", salesName: "SALES C", custCode: cust, custName: `TOKO ${cust}`,
        principle: "PRINCIPLE C", hariKunjungan: hari, mingguPattern: pola });
    const r = await jawab(await sebagai("u-admin", () => m.jks.POST(req("/api/form-kontrol/jks", "POST", { rows: [
        baris("U-1", "SABTU"), baris("U-2", " jum'at ", "GANJIL"), baris("U-3", "Minggu"), baris("U-4", "Senen"), baris("U-5", ""),
    ] }))));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.imported, 3);
    assert.deepEqual(r.body.ditolak, [
        { baris: 3, custCode: "U-3", hari: "Minggu" },
        { baris: 4, custCode: "U-4", hari: "Senen" },
    ]);
    const db = (await pool.query(`SELECT cust_code, hari_kunjungan, minggu_pattern FROM jks_master WHERE cust_code LIKE 'U-%' ORDER BY 1`)).rows;
    assert.deepEqual(db, [
        { cust_code: "U-1", hari_kunjungan: "Sabtu", minggu_pattern: "all" },
        { cust_code: "U-2", hari_kunjungan: "Jumat", minggu_pattern: "ganjil" },
        { cust_code: "U-5", hari_kunjungan: null, minggu_pattern: "all" },
    ]);
    await pool.query(`DELETE FROM jks_master WHERE cust_code LIKE 'U-%'`);
});
