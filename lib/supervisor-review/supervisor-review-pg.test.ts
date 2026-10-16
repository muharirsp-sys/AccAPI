/* Supervisor Review SR-1 di Postgres EVALUASI (AM040_DATABASE_URL, bukan produksi): SKEMA SEKALI-PAKAI (tabel disalin `LIKE public.*` +
 * db/migrations/0033..0035 + docs/handover/DDL_SUPERVISOR_REVIEW.sql, search_path hanya skema itu, DROP di akhir). Sesi Better Auth dipalsukan;
 * izin dari tabel grup nyata; route memakai `headers()` -> lingkup permintaan Next tiruan (pola lib/form-kontrol/noo-pg.test.ts); Accurate
 * dipalsukan lewat globalThis.fetch.
 * Dibuktikan: sinkron faktur lewat titik masuk ASLI (webhook upsertSalesInvoiceById + cron syncModule list.do) mengisi ringkasan dan list.do
 * TIDAK mengosongkannya; backfill (--cek hanya menghitung, idempoten, synced_at tetap, CLI node --experimental-strip-types); GET
 * /api/supervisor-review per cakupan (SPV tim, SM bawahan TIDAK 403, global + "tanpa salesman" + faktur belum terbaca, filter cabang/principle,
 * akun belum tertaut, tanpa izin 403, tanggal salah 400) dengan check-in UTC -> jam WITA; unggah koordinat (penolakan per baris Excel, baris
 * sah tersimpan); No HP Hierarki; DDL 2× idempoten + VERIFIKASI (+ sabotase), migrate-pg OK->SKIP, DDL = migrate-pg = 0036 = Drizzle;
 * RBAC_PRESET_SUPERVISOR_REVIEW idempoten. Data contoh generik. Tanpa env dilewati. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import * as XLSX from "xlsx";
import { getTableConfig } from "drizzle-orm/pg-core";
import { salesInvoiceCache, salesProfile, tokoKoordinat } from "../../db/schema.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";
const AKAR = fileURLToPath(new URL("../../", import.meta.url));

const TABEL = ["user", "access_group", "user_group", "group_permission", "permission_audit_log", "sales_profile", "jks_master", "ao_control_daily",
    "customer", "branch", "accurate_employee", "item", "sales_code_merge", "sales_invoice", "sync_state"];
const skema = `uji_sr1_${randomUUID().slice(0, 8)}`;
const skemaLain: string[] = [];
let admin: Pool;
let pool: Pool;
const urlSkema = (s = skema) => { const u = new URL(PG_URL); u.searchParams.set("options", `-c search_path=${s}`); return u.toString(); };
const berkas = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");
const TGL = "2026-10-12"; // Senin minggu genap
const CREDS = { sessionHost: "http://accurate.uji", sessionId: "s", apiKey: "k" };

type Route = (req: Request, ctx?: unknown) => Promise<Response>;
async function muat() {
    (globalThis as Record<string, unknown>).AsyncLocalStorage ??= AsyncLocalStorage;
    const r = (p: string) => import(p) as Promise<Record<string, Route>>;
    return {
        ...await import("next/dist/server/app-render/work-async-storage.external.js"),
        ...await import("next/dist/server/app-render/work-unit-async-storage.external.js"),
        auth: (await import("../auth.ts")).auth,
        dbMod: await import("../db.ts"),
        sync: await import("../sync.ts"),
        backfill: await import("../../scripts/backfill-ringkas-faktur.mjs") as { backfill: (p: Pool, o: object) => Promise<Record<string, number>> },
        sr: await r("../../app/api/supervisor-review/route.ts"),
        koord: await r("../../app/api/supervisor-review/koordinat/route.ts"),
        profil: await r("../../app/api/form-kontrol/sales-profiles/route.ts"),
    };
}
let m: Awaited<ReturnType<typeof muat>>;

type Sesi = { id: string; name: string; role: string };
const sesiAls = new AsyncLocalStorage<Sesi | null>();
async function sebagai<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const sesi: Sesi | null = (await pool.query(`SELECT id, name, role FROM "user" WHERE id = $1`, [userId])).rows[0] ?? null;
    const store = { route: "/uji", forceStatic: false, dynamicShouldError: false };
    const unit = { type: "private-cache", phase: "render", headers: new Headers({ host: "app.test" }) };
    return sesiAls.run(sesi, () => m.workAsyncStorage.run(store as never, () => m.workUnitAsyncStorage.run(unit as never, fn)));
}
type J = { status: number; body: Record<string, unknown>; header: Headers };
const jawab = async (res: Response): Promise<J> => ({ status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown>, header: res.headers });
const ringkas = async (u: string, q = `?tanggal=${TGL}`) => jawab(await sebagai(u, () => m.sr.GET(new Request(`http://app.test/api/supervisor-review${q}`))));
type Baris = { salesCode: string; cabang: string; nama: string; [k: string]: unknown };

/** Accurate palsu: detail.do -> { s, d: faktur }; list.do -> satu halaman. */
const fetchAsli = globalThis.fetch;
function palsukanAccurate(jawabanUrl: (url: string) => unknown) {
    globalThis.fetch = (async (u: string | URL | Request) => new Response(JSON.stringify(jawabanUrl(String(u))),
        { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
}
const FAKTUR = (id: number, o: Record<string, unknown> = {}) => ({ id, number: `INV/CBA/${id}`, transDate: "12/10/2026",
    customer: { customerNo: "C-1-CBA", name: "TOKO A" }, totalAmount: 111000, primeOwing: 0, statusName: "Lunas", lastUpdate: "12/10/2026 10:00:00",
    masterSalesmanId: 1, detailItem: [{ quantity: 1, unitRatio: 12, quantityDefault: 12, dppAmount: 100000 }], ...o });
/** Bentuk jawaban list.do (fields sync): tanpa detailItem dan masterSalesmanId. */
const tanpaRincian = (f: Record<string, unknown>) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== "detailItem" && k !== "masterSalesmanId"));
async function webhook(f: Record<string, unknown>) {
    palsukanAccurate(() => ({ s: true, d: f }));
    try { await m.sync.upsertSalesInvoiceById(Number(f.id), CREDS); } finally { globalThis.fetch = fetchAsli; }
}
const ringkasDb = async (id: number) => (await pool.query(`SELECT salesman_id::int s, qty_total::float q, jumlah_item i, dpp::float d, total_amount t
    FROM sales_invoice WHERE id = $1`, [id])).rows[0] as { s: number | null; q: number | null; i: number | null; d: number | null; t: number };

before(async () => {
    if (!PG_URL) return;
    admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${skema}`);
    for (const t of TABEL) await admin.query(`CREATE TABLE ${skema}."${t}" (LIKE public."${t}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    pool = new Pool({ connectionString: urlSkema(), max: 3 });
    for (const f of ["0033_order_cabang", "0034_kunjungan_luar_rute", "0035_noo_toko"]) await pool.query(await berkas(`../../db/migrations/${f}.sql`));
    await pool.query(await berkas("../../docs/handover/DDL_SUPERVISOR_REVIEW.sql"));
    const p = pool;
    await p.query(`INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt") VALUES
        ('u-spva', 'SPV A (SPV)', 'spva@uji.test', true, 'spv', now(), now()), ('u-spvx', 'SPV X (SPV)', 'spvx@uji.test', true, 'spv', now(), now()),
        ('u-sma', 'SM A (SM)', 'sma@uji.test', true, 'sm', now(), now()), ('u-admin', 'Admin A', 'admin@uji.test', true, 'admin', now(), now()),
        ('u-vw', 'Viewer A', 'vw@uji.test', true, 'manager', now(), now()), ('u-sla', 'Sales A', 'sla@uji.test', true, 'staff', now(), now())`);
    await p.query(`INSERT INTO access_group (id, name, created_at, updated_at) VALUES ('g-spv', 'SPV', now(), now()), ('g-sm', 'SM', now(), now()),
        ('g-admin', 'Admin', now(), now()), ('g-mgr', 'Manager', now(), now()), ('g-vw', 'Viewer', now(), now())`);
    await p.query(`INSERT INTO group_permission (group_id, permission_key) VALUES ('g-spv', 'supervisor_review.view'), ('g-sm', 'supervisor_review.view'),
        ('g-admin', 'supervisor_review.view'), ('g-admin', 'form_kontrol.manage'), ('g-mgr', 'supervisor_review.view'), ('g-vw', 'form_kontrol.view')`);
    await p.query(`INSERT INTO user_group (user_id, group_id, assigned_at) SELECT u, g, now() FROM (VALUES ('u-spva', 'g-spv'), ('u-spvx', 'g-spv'),
        ('u-sma', 'g-sm'), ('u-admin', 'g-admin'), ('u-vw', 'g-vw')) v(u, g)`);
    // SPV A: M-SLA. SM A: M-SLA + M-SLB. M-SLC di bawah SPV B/SM B. M-SLD (karyawan id 4) tanpa profil; karyawan id 5 tanpa nomor.
    await p.query(`INSERT INTO sales_profile (id, user_id, sales_code, sales_name, principle, branch, channel, spv_name, sm_name, created_at, updated_at) VALUES
        ('sp-a', 'u-sla', 'M-SLA', 'SALES A', 'PRINCIPLE A', 'CABANG A', 'TT', 'SPV A', 'SM A', now(), now()),
        ('sp-b', 'u-sla', 'M-SLB', 'SALES B', 'PRINCIPLE B', 'CABANG A', 'TT', 'SPV B', 'SM A', now(), now()),
        ('sp-c', 'u-sla', 'M-SLC', 'SALES C', 'PRINCIPLE A', 'CABANG B', 'TT', 'SPV B', 'SM B', now(), now())`);
    await p.query(`INSERT INTO branch (id, name) VALUES (201, 'CABANG A'), (202, 'CABANG B')`);
    await p.query(`INSERT INTO accurate_employee (id, number, name, branch_id, salesman, suspended) VALUES (1, 'M-SLA', 'SALES A', 201, true, false),
        (2, 'M-SLB', 'SALES B', 201, true, false), (3, 'M-SLC', 'SALES C', 202, true, false), (4, 'M-SLD', 'SALES D', 202, true, false),
        (5, '', 'TANPA KODE', 201, true, false)`);
    await p.query(`INSERT INTO customer (id, "customerNo", name, branch_id, branch_name, suspended) VALUES (1, 'C-1-CBA', 'TOKO A', 201, 'CABANG A', false),
        (5, 'C-5-CBA', 'TOKO F', 201, 'CABANG A', false), (7, 'C-7-CBA', 'TOKO G', 201, 'CABANG A', false), (9, 'C-9-CBB', 'TOKO H', 202, 'CABANG B', false)`);
    await p.query(`INSERT INTO jks_master (id, sales_code, sales_name, cust_code, cust_name, hari_kunjungan, minggu_pattern, principle, channel,
            visit_frequency, is_active, created_at, updated_at) VALUES
        ('j1', 'M-SLA', 'SALES A', 'C-1', 'TOKO A', 'SENIN', 'all', 'PRINCIPLE A', 'TT', 4, true, now(), now()),
        ('j2', 'M-SLA', 'SALES A', 'C-2', 'TOKO B', 'Senin', 'all', 'PRINCIPLE A', 'TT', 4, true, now(), now()),
        ('j3', 'M-SLB', 'SALES B', 'C-20', 'TOKO E', 'Senin', 'all', 'PRINCIPLE B', 'TT', 4, true, now(), now()),
        ('j4', 'M-SLB', 'SALES B', 'C-21', 'TOKO NONAKTIF', 'Senin', 'all', 'PRINCIPLE B', 'TT', 4, false, now(), now())`);
    // checkin_at/checkout_at = timestamp TANPA zona berisi UTC (probe produksi 14 Okt): 01:00 = 09:00 WITA.
    await p.query(`INSERT INTO ao_control_daily (id, sales_code, cust_code, principle, date, period_month, period_year, status, checkin_at, checkout_at,
            checkin_lat, checkin_lng, created_at, updated_at) VALUES
        ('a1', 'M-SLA', 'C-1', 'PRINCIPLE A', '${TGL}', 10, 2026, 'ordered', '2026-10-12 01:00:00', '2026-10-12 01:30:00', -5.1477, 119.4328, now(), now()),
        ('a2', 'M-SLA', 'C-30', 'PRINCIPLE A', '${TGL}', 10, 2026, 'not_order', '2026-10-12 02:00:00', '2026-10-12 02:10:00', NULL, NULL, now(), now()),
        ('a3', 'M-SLA', 'C-2', 'PRINCIPLE A', '2026-10-11', 10, 2026, 'ordered', '2026-10-11 01:00:00', NULL, NULL, NULL, now(), now())`);
    await p.query(`INSERT INTO kunjungan_luar_rute (id, sales_code, principle, tanggal, cust_code, cust_name, dibuat_oleh) VALUES
        ('l1', 'M-SLA', 'PRINCIPLE A', '${TGL}', 'C-30', 'TOKO LUAR A', 'u-sla')`);
    await p.query(`INSERT INTO noo_toko (id, kode, sales_code, principle, branch_id, tanggal, nama_toko, nama_pemilik, alamat, no_hp, nik, nama_ktp, foto_ktp,
            foto_toko, lat, lng, akurasi, dibuat_oleh) VALUES ('n1', 'NOO-AAAA0001', 'M-SLA', 'PRINCIPLE A', 201, '${TGL}', 'TOKO BARU A', 'PEMILIK A',
            'JL. A', '081200000001', '7371010101010012', 'PEMILIK A', '${randomUUID()}.jpg', '${randomUUID()}.jpg', -5.1, 119.4, 10, 'u-sla')`);

    process.env.DATABASE_URL = urlSkema();
    delete process.env.LOCAL_AUTH_BYPASS;
    m = await muat();
    Object.defineProperty(m.auth.api, "getSession", { configurable: true,
        value: async () => { const sesi = sesiAls.getStore(); return sesi ? { user: { ...sesi, email: `${sesi.id}@uji.test` }, session: { id: "s" } } : null; } });
});

after(async () => {
    if (!PG_URL) return;
    globalThis.fetch = fetchAsli;
    await pool?.end();
    await m?.dbMod.pool.end();
    for (const s of [skema, ...skemaLain]) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await admin.end();
});

test("PG sinkron: webhook detail.do mengisi ringkasan; cron list.do (tanpa detailItem) TIDAK mengosongkan; salesman dikosongkan di Accurate ikut kosong", { skip: pgSkip }, async () => {
    await webhook(FAKTUR(101));
    assert.deepEqual(await ringkasDb(101), { s: 1, q: 12, i: 1, d: 100000, t: 111000 });
    await webhook(FAKTUR(102, { customer: { customerNo: "C-5-CBA", name: "TOKO F" }, detailItem: [{ quantity: 6, unitRatio: 1, dppAmount: 50000 }] }));
    await webhook(FAKTUR(103, { customer: { customerNo: "C-7-CBA", name: "TOKO G" }, masterSalesmanId: 5 })); // karyawan tanpa nomor
    await webhook(FAKTUR(104, { customer: { customerNo: "C-9-CBB", name: "TOKO H" }, masterSalesmanId: 4 })); // M-SLD tanpa profil
    await webhook(FAKTUR(106, { number: "SR/CBA/106" })); // bukan INV -> tidak dihitung

    palsukanAccurate((url) => (url.includes("/sales-invoice/list.do") ? { s: true, sp: { pageCount: 1, rowCount: 2 },
        d: [tanpaRincian(FAKTUR(101, { totalAmount: 222000 })), tanpaRincian(FAKTUR(105, { customer: { customerNo: "C-9-CBB", name: "TOKO H" } }))] }
        : { s: false, m: `tak terduga ${url}` }));
    try {
        const hasil = await m.sync.syncModule("sales_invoice", CREDS);
        assert.equal(hasil.success, true, hasil.message);
    } finally { globalThis.fetch = fetchAsli; }
    assert.deepEqual(await ringkasDb(101), { s: 1, q: 12, i: 1, d: 100000, t: 222000 }, "list.do memperbarui total tetapi ringkasan tetap");
    assert.deepEqual(await ringkasDb(105), { s: null, q: null, i: null, d: null, t: 111000 }, "faktur baru dari list.do = rincian belum terbaca");

    await webhook(FAKTUR(107, { transDate: "11/10/2026" }));
    await webhook(FAKTUR(107, { transDate: "11/10/2026", masterSalesmanId: null, detailItem: [{ quantityDefault: 3, dppAmount: 30000 }] }));
    assert.deepEqual(await ringkasDb(107), { s: null, q: 3, i: 1, d: 30000, t: 111000 }, "jawaban BER-rincian menang utuh");
});

test("PG backfill: --cek hanya menghitung; isi baris qty_total NULL dari raw_data STRING; idempoten; synced_at tetap; CLI strip-types", { skip: pgSkip }, async () => {
    const sisip = (id: number, tgl: string, f: Record<string, unknown>) => pool.query(`INSERT INTO sales_invoice (id, number, trans_date, raw_data, synced_at)
        VALUES ($1, $2, $3, to_jsonb($4::text), '2026-01-01T00:00:00Z')`, [id, `INV/CBA/${id}`, tgl, JSON.stringify(f)]);
    await sisip(201, "10/10/2026", FAKTUR(201, { masterSalesmanId: 2, detailItem: [{ quantity: 2, unitRatio: 6, dppAmount: "1234.5" }, { quantityDefault: 1, dppAmount: 1 }] }));
    await sisip(202, "10/10/2026", tanpaRincian(FAKTUR(202)));
    await sisip(203, "01/10/2026", FAKTUR(203)); // di luar jendela 3 hari
    const log: string[] = [];
    const opsi = { hariIni: TGL, hari: 3, log: (s: string) => log.push(s) };
    const cek = await m.backfill.backfill(pool, { ...opsi, cek: true });
    assert.equal(cek.kosong, 3, "201 + 202 (10/10) + 105 (12/10, list.do)");
    assert.equal((await ringkasDb(201)).q, null, "--cek tidak menulis");
    const satu = await m.backfill.backfill(pool, opsi);
    assert.deepEqual([satu.kosong, satu.diisi, satu.tanpaRincian], [3, 1, 2]);
    assert.deepEqual(await ringkasDb(201), { s: 2, q: 13, i: 2, d: 1235.5, t: null as unknown as number });
    assert.equal((await ringkasDb(203)).q, null, "di luar jendela tidak disentuh");
    const dua = await m.backfill.backfill(pool, opsi);
    assert.deepEqual([dua.kosong, dua.diisi], [2, 0], "jalan kedua: hanya yang memang tanpa rincian");
    assert.equal((await pool.query(`SELECT synced_at = '2026-01-01T00:00:00Z' ok FROM sales_invoice WHERE id = 201`)).rows[0].ok, true, "synced_at tidak berubah");
    const keluar = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/backfill-ringkas-faktur.mjs", "--cek", "--hari", "2"],
        { cwd: AKAR, env: { ...process.env, DATABASE_URL: urlSkema() }, encoding: "utf8", timeout: 60_000 });
    assert.match(keluar, /CEK: \d+ kosong/);
    await pool.query(`DELETE FROM sales_invoice WHERE id IN (201, 202, 203)`);
});

test("PG koordinat: unggah xlsx -> tolak per baris Excel (kode bukan JKS, bukan angka, luar Indonesia), baris sah tersimpan; GET ringkasan; izin", { skip: pgSkip }, async () => {
    const xlsx = (aoa: unknown[][]) => {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Koordinat");
        const f = new FormData();
        f.set("file", new File([new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }))], "k.xlsx"));
        return f;
    };
    const unggah = async (u: string, f: FormData) => jawab(await sebagai(u, () => m.koord.POST(new Request("http://app.test/api/supervisor-review/koordinat",
        { method: "POST", body: f }))));
    const r = await unggah("u-admin", xlsx([["Kode Toko", "Latitude", "Longitude"], ["c-1", -5.1477, 119.4327], ["C-404", -5, 119], ["C-2", "abc", 119], [],
        ["C-20", 40.7, -74]]));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.disimpan, 1);
    assert.deepEqual((r.body.ditolak as { baris: number; kode: string }[]).map((d) => [d.baris, d.kode]), [[3, "C-404"], [4, "C-2"], [6, "C-20"]]);
    assert.deepEqual((await pool.query(`SELECT cust_code, lat, lng, diperbarui_oleh FROM toko_koordinat`)).rows,
        [{ cust_code: "C-1", lat: -5.1477, lng: 119.4327, diperbarui_oleh: "u-admin" }]);
    assert.equal((await unggah("u-admin", xlsx([["Toko", "X"], ["C-1", 1]]))).body.kode, "KOLOM_TIDAK_LENGKAP");
    assert.equal((await unggah("u-spva", xlsx([["Kode Toko", "Latitude", "Longitude"]]))).status, 403, "SPV tanpa form_kontrol.manage");
    const g = await jawab(await sebagai("u-admin", () => m.koord.GET(new Request("http://app.test/api/supervisor-review/koordinat"))));
    assert.deepEqual(g.body, { tokoJks: 3, berKoordinat: 1, contohTanpaKoordinat: [{ custCode: "C-2", namaToko: "TOKO B" }, { custCode: "C-20", namaToko: "TOKO E" }] });
});

test("PG No HP Hierarki: PUT noHp saja menormalkan + hierarki tetap; tidak sah 400 NO_HP_TIDAK_SAH; GET rows memuat noHp; kosong = hapus", { skip: pgSkip }, async () => {
    const put = async (isi: Record<string, unknown>) => jawab(await sebagai("u-admin", () => m.profil.PUT(new Request("http://app.test/api/form-kontrol/sales-profiles",
        { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(isi) }))));
    const ok = await put({ salesCode: "M-SLB", noHp: "+62 812-3456-7890" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual((await pool.query(`SELECT no_hp, spv_name, sm_name FROM sales_profile WHERE sales_code = 'M-SLB'`)).rows[0],
        { no_hp: "081234567890", spv_name: "SPV B", sm_name: "SM A" });
    const salah = await put({ salesCode: "M-SLB", noHp: "12345" });
    assert.deepEqual([salah.status, salah.body.kode], [400, "NO_HP_TIDAK_SAH"]);
    const g = await jawab(await sebagai("u-admin", () => m.profil.GET()));
    assert.equal((g.body.rows as { salesCode: string; noHp: string | null }[]).find((x) => x.salesCode === "M-SLB")?.noHp, "081234567890");
    await put({ salesCode: "M-SLA", noHp: "0812 9999 0001" });
    assert.equal((await put({ salesCode: "M-SLB", noHp: "" })).status, 200);
    assert.equal((await pool.query(`SELECT no_hp FROM sales_profile WHERE sales_code = 'M-SLB'`)).rows[0].no_hp, null);
    await assert.rejects(pool.query(`UPDATE sales_profile SET no_hp = '0212345678' WHERE sales_code = 'M-SLC'`), /sales_profile_no_hp/, "CHECK DB menolak bukan seluler");
});

test("PG GET /api/supervisor-review: cakupan SPV / SM (tidak 403) / global, check-in UTC -> WITA, faktur belum terbaca, filter, galat", { skip: pgSkip }, async () => {
    const spv = await ringkas("u-spva");
    assert.equal(spv.status, 200, JSON.stringify(spv.body));
    assert.equal(spv.body.cakupan, "spv");
    const rows = spv.body.salesman as Baris[];
    assert.deepEqual(rows.map((r) => r.salesCode), ["M-SLA"]);
    const a = rows[0];
    assert.deepEqual([a.cabang, a.status, a.registeredOutlet, a.callPlan, a.callRute, a.callNonRute, a.ec, a.noo, a.quantity, a.nilaiOrder, a.jamDiToko,
        a.jamPerjalanan], ["CABANG A", "sudah", 2, 2, 1, 2, 2, 1, 18, 150000, 0.67, 0.5]);
    assert.match(String(a.waUrl), /^https:\/\/wa\.me\/6281299990001\?text=/);
    const k = (spv.body.kunjungan as { custCode: string; jenis: string; mulai: string | null; namaToko: string; jarakKeTokoM: number | null }[]);
    assert.deepEqual(k.map((x) => [x.custCode, x.jenis, x.mulai, x.namaToko]), [["C-1", "rute", "2026-10-12T09:00:00+08:00", "TOKO A"],
        ["C-30", "luar_rute", "2026-10-12T10:00:00+08:00", "TOKO LUAR A"], ["C-5-CBA", "tanpa_checkin", null, "TOKO F"]]);
    assert.equal(k[0].jarakKeTokoM, 11, "titik check-in vs toko_koordinat C-1");
    assert.deepEqual((spv.body.penanda as { custCode: string; status: string }[]).map((p) => [p.custCode, p.status]), [["C-1", "ec"]]);
    assert.equal(spv.body.tokoTanpaKoordinat, 1, "C-2");
    assert.deepEqual(spv.body.fakturBelumTerbaca, [], "faktur belum terbaca cabang lain tidak tampil ke SPV");
    assert.equal(spv.header.get("cache-control"), "private, no-store", "angka terkini, bukan cache 5 menit /api/form-kontrol");

    const sm = await ringkas("u-sma");
    assert.equal(sm.status, 200, "SM tidak lagi 403");
    assert.deepEqual([sm.body.cakupan, (sm.body.salesman as Baris[]).map((r) => r.salesCode)], ["sm", ["M-SLA", "M-SLB"]]);

    const g = await ringkas("u-admin");
    assert.equal(g.body.cakupan, "global");
    assert.deepEqual((g.body.salesman as Baris[]).map((r) => [r.cabang, r.salesCode, r.nama]), [["CABANG A", "M-SLA", "SALES A"], ["CABANG A", "M-SLB", "SALES B"],
        ["CABANG A", "", "Tanpa salesman terpetakan"], ["CABANG B", "M-SLC", "SALES C"], ["CABANG B", "M-SLD", "SALES D"]]);
    assert.deepEqual(g.body.fakturBelumTerbaca, [{ cabang: "CABANG B", jumlah: 1 }]);
    assert.deepEqual([g.body.pilihanCabang, g.body.pilihanPrinciple], [["CABANG A", "CABANG B"], ["PRINCIPLE A", "PRINCIPLE B"]]);
    const tA = (g.body.totalCabang as Baris[]).find((t) => t.cabang === "CABANG A")!;
    assert.deepEqual([tA.ec, tA.nilaiOrder], [3, 250000], "M-SLA 2 + tanpa salesman 1; 150.000 + 100.000");
    const cb = await ringkas("u-admin", `?tanggal=${TGL}&cabang=CABANG%20B`);
    assert.deepEqual([(cb.body.salesman as Baris[]).map((r) => r.salesCode), cb.body.fakturBelumTerbaca], [["M-SLC", "M-SLD"], [{ cabang: "CABANG B", jumlah: 1 }]]);
    const pr = await ringkas("u-admin", `?tanggal=${TGL}&principle=PRINCIPLE%20A`);
    assert.deepEqual([(pr.body.salesman as Baris[]).map((r) => r.salesCode), pr.body.fakturBelumTerbaca], [["M-SLA", "M-SLC"], []]);

    const lepas = await ringkas("u-spvx");
    assert.deepEqual([lepas.status, (lepas.body.pesan as { kode: string }).kode, lepas.body.salesman], [200, "HIERARKI_BELUM_TERTAUT", []]);
    assert.equal((await ringkas("u-vw")).status, 403, "tanpa supervisor_review.view");
    assert.equal((await ringkas("u-admin", "?tanggal=2026-13-01")).body.kode, "TANGGAL_TIDAK_SAH");
    const bawaan = await ringkas("u-admin", "");
    assert.equal(bawaan.body.tanggal, new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date()), "bawaan = hari ini WITA");
});

// =========================================================================== DDL / migrasi / RBAC

type Cek = { cek: string; ok: boolean | null };
const barisTerakhir = (hasil: unknown) => { const h = (Array.isArray(hasil) ? hasil : [hasil]) as { rows: Cek[] }[]; return h[h.length - 1].rows; };
/** Skema baru berbentuk produksi SEBELUM SR-1 (public), + prasyarat VERIFIKASI. */
async function skemaBaru() {
    const s = `uji_sr1d_${randomUUID().slice(0, 8)}`;
    await admin.query(`CREATE SCHEMA ${s}`);
    skemaLain.push(s);
    for (const t of ["sales_invoice", "sales_profile", "jks_master", "ao_control_daily", "customer", "branch", "accurate_employee", "sales_code_merge"]) {
        await admin.query(`CREATE TABLE ${s}."${t}" (LIKE public."${t}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`);
    }
    for (const t of ["kunjungan_luar_rute", "noo_toko"]) await admin.query(`CREATE TABLE ${s}."${t}" (LIKE ${skema}."${t}" INCLUDING DEFAULTS)`);
    return { skema: s, pool: new Pool({ connectionString: urlSkema(s), max: 2 }) };
}
async function katalog(p: Pool) {
    const kol = (await p.query(`SELECT c.relname AS t, a.attname AS c, format_type(a.atttypid, a.atttypmod) AS tipe, a.attnotnull AS wajib,
            pg_get_expr(d.adbin, d.adrelid) AS bawaan
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid IN (to_regclass('toko_koordinat'), to_regclass('sales_invoice'), to_regclass('sales_profile')) AND a.attnum > 0 AND NOT a.attisdropped
            AND (c.relname = 'toko_koordinat' OR a.attname IN ('salesman_id', 'qty_total', 'jumlah_item', 'dpp', 'no_hp')) ORDER BY 1, a.attnum`)).rows;
    const cek = (await p.query(`SELECT conname, pg_get_constraintdef(oid) d FROM pg_constraint
        WHERE conrelid IN (to_regclass('toko_koordinat'), to_regclass('sales_profile')) AND conname IN ('toko_koordinat_pkey', 'toko_koordinat_wilayah', 'sales_profile_no_hp')
        ORDER BY 1`)).rows;
    return { kol, cek };
}

test("PG DDL_SUPERVISOR_REVIEW dua kali idempoten + VERIFIKASI (+ sabotase hak/CHECK); migrate-pg OK->SKIP; DDL = migrate-pg = 0036 = Drizzle", { skip: pgSkip }, async () => {
    const PERAN_UJI = `uji_app_${randomUUID().slice(0, 8)}`;
    const ddl = (await berkas("../../docs/handover/DDL_SUPERVISOR_REVIEW.sql")).replaceAll("accapi_app", PERAN_UJI);
    const { migrations } = await import(new URL("../../scripts/migrate-pg.mjs", import.meta.url).href) as { migrations: { nama: string; sudahAda: string; sql: string }[] };
    const entri = migrations.find((x) => x.nama === "supervisor review (SR-1)");
    assert.ok(entri, "entri migrate-pg");
    assert.equal(migrations.at(-1), entri, "entri terakhir (sesudah noo_toko)");
    const migrasi = async (p: Pool) => ((await p.query(entri.sudahAda)).rowCount ? "SKIP" : (await p.query(entri.sql), "OK"));

    const a = await skemaBaru();
    assert.equal(await migrasi(a.pool), "OK");
    assert.equal(await migrasi(a.pool), "SKIP", "sesudah kolom + CHECK ada entri dilewati");
    const b = await skemaBaru();
    for (let i = 0; i < 2; i++) {
        const v = barisTerakhir(await b.pool.query(ddl));
        assert.equal(v.length, 8, "VERIFIKASI lengkap");
        for (const x of v) assert.notEqual(x.ok, false, `VERIFIKASI gagal: ${x.cek}`);
    }
    assert.equal(await migrasi(b.pool), "SKIP", "DDL manual sebelum image -> migrate-pg SKIP");
    const c = await skemaBaru();
    await c.pool.query(await berkas("../../db/migrations/0036_supervisor_review.sql"));
    const [ka, kb, kc] = [await katalog(a.pool), await katalog(b.pool), await katalog(c.pool)];
    assert.equal(ka.kol.length, 10, "4 kolom sales_invoice + no_hp + 5 kolom toko_koordinat");
    assert.equal(ka.cek.length, 3, "PK + 2 CHECK");
    assert.deepEqual(kb, ka, "DDL = migrate-pg");
    assert.deepEqual(kc, ka, "0036 = migrate-pg");
    const norm = (t: string) => t.replace(/, /g, ",");
    const drizzle = [...getTableConfig(salesInvoiceCache).columns, ...getTableConfig(salesProfile).columns, ...getTableConfig(tokoKoordinat).columns]
        .filter((x) => ka.kol.some((k) => k.c === x.name)).map((x) => ({ c: x.name, tipe: norm(x.getSQLType()), wajib: x.notNull, bawaan: x.hasDefault }));
    assert.deepEqual(drizzle.sort((p, q) => p.c.localeCompare(q.c)), ka.kol.map((x) => ({ c: x.c, tipe: norm(String(x.tipe)), wajib: x.wajib,
        bawaan: x.bawaan !== null })).sort((p, q) => p.c.localeCompare(q.c)), "Drizzle = katalog");
    assert.deepEqual([...getTableConfig(tokoKoordinat).checks, ...getTableConfig(salesProfile).checks].map((x) => x.name).sort(),
        ["sales_profile_no_hp", "toko_koordinat_wilayah"]);

    const verif = ddl.slice(ddl.lastIndexOf("COMMIT;") + "COMMIT;".length);
    const k = await b.pool.connect();
    try {
        await k.query("BEGIN");
        await k.query(`CREATE ROLE ${PERAN_UJI} NOLOGIN`);
        await k.query(`GRANT USAGE ON SCHEMA ${b.skema} TO ${PERAN_UJI}`);
        await k.query(`GRANT SELECT, INSERT, UPDATE ON sales_invoice TO ${PERAN_UJI}`);
        await k.query(`GRANT SELECT, UPDATE ON sales_profile TO ${PERAN_UJI}`);
        await k.query(`GRANT SELECT ON jks_master, ao_control_daily, kunjungan_luar_rute, noo_toko, customer, branch, accurate_employee, sales_code_merge TO ${PERAN_UJI}`);
        await k.query(`GRANT DELETE, TRUNCATE ON toko_koordinat TO ${PERAN_UJI}`); // default privileges L1g -> blok 2 mencabut
        await k.query(ddl.slice(ddl.indexOf("DO $$"), ddl.indexOf("END $$;") + "END $$;".length));
        for (const v of (await k.query(verif)).rows as Cek[]) assert.equal(v.ok, true, `hak penuh: ${v.cek}`);
        await k.query(`GRANT DELETE ON toko_koordinat TO ${PERAN_UJI}`);
        await k.query(`REVOKE UPDATE ON sales_invoice FROM ${PERAN_UJI}`);
        await k.query("ALTER TABLE sales_profile DROP CONSTRAINT sales_profile_no_hp");
        await k.query("ALTER TABLE sales_profile ADD CONSTRAINT sales_profile_no_hp CHECK (true)");
        const kurang = (await k.query(verif)).rows as Cek[];
        const nilai = (awal: string) => kurang.find((v) => v.cek.startsWith(awal))?.ok;
        assert.equal(nilai(`${PERAN_UJI} tanpa DELETE`), false, "sabotase DELETE terbaca");
        assert.equal(nilai(`prasyarat: ${PERAN_UJI} boleh SELECT/INSERT/UPDATE 4 kolom`), false, "hak sinkron hilang terbaca");
        assert.equal(nilai("CHECK sales_profile_no_hp"), false, "CHECK dilemahkan terbaca");
        assert.equal(kurang.filter((v) => v.ok === false).length, 3, "hanya yang disabotase");
    } finally {
        await k.query("ROLLBACK");
        k.release();
    }
    for (const x of [a, b, c]) await x.pool.end();
});

test("RBAC_PRESET_SUPERVISOR_REVIEW: SPV/SM/Manager/Admin supervisor_review.view; Viewer tidak; idempoten (jalan kedua 0/0); audit per grup", { skip: pgSkip }, async () => {
    const sql = await berkas("../../docs/handover/RBAC_PRESET_SUPERVISOR_REVIEW.sql");
    const k = await pool.connect();
    try {
        await k.query("BEGIN");
        await k.query(`DELETE FROM group_permission WHERE permission_key = 'supervisor_review.view'`);
        const hasil = (r: unknown) => { const x = (Array.isArray(r) ? r : [r]) as { rows: Record<string, string>[] }[]; return x.find((y) => y.rows?.[0]?.izin_disisipkan !== undefined)!.rows[0]; };
        const satu = hasil(await k.query(sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "")));
        assert.deepEqual([Number(satu.izin_disisipkan), Number(satu.audit)], [4, 4]);
        const dua = hasil(await k.query(sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "")));
        assert.deepEqual([Number(dua.izin_disisipkan), Number(dua.audit)], [0, 0]);
        const grup = (await k.query(`SELECT g.name FROM group_permission p JOIN access_group g ON g.id = p.group_id
            WHERE p.permission_key = 'supervisor_review.view' ORDER BY g.name`)).rows.map((r) => r.name);
        assert.deepEqual(grup, ["Admin", "Manager", "SM", "SPV"]);
    } finally {
        await k.query("ROLLBACK");
        k.release();
    }
});
