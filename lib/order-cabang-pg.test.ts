/* O1 (owner 12 Okt 2026) di Postgres EVALUASI (AM040_DATABASE_URL, bukan produksi). Tiap kelompok memakai SKEMA SEKALI-PAKAI (search_path
 * HANYA skema itu, DROP di akhir). Diuji: DDL_O1 (dua kali idempoten, VERIFIKASI + sabotase hak), migrate-pg OK->SKIP + keadaan sebagian
 * + kolom ter-DROP, = db/migrations/0033 = Drizzle; sync item/customer dengan list.do/detail.do TIRUAN (tag -> cabang, suspended,
 * tag tak dikenal tercatat, field absen tidak menimpa); resolvePrices (cabang pelanggan -> default; tanggal berlaku); route ASLI pratinjau,
 * /api/orders/harga, pencarian pelanggan/barang, salesmen?branchId, tautan salesman admin (409, audit, balapan) pada DB nyata; harga beku ->
 * payload faktur. Sesi dipalsukan; izin dari tabel grup nyata. Tanpa env dilewati dengan sebabnya. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { getTableConfig } from "drizzle-orm/pg-core";
import { NextRequest } from "next/server";
import { customer as tCustomer, item as tItem } from "../db/schema.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";

// Bentuk SEBELUM O1 (kolom yang ditulis Drizzle harus ada semua: insert Drizzle menyebut setiap kolom tabel).
const DASAR = `
    CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, role text DEFAULT 'viewer',
        permissions text DEFAULT '{}', banned boolean DEFAULT false, "banExpires" timestamp);
    CREATE TABLE access_group (id text PRIMARY KEY, name text NOT NULL UNIQUE);
    CREATE TABLE user_group (user_id text NOT NULL, group_id text NOT NULL, is_primary boolean NOT NULL DEFAULT false, PRIMARY KEY (user_id, group_id));
    CREATE TABLE group_permission (group_id text NOT NULL, permission_key text NOT NULL, PRIMARY KEY (group_id, permission_key));
    CREATE TABLE permission_audit_log (id text PRIMARY KEY, actor_user_id text, actor_name text, action text NOT NULL, target_user_id text,
        target_group_id text, detail jsonb, created_at timestamp NOT NULL);
    CREATE TABLE sync_state (module text PRIMARY KEY, last_sync_timestamp text, last_page integer DEFAULT 1, status text DEFAULT 'idle', updated_at timestamp);
    CREATE TABLE branch (id bigint PRIMARY KEY, name text NOT NULL, default_branch boolean NOT NULL DEFAULT false, suspended boolean NOT NULL DEFAULT false,
        si_auto_number_id bigint, raw_data jsonb, last_update text, synced_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE item (id bigint PRIMARY KEY, no text NOT NULL, name text NOT NULL, "itemType" text, "unitPrice" double precision,
        quantity double precision, quantity_in_all_unit text, isi_per_karton integer, satuan_besar text,
        unit1_id bigint, unit1_name text, unit2_id bigint, unit2_name text, unit3_id bigint, unit3_name text, unit4_id bigint, unit4_name text,
        unit5_id bigint, unit5_name text, ratio2 double precision, ratio3 double precision, ratio4 double precision, ratio5 double precision,
        has_multi_unit boolean, raw_data jsonb, last_update text, synced_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE customer (id bigint PRIMARY KEY, "customerNo" text NOT NULL, name text NOT NULL, balance double precision, area text, grup_all text,
        grup_gdi text, alamat text, credit_limit_enabled boolean, credit_limit_amount double precision, credit_age_limit_enabled boolean,
        credit_age_limit_days integer, price_category_id bigint, price_category_name text, category_id bigint, category_name text,
        branch_id bigint, branch_name text, raw_data jsonb, last_update text, synced_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE item_selling_price (item_no text NOT NULL, item_id bigint NOT NULL, price_category_id bigint NOT NULL,
        price_category_name text NOT NULL DEFAULT '', unit_name text NOT NULL DEFAULT '', branch_id bigint NOT NULL DEFAULT 0,
        branch_name text NOT NULL DEFAULT '', default_branch boolean NOT NULL DEFAULT false, default_category boolean NOT NULL DEFAULT false,
        price double precision NOT NULL, effective_date date NOT NULL, currency_code text NOT NULL DEFAULT 'IDR',
        synced_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (item_no, price_category_id, unit_name, branch_id, effective_date));
    CREATE TABLE accurate_employee (id bigint PRIMARY KEY, number text NOT NULL DEFAULT '', name text NOT NULL DEFAULT '', branch_id bigint,
        salesman boolean NOT NULL DEFAULT false, suspended boolean NOT NULL DEFAULT false, raw_data jsonb, synced_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE sales_profile (id text PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id), sales_code text NOT NULL UNIQUE,
        sales_name text NOT NULL, principle text NOT NULL, branch text NOT NULL, channel text NOT NULL DEFAULT 'TT', spv_name text, sm_name text,
        accurate_branch_id bigint, created_at timestamp NOT NULL, updated_at timestamp NOT NULL);`;

const berkas = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");
const urlSkema = (skema: string) => {
    const u = new URL(PG_URL);
    u.searchParams.set("options", `-c search_path=${skema}`);
    return u.toString();
};
type Cek = { cek: string; ok: boolean | null };
const barisTerakhir = (hasil: unknown) => { const h = (Array.isArray(hasil) ? hasil : [hasil]) as { rows: Cek[] }[]; return h[h.length - 1].rows; };
const semuaOk = (rows: Cek[]) => { assert.ok(rows.length >= 7, "VERIFIKASI lengkap"); for (const v of rows) assert.notEqual(v.ok, false, `VERIFIKASI gagal: ${v.cek}`); };

const skemaDibuat: string[] = [];
let admin: Pool;
async function skemaBaru(): Promise<{ skema: string; pool: Pool }> {
    const skema = `uji_o1_${randomUUID().slice(0, 8)}`;
    await admin.query(`CREATE SCHEMA ${skema}`);
    skemaDibuat.push(skema);
    const pool = new Pool({ connectionString: urlSkema(skema), max: 3 });
    await pool.query(DASAR);
    return { skema, pool };
}
type Migrasi = { nama: string; sudahAda: string; sql: string };
async function entriO1(): Promise<Migrasi> {
    const { migrations } = await import(new URL("../scripts/migrate-pg.mjs", import.meta.url).href) as { migrations: Migrasi[] };
    const m = migrations.find((x) => x.nama === "order cabang (item/customer O1)");
    assert.ok(m, "entri migrate-pg O1");
    return m;
}
async function migrasi(pool: Pool, m: Migrasi) {
    if ((await pool.query(m.sudahAda)).rowCount) return "SKIP";
    await pool.query(m.sql);
    return "OK";
}
const KOLOM_O1 = [["item", "branch_id"], ["item", "suspended"], ["item", "char_field2"], ["customer", "suspended"]] as const;
async function katalog(pool: Pool) {
    const r = await pool.query(`SELECT c.relname AS t, a.attname AS c, format_type(a.atttypid, a.atttypmod) AS tipe, a.attnotnull AS wajib,
            pg_get_expr(d.adbin, d.adrelid) AS bawaan
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid IN (to_regclass('item'), to_regclass('customer')) AND NOT a.attisdropped
          AND (c.relname, a.attname) IN (('item','branch_id'), ('item','suspended'), ('item','char_field2'), ('customer','suspended'))
        ORDER BY 1, 2`);
    return r.rows;
}

// --------------------------------------------------------------------------- skema utama + modul (DATABASE_URL sebelum lib/db dimuat)

let utama: { skema: string; pool: Pool };
type Route = (req: NextRequest, ctx?: unknown) => Promise<Response>;
let m: Awaited<ReturnType<typeof muatModul>>;
async function muatModul() {
    const r = (p: string) => import(p) as Promise<Record<string, Route>>;
    return {
        db: (await import("./db.ts")).db, auth: (await import("./auth.ts")).auth,
        sync: await import("./sync.ts"), harga: await import("./item-price.ts"), faktur: await import("./accurate-invoice-write.ts"),
        preview: await r("../app/api/orders/preview/route.ts"), hargaRoute: await r("../app/api/orders/harga/route.ts"),
        salesmen: await r("../app/api/orders/salesmen/route.ts"), cariPelanggan: await r("../app/api/customers/search/route.ts"),
        cariBarang: await r("../app/api/items/search/route.ts"), tautan: await r("../app/api/admin/users/[id]/salesman/route.ts"),
    };
}

const CABANG: Array<[number, string, boolean]> = [[101, "KINO NON FOOD", false], [102, "HEINZ", false], [103, "Kantor Pusat", true],
    [104, "MIX NON FOOD", false], [105, "DOLPHIN", false], [106, "MIX FOOD", false]];
// Halaman list.do TIRUAN (bentuk jawaban Accurate: { s, d, sp }).
const BARANG = [
    [{ id: 1, no: "K-01", name: "SABUN ANGGREK", unitPrice: 6306, itemType: "INVENTORY", charField1: "PT KINO", charField2: "KINO NON FOOD", suspended: false },
        { id: 2, no: "K-02", name: "SABUN BUNGA", unitPrice: 6306, charField2: "KINO NON FOOD", suspended: true },
        { id: 3, no: "K-03", name: "SAMPO CEMARA", unitPrice: 4000, charField2: " kino non food ", suspended: false },
        { id: 4, no: "K-04", name: "SABUN TANPA HARGA", charField2: "KINO NON FOOD", suspended: false },
        { id: 5, no: "H-01", name: "SAUS HEINZ", unitPrice: 11000, charField2: "HEINZ ABC", suspended: false },
        { id: 6, no: "M-01", name: "TISU A", charField2: "24MNF1", suspended: false }],
    [{ id: 7, no: "M-02", name: "TISU B", charField2: "21MNF2", suspended: false },
        { id: 8, no: "S-01", name: "SHINZUI SABUN", charField2: "FRN", suspended: false },
        { id: 9, no: "D-01", name: "DOLPHIN A", charField2: "MIX2", suspended: false },
        { id: 10, no: "F-01", name: "MIE A", charField2: "FKS", suspended: false },
        { id: 11, no: "A-01", name: "LAPTOP KANTOR", charField2: "ASSET", suspended: false },
        { id: 12, no: "X-01", name: "BARANG TAG BARU", charField2: "TAG BARU", suspended: false },
        { id: 13, no: "Z-01", name: "BARANG TANPA TAG", suspended: false }],
];
const cab = (id: number) => ({ id, name: CABANG.find((c) => c[0] === id)![1] });
const PELANGGAN = [[
    { id: 9001, customerNo: "C-A001-KN", name: "TOKO ANGGREK", branch: cab(101), category: { id: 1, name: "TT" }, priceCategory: { id: 7, name: "TT" }, suspended: false },
    { id: 9002, customerNo: "C-B002-KN", name: "TOKO BUNGA", branch: cab(101), category: { id: 1, name: "TT" }, priceCategory: { id: 7, name: "TT" }, suspended: true },
    { id: 9003, customerNo: "C-C003-HZ", name: "TOKO CEMARA", branch: cab(102), category: { id: 2, name: "MT" }, priceCategory: { id: 7, name: "TT" }, suspended: false },
    { id: 9004, customerNo: "C-D004-KN", name: "TOKO 50%_DISKON", branch: cab(101), priceCategory: { id: 7, name: "TT" }, suspended: false },
    { id: 9005, customerNo: "C-E005", name: "TOKO TANPA CABANG", priceCategory: { id: 7, name: "TT" }, suspended: false },
    { id: 9006, customerNo: "C-F006-KN", name: "TOKO FAJAR", branch: cab(101), priceCategory: { id: 7, name: "TT" }, suspended: false },
    { id: 9007, customerNo: "C-G007-KN", name: "TOKO 5000 JAYA", branch: cab(101), priceCategory: { id: 7, name: "TT" }, suspended: false },
]];
const DETAIL: Record<string, Record<string, unknown>> = {}; // `${jenis}:${id}` -> jawaban detail.do tiruan
let fetchAsli: typeof fetch;
const dipanggil: string[] = [];
const PREVIEW_DIKIRIM: unknown[] = [];

function fetchTiruan(url: string | URL | Request, init?: RequestInit): Promise<Response> {
    const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    dipanggil.push(u.pathname + u.search);
    const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    const halaman = Number(u.searchParams.get("sp.page") ?? 1);
    if (u.pathname.endsWith("/item/list.do")) return json({ s: true, d: BARANG[halaman - 1] ?? [], sp: { page: halaman, pageCount: BARANG.length, rowCount: 13 } });
    if (u.pathname.endsWith("/customer/list.do")) return json({ s: true, d: PELANGGAN[halaman - 1] ?? [], sp: { page: halaman, pageCount: 1, rowCount: 7 } });
    const det = u.pathname.match(/\/(item|customer)\/detail\.do$/);
    if (det) return json({ s: true, d: DETAIL[`${det[1]}:${u.searchParams.get("id")}`] });
    if (u.pathname === "/orders/preview") {
        PREVIEW_DIKIRIM.push(JSON.parse(String(init?.body ?? "{}")));
        return json({ ok: true, result: { gross: "0", net: "0", lines: [] }, suggestions: [] });
    }
    return json({ s: false, m: `tiruan tak kenal ${u.pathname}` }, 404);
}
const CREDS = { sessionHost: "https://uji.accurate.id", sessionId: "sesi", apiKey: "kunci", databaseId: "db-uji" };

let sesi: string | null = null;
const sebagai = (userId: string | null) => { sesi = userId; };

before(async () => {
    if (!PG_URL) return;
    admin = new Pool({ connectionString: PG_URL, max: 1 });
    utama = await skemaBaru();
    semuaOk(barisTerakhir(await utama.pool.query(await berkas("../docs/handover/DDL_O1.sql"))));
    const p = utama.pool;
    for (const [id, name, def] of CABANG) await p.query("INSERT INTO branch (id, name, default_branch) VALUES ($1, $2, $3)", [id, name, def]);
    await p.query(`INSERT INTO accurate_employee (id, number, name, branch_id, salesman, suspended) VALUES
        (4652, 'M-SLA', 'KN_SALES A', 101, true, false), (4653, 'M-SLB', 'HZ_SALES B', 102, true, false),
        (4654, 'M-OFF', 'KN_SALES NONAKTIF', 101, true, true), (4655, 'M-ADM', 'ADMIN GUDANG', 101, false, false),
        (4656, 'M-SLC', 'KN_SALES C', 101, true, false)`);
    await p.query(`INSERT INTO "user" (id, name, email) VALUES ('u-admin', 'Admin A', 'admin@uji'), ('u-sa', 'Sales A', 'sa@uji'),
        ('u-sb', 'Sales B', 'sb@uji'), ('u-soff', 'Sales Nonaktif', 'soff@uji'), ('u-view', 'Pemantau', 'view@uji')`);
    await p.query(`INSERT INTO access_group (id, name) VALUES ('g-admin', 'Admin'), ('g-sales', 'Salesman'), ('g-view', 'Pemantau')`);
    await p.query(`INSERT INTO group_permission (group_id, permission_key) SELECT 'g-admin', k FROM unnest(ARRAY['order.view', 'order.create',
        'order.edit', 'websales.view', 'websales.create', 'users.manage', 'users.view']) k`);
    await p.query(`INSERT INTO group_permission (group_id, permission_key) VALUES ('g-sales', 'websales.view'), ('g-sales', 'websales.create'),
        ('g-view', 'users.view')`);
    await p.query(`INSERT INTO user_group (user_id, group_id) VALUES ('u-admin', 'g-admin'), ('u-sa', 'g-sales'), ('u-sb', 'g-sales'),
        ('u-soff', 'g-sales'), ('u-view', 'g-view')`);
    await p.query(`INSERT INTO sales_profile (id, user_id, sales_code, sales_name, principle, branch, spv_name, created_at, updated_at) VALUES
        ('sp-a', 'u-sa', 'm-sla ', 'SALES A', 'KINO', 'BANDUNG', 'SPV A', now(), now()),
        ('sp-off', 'u-soff', 'M-OFF', 'SALES NONAKTIF', 'KINO', 'BANDUNG', NULL, now(), now())`);
    // Harga jual (kategori TT = 7). K-01 PCS: KINO 7207 berlaku 1 Agu, KINO 7500 mulai 1 Nov (masa depan), Kantor Pusat (default) 6306
    // berlaku 1 Sep (lebih baru tapi cabang lain — TIDAK boleh menang). K-03: hanya Kantor Pusat -> jatuh ke default. H-01: HEINZ.
    await p.query(`INSERT INTO item_selling_price (item_no, item_id, price_category_id, price_category_name, unit_name, branch_id, branch_name,
            default_branch, price, effective_date) VALUES
        ('K-01', 1, 7, 'TT', 'PCS', 101, 'KINO NON FOOD', false, 7207, '2026-08-01'),
        ('K-01', 1, 7, 'TT', 'PCS', 101, 'KINO NON FOOD', false, 7500, '2026-11-01'),
        ('K-01', 1, 7, 'TT', 'PCS', 103, 'Kantor Pusat', true, 6306, '2026-09-01'),
        ('K-01', 1, 7, 'TT', 'KRT', 101, 'KINO NON FOOD', false, 172968, '2026-08-01'),
        ('K-03', 3, 7, 'TT', 'PCS', 103, 'Kantor Pusat', true, 5000, '2026-07-01'),
        ('H-01', 5, 7, 'TT', 'PCS', 102, 'HEINZ', false, 12000, '2026-08-01'),
        ('H-01', 5, 7, 'TT', 'PCS', 103, 'Kantor Pusat', true, 11500, '2026-09-01')`);

    process.env.DATABASE_URL = urlSkema(utama.skema);
    delete process.env.LOCAL_AUTH_BYPASS;
    process.env.CRON_SECRET = "rahasia-o1";
    m = await muatModul();
    Object.defineProperty(m.auth.api, "getSession", { configurable: true,
        value: async () => (sesi ? { user: { id: sesi, name: sesi, role: "staff" }, session: { id: "s" } } : null) });
    fetchAsli = globalThis.fetch;
    globalThis.fetch = fetchTiruan as typeof fetch;
});

after(async () => {
    if (!PG_URL) return;
    globalThis.fetch = fetchAsli;
    await utama?.pool.end();
    await (await import("./db.ts")).pool.end();
    for (const s of skemaDibuat) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await admin.end();
});

const req = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => new NextRequest(`http://app.test${url}`, {
    method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
});
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
async function panggil(res: Promise<Response>) {
    const r = await res;
    return { status: r.status, body: await r.json() as Record<string, unknown> & { kode?: string; code?: string; error?: string } };
}
const ORDER = (customer_no: string, lines: Array<[string, string, string?]>, extra: Record<string, unknown> = {}) => ({
    channel: "GT", order_date: "2026-10-12", customer_no, lines: lines.map(([code, unit, quantity = "2"]) => ({ code, unit, quantity })), ...extra,
});
const pratinjau = (userId: string, body: unknown) => { sebagai(userId); return panggil(m.preview.POST(req("POST", "/api/orders/preview", body))); };

// =========================================================================== DDL / migrasi

test("PG O1: DDL_O1 dua kali idempoten + VERIFIKASI; migrate-pg OK->SKIP, sebagian, kolom ter-DROP; = 0033 = Drizzle", { skip: pgSkip }, async () => {
    const ddl = await berkas("../docs/handover/DDL_O1.sql");
    const berkasMigrasi = await berkas("../db/migrations/0033_order_cabang.sql");
    const entri = await entriO1();

    const a = await skemaBaru();
    assert.equal(await migrasi(a.pool, entri), "OK");
    assert.equal(await migrasi(a.pool, entri), "SKIP", "sesudah kolom ada entri dilewati (tanpa ALTER = tanpa crash loop non-pemilik)");
    const b = await skemaBaru();
    semuaOk(barisTerakhir(await b.pool.query(ddl)));
    semuaOk(barisTerakhir(await b.pool.query(ddl)));
    assert.equal(await migrasi(b.pool, entri), "SKIP", "DDL manual sebelum image -> migrate-pg SKIP");
    const c = await skemaBaru();
    await c.pool.query(berkasMigrasi);
    const [ka, kb, kc] = [await katalog(a.pool), await katalog(b.pool), await katalog(c.pool)];
    assert.equal(ka.length, 4);
    assert.deepEqual(kb, ka, "DDL_O1 = migrate-pg");
    assert.deepEqual(kc, ka, "0033 = migrate-pg");
    // = Drizzle (db/schema.ts): tipe, wajib, bawaan.
    const drizzle = KOLOM_O1.map(([t, c]) => {
        const col = getTableConfig(t === "item" ? tItem : tCustomer).columns.find((x) => x.name === c)!;
        return { t, c, tipe: col.getSQLType(), wajib: col.notNull, bawaan: col.hasDefault ? String(col.default) : null };
    }).sort((x, y) => `${x.t}.${x.c}`.localeCompare(`${y.t}.${y.c}`));
    assert.deepEqual(ka.map((r) => ({ t: r.t, c: r.c, tipe: r.tipe, wajib: r.wajib, bawaan: r.bawaan })), drizzle);

    // Sebagian (hanya kolom item) -> sudahAda false -> entri melengkapi. Kolom ter-DROP (attisdropped) tidak dihitung ada.
    const d = await skemaBaru();
    await d.pool.query("ALTER TABLE item ADD COLUMN branch_id bigint, ADD COLUMN suspended boolean NOT NULL DEFAULT false, ADD COLUMN char_field2 text");
    assert.equal(await migrasi(d.pool, entri), "OK");
    await d.pool.query("ALTER TABLE customer DROP COLUMN suspended");
    assert.equal(await migrasi(d.pool, entri), "OK", "kolom ter-DROP = belum ada");
    assert.deepEqual(await katalog(d.pool), ka);

    // VERIFIKASI hak accapi_app (role sementara di transaksi yang di-ROLLBACK): hak tabel penuh -> true; cabut UPDATE item -> false.
    const verif = ddl.slice(ddl.lastIndexOf("COMMIT;") + "COMMIT;".length);
    const k = await b.pool.connect();
    try {
        await k.query("BEGIN");
        await k.query("CREATE ROLE accapi_app NOLOGIN");
        await k.query(`GRANT USAGE ON SCHEMA ${b.skema} TO accapi_app`);
        await k.query("GRANT SELECT, INSERT, UPDATE ON item, customer TO accapi_app");
        await k.query("GRANT SELECT, INSERT, UPDATE, DELETE ON sales_profile TO accapi_app");
        await k.query("GRANT INSERT ON permission_audit_log TO accapi_app");
        const penuh = (await k.query(verif)).rows as Cek[];
        for (const v of penuh) assert.equal(v.ok, true, `hak penuh: ${v.cek}`);
        await k.query("REVOKE UPDATE ON item FROM accapi_app");
        await k.query("REVOKE DELETE ON sales_profile FROM accapi_app");
        const kurang = (await k.query(verif)).rows as Cek[];
        assert.equal(kurang.find((v) => v.cek.startsWith("accapi_app boleh SELECT/INSERT/UPDATE kolom"))?.ok, false, "sabotase hak kolom terbaca");
        assert.equal(kurang.find((v) => v.cek.includes("sales_profile"))?.ok, false, "sabotase hak sales_profile terbaca");
    } finally {
        await k.query("ROLLBACK");
        k.release();
    }
});

// =========================================================================== sync (list.do / detail.do tiruan)

test("PG O1 sync: item -> cabang dari tag (22 nama + 6 peta), non-jual/tak dikenal/kosong NULL + tercatat, suspended; pelanggan suspended", { skip: pgSkip }, async () => {
    const hasil = await m.sync.syncModule("item", CREDS) as { success: boolean; rows: number; tagTakDikenal?: Record<string, number> };
    assert.equal(hasil.success, true, JSON.stringify(hasil));
    assert.equal(hasil.rows, 13);
    assert.deepEqual(hasil.tagTakDikenal, { "TAG BARU": 1, "(kosong)": 1 }, "tag tak dikenal tercatat, bukan diam");
    assert.ok(dipanggil.some((u) => u.includes("/item/list.do") && decodeURIComponent(u).includes("charField2,suspended,preferedVendor")), "fields diminta");
    const rows = (await utama.pool.query("SELECT no, branch_id, suspended, char_field2 FROM item ORDER BY id")).rows;
    const cabangOf = Object.fromEntries(rows.map((r) => [r.no, r.branch_id === null ? null : Number(r.branch_id)]));
    assert.deepEqual(cabangOf, { "K-01": 101, "K-02": 101, "K-03": 101, "K-04": 101, "H-01": 102, "M-01": 104, "M-02": 104, "M-03": 104,
        "D-01": 105, "F-01": 106, "A-01": null, "X-01": null, "Z-01": null });
    assert.deepEqual(rows.filter((r) => r.suspended).map((r) => r.no), ["K-02"]);
    assert.equal(rows.find((r) => r.no === "K-03").char_field2, " kino non food ", "teks tag asli disimpan untuk audit");
    const perCabang = (await utama.pool.query(`SELECT coalesce(b.name, '(tak bisa diorder)') AS cabang, count(*)::int AS n FROM item i
        LEFT JOIN branch b ON b.id = i.branch_id GROUP BY 1 ORDER BY 1`)).rows;
    console.log("[O1 data uji] barang per cabang:", JSON.stringify(perCabang));

    // Webhook item (detail.do) TANPA field suspended: suspended lama TETAP; tag berubah -> cabang ikut berubah.
    DETAIL["item:2"] = { id: 2, no: "K-02", name: "SABUN BUNGA", charField2: "KINO NON FOOD" };
    DETAIL["item:12"] = { id: 12, no: "X-01", name: "BARANG TAG BARU", charField2: "FKS", suspended: false };
    await m.sync.upsertMasterById("item", 2, CREDS);
    await m.sync.upsertMasterById("item", 12, CREDS);
    const sesudah = Object.fromEntries((await utama.pool.query("SELECT no, branch_id, suspended FROM item WHERE id IN (2, 12)")).rows
        .map((r) => [r.no, [r.branch_id === null ? null : Number(r.branch_id), r.suspended]]));
    assert.deepEqual(sesudah, { "K-02": [101, true], "X-01": [106, false] });
    // Kembalikan X-01 ke tag tak dikenal untuk uji berikutnya (barang tak bisa diorder).
    DETAIL["item:12"] = { ...DETAIL["item:12"], charField2: "TAG BARU" };
    await m.sync.upsertMasterById("item", 12, CREDS);
    // list.do ulang dengan suspended BERUBAH menimpa baris lama (raw_data = string JSON di jsonb; CASE harus mengurainya).
    BARANG[0][2].suspended = true;
    await m.sync.syncModule("item", CREDS);
    assert.equal((await utama.pool.query("SELECT suspended FROM item WHERE no = 'K-03'")).rows[0].suspended, true);
    BARANG[0][2].suspended = false;
    await m.sync.syncModule("item", CREDS);
    assert.equal((await utama.pool.query("SELECT suspended FROM item WHERE no = 'K-03'")).rows[0].suspended, false);

    const pel = await m.sync.syncModule("customer", CREDS) as { success: boolean; rows: number };
    assert.equal(pel.success, true, JSON.stringify(pel));
    assert.deepEqual((await utama.pool.query("SELECT \"customerNo\" FROM customer WHERE suspended")).rows.map((r) => r.customerNo), ["C-B002-KN"]);
    // detail.do pelanggan tanpa suspended -> tetap; dengan suspended eksplisit -> ditimpa.
    DETAIL["customer:9002"] = { id: 9002, customerNo: "C-B002-KN", name: "TOKO BUNGA", branchId: 101, customerBranchName: "KINO NON FOOD" };
    await m.sync.upsertMasterById("customer", 9002, CREDS);
    DETAIL["customer:9006"] = { id: 9006, customerNo: "C-F006-KN", name: "TOKO FAJAR", branchId: 101, suspended: true };
    await m.sync.upsertMasterById("customer", 9006, CREDS);
    const s1 = (await utama.pool.query("SELECT \"customerNo\" FROM customer WHERE suspended ORDER BY 1")).rows.map((r) => r.customerNo);
    assert.deepEqual(s1, ["C-B002-KN", "C-F006-KN"]);
    DETAIL["customer:9006"] = { ...DETAIL["customer:9006"], suspended: false };
    await m.sync.upsertMasterById("customer", 9006, CREDS);
    assert.equal((await utama.pool.query("SELECT suspended FROM customer WHERE id = 9006")).rows[0].suspended, false);
});

// =========================================================================== harga per cabang pelanggan

test("PG O1 resolvePrices: cabang pelanggan dulu (bukan cabang default yang lebih baru), tanggal berlaku <= tanggal order, default bila tak ada", { skip: pgSkip }, async () => {
    const r = (code: string, unit: string, orderDate: string, branchId?: number) =>
        m.harga.resolvePrices([{ code, unit }], { orderDate, customerNo: "C-A001-KN", branchId }).then((x) => x[0]);
    const kino = await r("K-01", "PCS", "2026-10-12", 101);
    assert.deepEqual([kino.price, kino.branchName, kino.effectiveDate], [7207, "KINO NON FOOD", "2026-08-01"]);
    assert.equal((await r("K-01", "PCS", "2026-11-02", 101)).price, 7500, "kenaikan terjadwal berlaku sejak tanggalnya");
    assert.equal((await r("K-01", "PCS", "2026-07-15", 101)).price, 6306, "sebelum harga KINO berlaku: tidak ada baris KINO <= tanggal -> default");
    const fallback = await r("K-03", "PCS", "2026-10-12", 101);
    assert.deepEqual([fallback.price, fallback.branchName], [5000, "Kantor Pusat"], "cabang pelanggan tanpa baris -> cabang default");
    // Bug lama (tanpa cabang pelanggan) = cabang default: inilah yang diperbaiki pratinjau.
    assert.equal((await r("K-01", "PCS", "2026-10-12")).price, 6306);
});

// =========================================================================== pratinjau + /api/orders/harga

test("PG O1 pratinjau: harga dari cabang PELANGGAN (branch_id badan diabaikan); kode galat cabang/pelanggan/barang/salesman", { skip: pgSkip }, async () => {
    const ok = await pratinjau("u-sa", ORDER("C-A001-KN", [["K-01", "PCS"], ["K-01", "KRT", "1"], ["K-03", "pcs"]], { branch_id: 103 }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const prices = ok.body.prices as Array<{ code: string; unit: string; price: number; branchName: string }>;
    assert.deepEqual(prices.map((p) => [p.code, p.unit, p.price, p.branchName]),
        [["K-01", "PCS", 7207, "KINO NON FOOD"], ["K-01", "KRT", 172968, "KINO NON FOOD"], ["K-03", "PCS", 5000, "Kantor Pusat"]]);
    const dikirim = PREVIEW_DIKIRIM.at(-1) as { lines: Array<{ price: string }> };
    assert.deepEqual(dikirim.lines.map((l) => l.price), ["7207", "172968", "5000"], "harga server yang diteruskan ke promo");
    assert.equal((ok.body.pelanggan as { branchName: string }).branchName, "KINO NON FOOD");

    const kasus: Array<[string, unknown, number, string]> = [
        ["u-sa", ORDER("C-A001-KN", [["H-01", "PCS"]]), 409, "BARANG_BEDA_CABANG"],
        ["u-sa", ORDER("C-A001-KN", [["A-01", "PCS"]]), 409, "BARANG_BEDA_CABANG"],
        ["u-sa", ORDER("C-A001-KN", [["X-01", "PCS"]]), 409, "BARANG_BEDA_CABANG"],
        ["u-sa", ORDER("C-A001-KN", [["K-02", "PCS"]]), 409, "BARANG_SUSPENDED"],
        ["u-sa", ORDER("C-A001-KN", [["NOPE", "PCS"]]), 409, "BARANG_TIDAK_ADA"],
        ["u-sa", ORDER("C-A001-KN", [["K-01", "LSN"]]), 409, "SATUAN_SALAH"],
        ["u-sa", ORDER("C-A001-KN", [["K-04", "PCS"]]), 409, "HARGA_BELUM_ADA"],
        ["u-sa", ORDER("C-B002-KN", [["K-01", "PCS"]]), 409, "PELANGGAN_SUSPENDED"],
        ["u-sa", ORDER("C-ZZZ", [["K-01", "PCS"]]), 409, "PELANGGAN_TIDAK_ADA"],
        ["u-admin", ORDER("C-E005", [["K-01", "PCS"]]), 409, "PELANGGAN_TANPA_CABANG"],
        ["u-sa", ORDER("", [["K-01", "PCS"]]), 400, "PELANGGAN_WAJIB"],
        ["u-sa", ORDER("C-C003-HZ", [["H-01", "PCS"]]), 403, "CABANG_DI_LUAR_CAKUPAN"],
        ["u-sb", ORDER("C-A001-KN", [["K-01", "PCS"]]), 403, "SALESMAN_BELUM_TERHUBUNG"],
        ["u-soff", ORDER("C-A001-KN", [["K-01", "PCS"]]), 403, "SALESMAN_TIDAK_AKTIF"],
    ];
    for (const [u, body, status, kode] of kasus) {
        const r = await pratinjau(u, body);
        assert.deepEqual([r.status, r.body.kode], [status, kode], `${u} ${JSON.stringify(body)} -> ${JSON.stringify(r.body)}`);
        assert.ok(String(r.body.error).length > 10, "kalimat jelas");
    }
    const beda = await pratinjau("u-sa", ORDER("C-A001-KN", [["H-01", "PCS"]]));
    assert.deepEqual((beda.body.barang as Array<{ code: string; branchName: string }>).map((b) => [b.code, b.branchName]), [["H-01", "HEINZ"]]);
    assert.match(String((await pratinjau("u-sa", ORDER("C-A001-KN", [["A-01", "PCS"]]))).body.error), /tag "ASSET" tidak bisa diorder/);
    assert.deepEqual((await pratinjau("u-sa", ORDER("C-A001-KN", [["K-01", "LSN"]]))).body.wrong_unit, [{ code: "K-01", unit: "LSN", known_units: ["KRT", "PCS"] }]);
    // Petugas internal (order.view) = semua cabang: pelanggan HEINZ diterima dengan harga HEINZ (bukan default 11500).
    const adm = await pratinjau("u-admin", ORDER("C-C003-HZ", [["H-01", "PCS"]]));
    assert.equal(adm.status, 200, JSON.stringify(adm.body));
    assert.equal((adm.body.prices as Array<{ price: number }>)[0].price, 12000);
});

test("PG O1 /api/orders/harga: CRON = semua cabang + harga beku -> payload faktur; harga:false hanya aturan cabang; sesi sales tercakup", { skip: pgSkip }, async () => {
    sebagai(null);
    const cron = { authorization: "Bearer rahasia-o1" };
    const hz = await panggil(m.hargaRoute.POST(req("POST", "/api/orders/harga", { customer_no: "C-C003-HZ", order_date: "2026-10-12",
        lines: [{ code: "H-01", unit: "pcs", quantity: "3" }] }, cron)));
    assert.equal(hz.status, 200, JSON.stringify(hz.body));
    assert.deepEqual(hz.body.lines, [{ code: "H-01", unit: "PCS", quantity: "3", price: "12000" }]);
    const tanpaHarga = await panggil(m.hargaRoute.POST(req("POST", "/api/orders/harga", { customer_no: "C-A001-KN", order_date: "2026-10-12", harga: false,
        lines: [{ code: "K-04", unit: "PCS", quantity: "1" }, { code: "K-01", unit: "LSN", quantity: "1" }] }, cron)));
    assert.equal(tanpaHarga.status, 200, "input internal (harga petugas): satuan/harga master tidak diperiksa");
    const bedaCron = await panggil(m.hargaRoute.POST(req("POST", "/api/orders/harga", { customer_no: "C-A001-KN", order_date: "2026-10-12", harga: false,
        lines: [{ code: "H-01", unit: "PCS" }] }, cron)));
    assert.deepEqual([bedaCron.status, bedaCron.body.kode], [409, "BARANG_BEDA_CABANG"], "aturan cabang tetap berlaku untuk input internal");

    sebagai("u-sa");
    const luar = await panggil(m.hargaRoute.POST(req("POST", "/api/orders/harga", { customer_no: "C-C003-HZ", order_date: "2026-10-12",
        lines: [{ code: "H-01", unit: "PCS" }] })));
    assert.deepEqual([luar.status, luar.body.kode], [403, "CABANG_DI_LUAR_CAKUPAN"]);
    const milik = await panggil(m.hargaRoute.POST(req("POST", "/api/orders/harga", { customer_no: "C-A001-KN", order_date: "2026-10-12",
        lines: [{ code: "K-01", unit: "PCS", quantity: "2" }] })));
    assert.equal(milik.status, 200);
    const baris = milik.body.lines as Array<{ code: string; unit: string; quantity: string; price: string }>;

    // BL-18: harga yang dibekukan pada order = harga di payload faktur (tidak dihitung ulang saat kirim).
    const order = {
        id: "o1000000-0000-4000-8000-000000000001", customer_no: "C-A001-KN", outlet: "TOKO ANGGREK", channel: "GT", order_date: "2026-10-12",
        status: "draft", lines: baris, sources: [{ draft_id: "d1d1d1d1", revision: 1 }],
        result: { gross: "14414.00", discount: "0.00", net: "14414.00", lines: [{ code: "K-01", unit: "PCS", quantity: "2", gross: "14414.00", net: "14414.00" }] },
    };
    const payload = m.faktur.buildInvoicePayload(order, { unitIds: new Map([["PCS", 50]]), branchId: 101, typeAutoNumber: 7 });
    assert.equal(payload.detailItem[0].unitPrice, 7207);
    assert.throws(() => m.faktur.buildInvoicePayload({ ...order, result: { pending_price: true } }, { unitIds: new Map([["PCS", 50]]), branchId: 101, typeAutoNumber: 7 }),
        /needs_price/, "order tanpa harga tetap tidak bisa difakturkan");
});

// =========================================================================== pencarian

test("PG O1 cari pelanggan: salesman hanya cabangnya (lain = 403), tanpa suspended/tanpa cabang; admin semua/saring; LIKE ter-escape; galat ≠ kosong", { skip: pgSkip }, async () => {
    const cari = async (u: string, qs: string) => { sebagai(u); return panggil(m.cariPelanggan.GET(req("GET", `/api/customers/search${qs}`))); };
    const kodeOf = (r: { body: Record<string, unknown> }) => (r.body.items as Array<{ customerNo: string }>).map((x) => x.customerNo);

    const sa = await cari("u-sa", "");
    assert.equal(sa.status, 200);
    assert.deepEqual(kodeOf(sa).sort(), ["C-A001-KN", "C-D004-KN", "C-F006-KN", "C-G007-KN"]);
    assert.deepEqual(sa.body.cakupan, { semua: false, branchId: 101, branchName: "KINO NON FOOD" });
    assert.equal((await cari("u-sa", "?branchId=101")).status, 200);
    const luar = await cari("u-sa", "?branchId=102");
    assert.deepEqual([luar.status, luar.body.kode], [403, "CABANG_DI_LUAR_CAKUPAN"]);
    assert.deepEqual((await cari("u-sb", "?q=toko")).body.kode, "SALESMAN_BELUM_TERHUBUNG");

    const semua = await cari("u-admin", "?q=TOKO&limit=50");
    assert.deepEqual(kodeOf(semua).sort(), ["C-A001-KN", "C-C003-HZ", "C-D004-KN", "C-F006-KN", "C-G007-KN"], "tanpa suspended & tanpa cabang");
    assert.deepEqual(kodeOf(await cari("u-admin", "?branchId=102")), ["C-C003-HZ"]);
    const hz = (await cari("u-admin", "?branchId=102")).body.items as Array<{ channel: string; branchName: string }>;
    assert.deepEqual([hz[0].channel, hz[0].branchName], ["MT", "HEINZ"]);
    assert.deepEqual(kodeOf(await cari("u-admin", "?q=50%25")), ["C-D004-KN"], "% literal, bukan pola (TOKO 5000 JAYA tidak ikut)");
    assert.deepEqual(kodeOf(await cari("u-admin", "?q=50_")), [], "_ literal");
    assert.deepEqual(kodeOf(await cari("u-admin", "?q=c-a001-kn")), ["C-A001-KN"], "kode, huruf apa pun");
    assert.equal(kodeOf(await cari("u-admin", "?q=toko&limit=2")).length, 2);

    // Galat DB = galat (500 oleh Next), BUKAN daftar kosong.
    await utama.pool.query("ALTER TABLE customer RENAME TO customer_x");
    try {
        sebagai("u-admin");
        await assert.rejects(m.cariPelanggan.GET(req("GET", "/api/customers/search?q=toko")));
    } finally {
        await utama.pool.query("ALTER TABLE customer_x RENAME TO customer");
    }
});

test("PG O1 cari barang: hanya cabang pelanggan, tanpa suspended/non-jual/tak dikenal; satuan + harga per cabang pelanggan; cakupan salesman", { skip: pgSkip }, async () => {
    const cari = async (u: string, qs: string) => { sebagai(u); return panggil(m.cariBarang.GET(req("GET", `/api/items/search${qs}`))); };
    type Barang = { no: string; units: Array<{ unit: string; price?: number | null; source?: string; branchName?: string | null }> };
    const noOf = (r: { body: Record<string, unknown> }) => (r.body.items as Barang[]).map((x) => x.no);

    const kino = await cari("u-sa", "?customerId=9001&tanggal=2026-10-12");
    assert.equal(kino.status, 200, JSON.stringify(kino.body));
    assert.deepEqual(noOf(kino).sort(), ["K-01", "K-03", "K-04"]);
    const items = kino.body.items as Barang[];
    assert.deepEqual(items.find((x) => x.no === "K-01")!.units.map((u) => [u.unit, u.price, u.branchName]),
        [["KRT", 172968, "KINO NON FOOD"], ["PCS", 7207, "KINO NON FOOD"]]);
    assert.deepEqual(items.find((x) => x.no === "K-03")!.units.map((u) => [u.unit, u.price, u.branchName]), [["PCS", 5000, "Kantor Pusat"]]);
    assert.deepEqual(items.find((x) => x.no === "K-04")!.units, [], "tanpa daftar harga = tanpa satuan sah");
    assert.deepEqual(noOf(await cari("u-sa", "")).sort(), ["K-01", "K-03", "K-04"], "tanpa pelanggan: cabang salesman");
    const tanpaPelanggan = (await cari("u-sa", "?q=K-01")).body.items as Barang[];
    assert.deepEqual(tanpaPelanggan[0].units, [{ unit: "KRT" }, { unit: "PCS" }], "tanpa pelanggan: satuan tanpa harga");

    const luar = await cari("u-sa", "?customerId=9003");
    assert.deepEqual([luar.status, luar.body.kode], [403, "CABANG_DI_LUAR_CAKUPAN"]);
    assert.deepEqual((await cari("u-sa", "?branchId=104")).body.kode, "CABANG_DI_LUAR_CAKUPAN");
    const hz = await cari("u-admin", "?customerId=9003");
    assert.deepEqual(noOf(hz), ["H-01"]);
    assert.deepEqual((hz.body.items as Barang[])[0].units.map((u) => u.price), [12000], "harga HEINZ, bukan default");
    assert.deepEqual(noOf(await cari("u-admin", "?branchId=104")).sort(), ["M-01", "M-02", "M-03"]);
    assert.equal((await cari("u-admin", "?customerId=9001&branchId=102")).status, 400);
    assert.deepEqual((await cari("u-admin", "?customerId=9002")).body.kode, "PELANGGAN_SUSPENDED");
    assert.deepEqual((await cari("u-admin", "?customerId=9005")).body.kode, "PELANGGAN_TANPA_CABANG");
    assert.deepEqual((await cari("u-admin", "?customerId=1")).body.kode, "PELANGGAN_TIDAK_ADA");
    const semua = noOf(await cari("u-admin", "?limit=50")).sort();
    assert.deepEqual(semua, ["D-01", "F-01", "H-01", "K-01", "K-03", "K-04", "M-01", "M-02", "M-03"], "tanpa K-02 (suspended), A-01, X-01, Z-01");
    assert.deepEqual(noOf(await cari("u-admin", "?q=tisu%20b")), ["M-02"]);
});

test("PG O1 salesmen?branchId: hanya salesman aktif cabang itu; tanpa = semua aktif", { skip: pgSkip }, async () => {
    sebagai("u-admin");
    const nomor = async (qs: string) => ((await panggil(m.salesmen.GET(req("GET", `/api/orders/salesmen${qs}`)))).body.salesmen as Array<{ number: string }>)
        .map((s) => s.number).sort();
    assert.deepEqual(await nomor("?branchId=101"), ["M-SLA", "M-SLC"]);
    assert.deepEqual(await nomor("?branchId=102"), ["M-SLB"]);
    assert.deepEqual(await nomor(""), ["M-SLA", "M-SLB", "M-SLC"]);
});

// =========================================================================== tautan salesman (admin)

test("PG O1 tautan salesman: tetapkan/ganti/lepas + audit; 409 berkode; satu karyawan <-> satu akun (balapan); cakupan ikut tautan", { skip: pgSkip }, async () => {
    const t = m.tautan;
    const put = (u: string, target: string, employeeNumber: unknown) => { sebagai(u); return panggil(t.PUT(req("PUT", `/x`, { employeeNumber }), ctx(target))); };
    const del = (u: string, target: string) => { sebagai(u); return panggil(t.DELETE(req("DELETE", "/x"), ctx(target))); };
    const audit = async () => (await utama.pool.query("SELECT action, target_user_id, detail FROM permission_audit_log ORDER BY created_at, id")).rows;

    sebagai("u-view");
    const lihat = await panggil(t.GET(req("GET", "/x"), ctx("u-sa")));
    assert.equal(lihat.status, 200, "users.view boleh membaca");
    assert.deepEqual((lihat.body.tautan as Array<{ salesCode: string; branchName: string; aktif: boolean }>).map((x) => [x.salesCode, x.branchName, x.aktif]),
        [["m-sla ", "KINO NON FOOD", true]]);
    const pilihan = lihat.body.pilihan as Array<{ number: string; terhubungKe: { userId: string } | null }>;
    assert.deepEqual(pilihan.map((p) => [p.number, p.terhubungKe?.userId ?? null]), [["M-SLB", null], ["M-SLA", "u-sa"], ["M-SLC", null]],
        "hanya salesman aktif (tanpa M-OFF/M-ADM), urut cabang lalu nama");
    assert.equal((await put("u-view", "u-sb", "M-SLC")).status, 403);

    for (const [nomor, status, kode] of [["m-sla", 409, "KARYAWAN_SUDAH_TERHUBUNG"], ["M-OFF", 409, "KARYAWAN_BUKAN_SALESMAN_AKTIF"],
        ["M-ADM", 409, "KARYAWAN_BUKAN_SALESMAN_AKTIF"], ["NOPE", 404, "KARYAWAN_TIDAK_ADA"]] as const) {
        const r = await put("u-admin", "u-sb", nomor);
        assert.deepEqual([r.status, r.body.code], [status, kode], `${nomor}: ${JSON.stringify(r.body)}`);
    }
    assert.deepEqual((await put("u-admin", "u-nope", "M-SLC")).body.code, "USER_TIDAK_ADA");
    assert.equal((await audit()).length, 0, "penolakan tidak menulis audit");

    const pasang = await put("u-admin", "u-sb", " m-slc ");
    assert.equal(pasang.status, 200, JSON.stringify(pasang.body));
    assert.deepEqual([pasang.body.changed, (pasang.body.tautan as { branchName: string }).branchName], [true, "KINO NON FOOD"]);
    const profil = (await utama.pool.query("SELECT sales_code, sales_name, principle, branch, accurate_branch_id FROM sales_profile WHERE user_id = 'u-sb'")).rows;
    assert.deepEqual(profil, [{ sales_code: "M-SLC", sales_name: "KN_SALES C", principle: "KINO NON FOOD", branch: "KINO NON FOOD", accurate_branch_id: null }]);
    assert.equal((await pratinjau("u-sb", ORDER("C-A001-KN", [["K-01", "PCS"]]))).status, 200, "tautan membuka order cabangnya");
    assert.equal((await put("u-admin", "u-sb", "M-SLC")).body.changed, false);
    assert.equal((await audit()).length, 1, "tanpa perubahan = tanpa audit");

    const ganti = await put("u-admin", "u-sb", "M-SLB");
    assert.equal(ganti.body.changed, true);
    assert.deepEqual((await pratinjau("u-sb", ORDER("C-A001-KN", [["K-01", "PCS"]]))).body.kode, "CABANG_DI_LUAR_CAKUPAN", "cabang ikut karyawan baru");
    assert.equal((await pratinjau("u-sb", ORDER("C-C003-HZ", [["H-01", "PCS"]]))).status, 200);
    const jejak = await audit();
    assert.deepEqual(jejak.map((a) => a.action), ["salesman.link", "salesman.link"]);
    assert.deepEqual([jejak[1].detail.sebelum.salesCode, jejak[1].detail.sesudah.salesCode, jejak[1].detail.sesudah.branchName], ["M-SLC", "M-SLB", "HEINZ"]);

    const lepas = await del("u-admin", "u-sb");
    assert.equal(lepas.body.changed, true);
    assert.equal((await utama.pool.query("SELECT count(*)::int AS n FROM sales_profile WHERE user_id = 'u-sb'")).rows[0].n, 0);
    const unlink = (await audit()).at(-1);
    assert.equal(unlink.action, "salesman.unlink");
    assert.equal(unlink.detail.dihapus[0].salesCode, "M-SLB", "baris utuh tersimpan di audit");
    assert.equal((await del("u-admin", "u-sb")).body.changed, false);
    assert.equal((await pratinjau("u-sb", ORDER("C-A001-KN", [["K-01", "PCS"]]))).body.kode, "SALESMAN_BELUM_TERHUBUNG");

    // Profil Form Kontrol lama (spv) tetap saat kode diganti: hanya sales_code/sales_name.
    assert.equal((await put("u-admin", "u-sa", "M-SLA")).body.changed, true, "kode 'm-sla ' dirapikan ke nomor Accurate");
    assert.deepEqual((await utama.pool.query("SELECT sales_code, spv_name FROM sales_profile WHERE user_id = 'u-sa'")).rows, [{ sales_code: "M-SLA", spv_name: "SPV A" }]);

    // Balapan: dua admin menautkan M-SLC ke dua akun bersamaan -> tepat satu menang, satu 409 (kunci otorisasi global).
    sebagai("u-admin");
    const [x, y] = await Promise.all([
        panggil(t.PUT(req("PUT", "/x", { employeeNumber: "M-SLC" }), ctx("u-sb"))),
        panggil(t.PUT(req("PUT", "/x", { employeeNumber: "M-SLC" }), ctx("u-soff"))),
    ]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409], JSON.stringify([x.body, y.body]));
    assert.equal((await utama.pool.query("SELECT count(*)::int AS n FROM sales_profile WHERE upper(trim(sales_code)) = 'M-SLC'")).rows[0].n, 1);
});
