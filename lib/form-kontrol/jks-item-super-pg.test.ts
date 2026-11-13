/* JKS Web-LL + Item Super (owner 13 Nov 2026) di Postgres EVALUASI (AM040_DATABASE_URL, bukan produksi): SKEMA SEKALI-PAKAI (tabel disalin
 * `LIKE public.*` + db/migrations/0033, 0034, 0036, 0041; search_path hanya skema itu; DROP di akhir). Membuktikan SQL yang tidak terjangkau uji
 * murni: saringan rute F8 ("Senin, Kamis" = ANY(string_to_array)) + minggu siklus m1..m4, upsert penawaran item super di transaksi merchandising
 * (ON CONFLICT idx_tis_unik + CHECK), nilai awal sumber_order SEKALI (jalan ulang 0041 tidak menimpa pilihan Admin), dan migrate-pg OK->SKIP.
 * Tanpa env dilewati. Data contoh generik (SALES A, PRINCIPLE A). */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";
const TABEL = ["user", "sales_profile", "jks_master", "ao_control_daily", "merchandising_check", "kontrol_audit_log", "customer", "branch",
    "accurate_employee", "item"];
const skema = `uji_jksis_${randomUUID().slice(0, 8)}`;
let admin: Pool;
let pool: Pool;
const urlSkema = () => { const u = new URL(PG_URL); u.searchParams.set("options", `-c search_path=${skema}`); return u.toString(); };
const berkas = (p: string) => readFile(new URL(p, import.meta.url), "utf8");
let fk: typeof import("./db.ts");

before(async () => {
    if (!PG_URL) return;
    admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${skema}`);
    for (const t of TABEL) await admin.query(`CREATE TABLE ${skema}."${t}" (LIKE public."${t}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    pool = new Pool({ connectionString: urlSkema(), max: 2 });
    for (const f of ["0033_order_cabang", "0034_kunjungan_luar_rute", "0036_supervisor_review"]) await pool.query(await berkas(`../../db/migrations/${f}.sql`));
    // Profil SEBELUM 0041: nilai awal sumber_order hanya diisi saat kolom dibuat.
    await pool.query(`INSERT INTO sales_profile (id, user_id, sales_code, sales_name, principle, branch, created_at, updated_at) VALUES
        ('p1', 'u1', 'S-A', 'SALES A', 'KINO NON FOOD', 'CABANG A', now(), now()), ('p2', 'u2', 'S-B', 'SALES B', 'PRINCIPLE A', 'CABANG A', now(), now())`);
    await pool.query(await berkas("../../db/migrations/0041_jks_item_super.sql"));
    process.env.DATABASE_URL = urlSkema();
    fk = await import("./db.ts");
});

after(async () => {
    if (!PG_URL) return;
    await (await import("../db.ts")).pool.end().catch(() => undefined);
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${skema} CASCADE`);
    await admin.end();
});

test("PG 0041: sumber_order awal KINO = principal, lainnya accapi; jalan ulang tidak menimpa; migrate-pg SKIP sesudahnya", { skip: pgSkip }, async () => {
    const sumber = async () => Object.fromEntries((await pool.query(`SELECT sales_code, sumber_order FROM sales_profile ORDER BY 1`)).rows.map((r) => [r.sales_code, r.sumber_order]));
    assert.deepEqual(await sumber(), { "S-A": "principal", "S-B": "accapi" });
    await pool.query(`UPDATE sales_profile SET sumber_order = 'accapi' WHERE sales_code = 'S-A'`);
    await pool.query(await berkas("../../db/migrations/0041_jks_item_super.sql"));
    assert.deepEqual(await sumber(), { "S-A": "accapi", "S-B": "accapi" });
    await assert.rejects(pool.query(`UPDATE sales_profile SET sumber_order = 'lain' WHERE sales_code = 'S-B'`), /sales_profile_sumber_order/);
    const { migrations } = await import("../../scripts/migrate-pg.mjs") as { migrations: { nama: string; sudahAda: string }[] };
    const m = migrations.find((x) => x.nama === "jks web-ll + item super");
    assert.ok(m, "entri migrate-pg ada");
    assert.equal((await pool.query(m!.sudahAda)).rowCount, 1, "sesudah 0041 entri migrate-pg = SKIP");
});

test("PG rute: F8 'Senin, Kamis' muncul Senin & Kamis; m3 hanya minggu m3 (16 Nov 2026), m1 tidak", { skip: pgSkip }, async () => {
    const r = await fk.upsertJksRows([
        { salesCode: "S-B", salesName: "SALES B", custCode: "C-1", custName: "TOKO 1", hariKunjungan: "Senin, Kamis", mingguPattern: "all", principle: "PRINCIPLE A", channel: "GT", urutan: 2 },
        { salesCode: "S-B", salesName: "SALES B", custCode: "C-2", custName: "TOKO 2", hariKunjungan: "senin", mingguPattern: "m3", principle: "PRINCIPLE A", channel: "GT", kategori: "OUTLET POTENSI" },
        { salesCode: "S-B", salesName: "SALES B", custCode: "C-3", custName: "TOKO 3", hariKunjungan: "Senin", mingguPattern: "m1", principle: "PRINCIPLE A", channel: "GT" },
    ]);
    assert.equal(r.imported, 3);
    const kode = async (tgl: string) => (await fk.getTodayRoute("S-B", "PRINCIPLE A", tgl)).map((x) => x.custCode).sort();
    assert.deepEqual(await kode("2026-11-16"), ["C-1", "C-2"]); // Senin m3
    assert.deepEqual(await kode("2026-11-19"), ["C-1"]);        // Kamis
    assert.deepEqual(await kode("2026-11-30"), ["C-1", "C-3"]); // Senin m1
    const [c1] = (await pool.query(`SELECT hari_kunjungan, visit_frequency, urutan FROM jks_master WHERE cust_code = 'C-1'`)).rows;
    assert.deepEqual(c1, { hari_kunjungan: "Senin, Kamis", visit_frequency: 8, urutan: 2 });
});

test("PG merchandising + penawaran item super: satu transaksi, ON CONFLICT memperbarui, CHECK menolak isian tak sah", { skip: pgSkip }, async () => {
    const kunci = { salesCode: "S-B", custCode: "C-2", principle: "PRINCIPLE A", date: "2026-11-16" };
    const merch = { produkJelas: true, displayRapi: true, dibersihkan: true, ditataulang: true, posisiMudah: true, semuaSku: true, dibuatOleh: "u2" };
    const t1 = await fk.saveMerchandising({ ...kunci, ...merch, tawaran: [
        { kodeBarang: "A1", namaBarang: "BARANG A", ditawarkan: false, dipesan: null, alasan: "TIDAK_SEMPAT", catatan: null },
        { kodeBarang: "B1", namaBarang: "BARANG B", ditawarkan: true, dipesan: false, alasan: "HARGA", catatan: null }] });
    assert.ok("id" in t1);
    await fk.saveMerchandising({ ...kunci, ...merch, tawaran: [{ kodeBarang: "B1", namaBarang: "BARANG B", ditawarkan: true, dipesan: true, alasan: null, catatan: null }] });
    const rows = (await pool.query(`SELECT kode_barang, ditawarkan, dipesan, alasan FROM tawaran_item_super ORDER BY 1`)).rows;
    assert.deepEqual(rows, [{ kode_barang: "A1", ditawarkan: false, dipesan: null, alasan: "TIDAK_SEMPAT" },
        { kode_barang: "B1", ditawarkan: true, dipesan: true, alasan: null }]);
    await assert.rejects(pool.query(`INSERT INTO tawaran_item_super (id, sales_code, cust_code, principle, tanggal, kode_barang, nama_barang, ditawarkan,
        dipesan, alasan, dibuat_oleh) VALUES ('x', 'S-B', 'C-2', 'PRINCIPLE A', '2026-11-16', 'Z', 'Z', true, false, NULL, 'u2')`), /tawaran_item_super_alasan/);
    // Bukan rute tanggal itu (C-3 = m1) -> ditolak, penawaran tidak tertulis.
    const tolak = await fk.saveMerchandising({ ...kunci, custCode: "C-3", ...merch, tawaran: [{ kodeBarang: "C1", namaBarang: "C", ditawarkan: false, dipesan: null, alasan: "STOK_ADA", catatan: null }] });
    assert.ok("galat" in tolak);
    assert.equal((await pool.query(`SELECT 1 FROM tawaran_item_super WHERE cust_code = 'C-3'`)).rowCount, 0);
});
