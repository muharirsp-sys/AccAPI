/* O3 riwayat beli toko di Postgres EVALUASI (AM040_DATABASE_URL, bukan produksi): SKEMA SEKALI-PAKAI (search_path HANYA skema itu, DROP di
 * akhir) — tidak ada yang diubah permanen. Route ASLI GET /api/customers/riwayat-beli + SQL ASLI atas `sales_invoice` berbentuk produksi:
 * `trans_date` TEKS dd/MM/yyyy (bentuk lain dilewati tanpa galat), `raw_data` jsonb berisi STRING JSON (dan objek), faktur list.do tanpa
 * `detailItem` / raw_data NULL = "tanpa rincian", bonus harga 0, batas jendela 90 hari (hari ke-90 masuk, ke-91 tidak), tanggal data paling
 * awal di luar jendela, toko baru (dibagi bulan sejak faktur pertama), pelanggan lain tidak tercampur, cakupan cabang salesman, master barang
 * (cabang lain = tak bisa diorder). Putaran 1: faktur rusak (tanggal mustahil 31/02, raw_data bukan JSON) dilewati + dihitung `dilewati`
 * (bukan 500); rencana kueri memakai CTE `w` TERMATERIALISASI (raw_data diurai sekali per faktur). Sesi dipalsukan; izin dari tabel grup
 * nyata. Tanpa env dilewati dengan sebabnya. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { NextRequest } from "next/server";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";

const DDL = `
    CREATE TABLE user_group (user_id text NOT NULL, group_id text NOT NULL, is_primary boolean NOT NULL DEFAULT false, PRIMARY KEY (user_id, group_id));
    CREATE TABLE group_permission (group_id text NOT NULL, permission_key text NOT NULL, PRIMARY KEY (group_id, permission_key));
    CREATE TABLE sales_profile (id text PRIMARY KEY, user_id text NOT NULL, sales_code text NOT NULL UNIQUE, accurate_linked boolean NOT NULL DEFAULT false);
    CREATE TABLE accurate_employee (id bigint PRIMARY KEY, number text NOT NULL DEFAULT '', branch_id bigint, salesman boolean NOT NULL DEFAULT false,
        suspended boolean NOT NULL DEFAULT false);
    CREATE TABLE branch (id bigint PRIMARY KEY, name text NOT NULL);
    CREATE TABLE customer (id bigint PRIMARY KEY, "customerNo" text NOT NULL, name text NOT NULL, branch_id bigint, branch_name text,
        suspended boolean NOT NULL DEFAULT false);
    CREATE TABLE item (id bigint PRIMARY KEY, no text NOT NULL, name text NOT NULL, branch_id bigint, suspended boolean NOT NULL DEFAULT false, char_field2 text);
    CREATE TABLE sales_invoice (id bigint PRIMARY KEY, number text, trans_date text, customer_no text, raw_data jsonb);
    CREATE INDEX idx_sales_invoice_customer_no ON sales_invoice (customer_no);`;

const skema = `uji_o3_${randomUUID().slice(0, 8)}`;
let admin: Pool, pool: Pool;
let sesi = "u-admin";
type Route = (req: NextRequest) => Promise<Response>;
let GET: Route;
let todayWita: (d: Date) => string;

/** ISO (YYYY-MM-DD) `n` hari sebelum hari ini WITA, dan bentuk `trans_date` Accurate (dd/MM/yyyy). */
const iso = (n: number) => new Date(Date.parse(`${todayWita(new Date())}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const teksAcc = (n: number) => { const [y, m, d] = iso(n).split("-"); return `${d}/${m}/${y}`; };
const baris = (no: string, name: string, unit: string, quantity: number, unitPrice = 1000) => ({ item: { no, name }, itemUnit: { name: unit }, quantity, unitPrice });

before(async () => {
    if (!PG_URL) return;
    admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${skema}`);
    const u = new URL(PG_URL);
    u.searchParams.set("options", `-c search_path=${skema}`);
    pool = new Pool({ connectionString: u.toString(), max: 2 });
    await pool.query(DDL);
    todayWita = (await import("./insentif-payment-date.ts")).todayWita;
    await pool.query(`INSERT INTO branch VALUES (50, 'CABANG A'), (90, 'CABANG B')`);
    await pool.query(`INSERT INTO group_permission VALUES ('g-admin', 'order.view'), ('g-admin', 'order.create'), ('g-sales', 'websales.view'), ('g-sales', 'websales.create')`);
    await pool.query(`INSERT INTO user_group (user_id, group_id) VALUES ('u-admin', 'g-admin'), ('u-sa', 'g-sales')`);
    await pool.query(`INSERT INTO accurate_employee VALUES (1, 'M-SLA', 50, true, false)`);
    await pool.query(`INSERT INTO sales_profile VALUES ('sp-a', 'u-sa', 'M-SLA', true)`);
    await pool.query(`INSERT INTO customer (id, "customerNo", name, branch_id, branch_name) VALUES (1, 'C-100001-MSM', 'PELANGGAN A', 50, 'CABANG A'),
        (2, 'C-100002-MSM', 'PELANGGAN B', 50, 'CABANG A'), (3, 'C-100003-MSM', 'PELANGGAN C', 90, 'CABANG B'), (4, 'C-100004-MSM', 'PELANGGAN D', 50, 'CABANG A'),
        (6, 'C-100006-MSM', 'PELANGGAN F', 50, 'CABANG A')`);
    await pool.query(`INSERT INTO item (id, no, name, branch_id, suspended, char_field2) VALUES (11, 'A-1', 'BARANG A', 50, false, 'CABANG A'),
        (14, 'A-4', 'BARANG A4', 50, false, 'CABANG A'), (21, 'B-1', 'BARANG B', 90, false, 'CABANG B')`);
    const tulis = (id: number, tgl: string, cust: string, raw: unknown, sebagaiTeks = true) => pool.query(
        `INSERT INTO sales_invoice (id, number, trans_date, customer_no, raw_data) VALUES ($1, $2, $3, $4, ${sebagaiTeks ? "to_jsonb($5::text)" : "$5::jsonb"})`,
        [id, `INV/${id}`, tgl, cust, raw === null ? null : JSON.stringify(raw)]);
    const A = "C-100001-MSM";
    await tulis(1, teksAcc(100), A, { detailItem: [baris("A-1", "BARANG A", "KRT", 50)] }); // di luar jendela: hanya tanggal data paling awal
    await tulis(2, teksAcc(60), A, { detailItem: [baris("A-1", "BARANG A", "KRT", 3), baris("A-1", "BARANG A", "PCS", 12), baris("A-1", "BARANG A", "PCS", 2, 0)] });
    // raw_data OBJEK (bukan string) + kunci cadangan itemNo/detailName.
    await tulis(3, teksAcc(10), A, { detailItem: [{ itemNo: "A-1", detailName: "BARANG A", itemUnit: { name: "KRT" }, quantity: 3, unitPrice: 576000 }, baris("B-1", "BARANG B", "KRT", 6)] }, false);
    await tulis(4, teksAcc(5), A, { id: 4, number: "INV/4", totalAmount: 100000 }); // list.do: tanpa detailItem
    await tulis(5, iso(4), A, { detailItem: [baris("A-1", "BARANG A", "KRT", 99)] }); // trans_date bukan dd/MM/yyyy: dilewati, bukan galat
    await tulis(6, teksAcc(3), A, null); // raw_data NULL = tanpa rincian
    await tulis(7, teksAcc(0), A, { detailItem: [baris("A-4", "BARANG A4", "LSN", 1)] }); // hari ini = batas akhir jendela
    await tulis(8, teksAcc(89), A, { detailItem: [baris("A-4", "BARANG A4", "LSN", 2)] }); // hari ke-90 (termasuk hari ini) = masuk
    await tulis(9, teksAcc(90), A, { detailItem: [baris("A-4", "BARANG A4", "LSN", 70)] }); // hari ke-91 = di luar jendela
    await tulis(10, teksAcc(7), "C-100002-MSM", { detailItem: [baris("A-1", "BARANG A", "KRT", 500)] }); // pelanggan lain
    await tulis(11, teksAcc(7), "C-100003-MSM", { detailItem: [baris("B-1", "BARANG B", "KRT", 5)] });
    await tulis(12, teksAcc(20), "C-100004-MSM", { detailItem: [baris("A-1", "BARANG A", "KRT", 4)] }); // toko baru: faktur pertama 20 hari lalu
    // Butir 3 putaran 1: faktur rusak DILEWATI dan DIHITUNG, bukan 500 untuk seluruh jawaban.
    const R = "C-100006-MSM";
    await tulis(20, teksAcc(5), R, { detailItem: [baris("A-1", "BARANG A", "KRT", 6)] });
    await tulis(21, `31/02/${iso(0).slice(0, 4)}`, R, { detailItem: [baris("A-1", "BARANG A", "KRT", 99)] }); // tanggal mustahil (to_date = galat)
    await pool.query(`INSERT INTO sales_invoice VALUES (22, 'INV/22', $1, $2, to_jsonb('{"detailItem": [ rusak'::text))`, [teksAcc(8), R]); // JSON rusak di jendela
    await pool.query(`INSERT INTO sales_invoice VALUES (23, 'INV/23', $1, $2, to_jsonb('rusak juga'::text))`, [teksAcc(120), R]); // rusak di LUAR jendela: tidak dibuka

    process.env.DATABASE_URL = u.toString();
    delete process.env.LOCAL_AUTH_BYPASS;
    const { auth } = await import("./auth.ts");
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => ({ user: { id: sesi, name: sesi, role: "staff" }, session: { id: "s" } }) });
    GET = (await import("../app/api/customers/riwayat-beli/route.ts")).GET as unknown as Route;
});

after(async () => {
    if (!PG_URL) return;
    await pool?.end();
    await (await import("./db.ts")).pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${skema} CASCADE`);
    await admin.end();
});

async function minta(siapa: string, customerNo: string) {
    sesi = siapa;
    const res = await GET(new NextRequest(`http://app.test/api/customers/riwayat-beli?customerNo=${encodeURIComponent(customerNo)}`));
    return { status: res.status, body: await res.json() };
}

test("SQL asli: tanggal teks, raw_data string/objek, tanpa rincian, bonus, batas jendela, pelanggan lain tak tercampur", { skip: pgSkip }, async () => {
    const { status, body } = await minta("u-admin", "C-100001-MSM");
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.jendela, { bulan: 3, dari: iso(89), sampai: iso(0), bulanTeramati: 3 });
    // Faktur 2,3,4,6,7,8 (5 = tanggal bukan dd/MM/yyyy = dilewati, 1 & 9 = di luar jendela); 4 (list.do) & 6 (raw_data NULL) tanpa rincian.
    assert.deepEqual(body.ringkasan, { jumlahFaktur: 6, tanpaRincian: 2, dilewati: 1, dataSejak: iso(100) });
    assert.deepEqual(body.items.map((x: Record<string, unknown>) => [x.code, x.unit, x.totalQty, x.rataPerBulan, x.jumlahFaktur, x.terakhirBeli, x.bisaDiorder, x.alasan]), [
        ["A-1", "PCS", 12, 4, 1, iso(60), true, null], // bonus 2 PCS harga 0 tidak dihitung
        ["A-1", "KRT", 6, 2, 2, iso(10), true, null],
        ["B-1", "KRT", 6, 2, 1, iso(10), false, "barang cabang CABANG B"],
        ["A-4", "LSN", 3, 1, 2, iso(0), true, null],
    ]);
    assert.equal(body.items[1].name, "BARANG A");
});

test("toko baru (faktur pertama 20 hari lalu) = dibagi 1 bulan, bukan 3; toko tanpa faktur = ringkasan nol + dataSejak null (bukan galat)", { skip: pgSkip }, async () => {
    const baru = await minta("u-admin", "C-100004-MSM");
    assert.equal(baru.body.jendela.bulanTeramati, 1);
    assert.deepEqual(baru.body.items.map((x: Record<string, unknown>) => [x.code, x.rataPerBulan]), [["A-1", 4]]);
    const kosong = await minta("u-admin", "C-100002-MSM");
    assert.equal(kosong.body.ringkasan.jumlahFaktur, 1); // faktur 10 milik C-100002 sendiri
    await pool.query(`INSERT INTO customer (id, "customerNo", name, branch_id, branch_name) VALUES (5, 'C-100005-MSM', 'PELANGGAN E', 50, 'CABANG A')`);
    const nol = await minta("u-admin", "C-100005-MSM");
    assert.equal(nol.status, 200);
    assert.deepEqual(nol.body.ringkasan, { jumlahFaktur: 0, tanpaRincian: 0, dilewati: 0, dataSejak: null });
    assert.deepEqual(nol.body.items, []);
});

test("cakupan cabang di DB nyata: salesman CABANG A membaca pelanggannya (200) tetapi pelanggan CABANG B = 403 CABANG_DI_LUAR_CAKUPAN", { skip: pgSkip }, async () => {
    const milik = await minta("u-sa", "C-100001-MSM");
    assert.equal(milik.status, 200);
    assert.equal(milik.body.ringkasan.jumlahFaktur, 6);
    const lain = await minta("u-sa", "C-100003-MSM");
    assert.equal(lain.status, 403);
    assert.equal(lain.body.kode, "CABANG_DI_LUAR_CAKUPAN");
});

test("faktur rusak di jendela (tanggal mustahil 31/02, raw_data bukan JSON) DILEWATI + dihitung `dilewati` — bukan 500 untuk seluruh jawaban", { skip: pgSkip }, async () => {
    const { status, body } = await minta("u-admin", "C-100006-MSM");
    assert.equal(status, 200, JSON.stringify(body));
    // 21 (31/02) + 22 (JSON rusak, di jendela) dilewati; 23 rusak tetapi di luar jendela = tidak dibuka (tetap membawa tanggal data paling awal).
    assert.deepEqual(body.ringkasan, { jumlahFaktur: 1, tanpaRincian: 0, dilewati: 2, dataSejak: iso(120) });
    assert.deepEqual(body.items.map((x: Record<string, unknown>) => [x.code, x.unit, x.totalQty, x.rataPerBulan]), [["A-1", "KRT", 6, 2]]);
});

test("rencana kueri: CTE `w` (raw_data diurai) DIMATERIALISASI, bukan di-inline lalu diurai ulang per baris barang", { skip: pgSkip }, async () => {
    const { db } = await import("./db.ts");
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const simpan = Object.getOwnPropertyDescriptor(db, "execute");
    const asli = db.execute.bind(db);
    let kueri: { sql: string; params: unknown[] } | null = null;
    Object.defineProperty(db, "execute", { configurable: true, value: (q: Parameters<typeof db.execute>[0]) => {
        const t = new PgDialect().sqlToQuery(q as never);
        if (t.sql.includes("sales_invoice")) kueri = t;
        return asli(q);
    } });
    try {
        assert.equal((await minta("u-admin", "C-100001-MSM")).status, 200);
    } finally {
        if (simpan) Object.defineProperty(db, "execute", simpan); else delete (db as unknown as Record<string, unknown>).execute;
    }
    assert.ok(kueri, "kueri faktur tidak tertangkap");
    const { sql: teks, params } = kueri as { sql: string; params: unknown[] };
    const plan = (await pool.query(`EXPLAIN (COSTS OFF) ${teks}`, params)).rows.map((r) => r["QUERY PLAN"]).join("\n");
    assert.match(plan, /CTE w\n/, plan); // node CTE w ada = dimaterialisasi (raw_data diurai sekali per faktur)
    assert.match(plan, /CTE Scan on w\b/, plan);
});
