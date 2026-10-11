/* K1a (BL-59) skema Kasir ↔ Incaso di Postgres EVALUASI (AM040_DATABASE_URL, bukan produksi). Tiap uji memakai SKEMA SEKALI-PAKAI
 * (search_path HANYA skema itu, DROP di akhir) — public dan DB bersama tidak disentuh. Diuji: entri migrate-pg dari kosong dua kali
 * (OK lalu SKIP), keadaan sebagian, DDL_K1A.sql dua kali lalu migrate-pg melewati, bentuk katalog migrate-pg = DDL = db/migrations =
 * Drizzle, constraint (nominal >= 0, revisi berantai, unik revisi, catatan, event, cache), trigger append-only, hak accapi_app (role
 * sementara di transaksi yang di-ROLLBACK — tak pernah terlihat sesi lain). Tanpa env dilewati dengan sebabnya. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { kasirHariEvent, kasirPelunasan, kasirPelunasanFaktur, kasirSelisihCatatan, kasirSetoran } from "../../db/schema.ts";
import { keSen, senKeTeks } from "./rekonsiliasi.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";

type Migration = { nama: string; sudahAda: string; sql: string };
const NAMA_ENTRI = "kasir (setoran, catatan, hari, cache pelunasan)";
const TABEL = ["kasir_setoran", "kasir_selisih_catatan", "kasir_hari_event", "kasir_pelunasan", "kasir_pelunasan_faktur"];
const JEJAK = ["kasir_setoran", "kasir_selisih_catatan", "kasir_hari_event"];

async function entri(): Promise<Migration> {
    const mod = await import(new URL("../../scripts/migrate-pg.mjs", import.meta.url).href) as { migrations: Migration[] };
    const m = mod.migrations.find((x) => x.nama === NAMA_ENTRI);
    assert.ok(m, `entri migrate-pg ${NAMA_ENTRI}`);
    return m;
}
const berkas = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");
const ddlK1a = () => berkas("../../docs/handover/DDL_K1A.sql");

async function denganSkema(fn: (pool: Pool, skema: string) => Promise<void>) {
    const skema = `uji_k1a_${randomUUID().slice(0, 8)}`;
    const admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${skema}`);
    const url = new URL(PG_URL);
    url.searchParams.set("options", `-c search_path=${skema}`);
    const pool = new Pool({ connectionString: url.toString(), max: 3 });
    try {
        await fn(pool, skema);
    } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${skema} CASCADE`);
        await admin.end();
    }
}

/** Tiru loop scripts/migrate-pg.mjs main(): sudahAda ada baris -> SKIP, selain itu jalankan sql. */
async function migrasi(pool: Pool, m: Migration) {
    if ((await pool.query(m.sudahAda)).rowCount) return `SKIP ${m.nama}`;
    await pool.query(m.sql);
    return `OK ${m.nama}`;
}

type Hasil = { rows: { cek: string; ok: boolean | null }[] };
const verifikasi = async (c: Pool | PoolClient, sql: string) => {
    const hasil = await c.query(sql) as unknown as Hasil[];
    return hasil[hasil.length - 1].rows;
};

async function katalog(pool: Pool) {
    const kolom = await pool.query(`SELECT table_name, column_name, data_type, numeric_precision, numeric_scale, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1) ORDER BY 1, 2`, [TABEL]);
    const constraint = await pool.query(`SELECT c.conrelid::regclass::text AS tabel, c.conname, c.contype, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c WHERE c.connamespace = current_schema()::regnamespace AND c.conrelid::regclass::text = ANY($1)
        ORDER BY 1, 2`, [TABEL]);
    const indeks = await pool.query(`SELECT t.relname AS tablename, c.relname AS indexname,
            replace(pg_get_indexdef(c.oid), current_schema() || '.', '') AS def, x.indisunique AS unik
        FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
        WHERE t.relnamespace = current_schema()::regnamespace AND t.relname = ANY($1) ORDER BY 1, 2`, [TABEL]);
    return { kolom: kolom.rows, constraint: constraint.rows, indeks: indeks.rows };
}

// Banding Drizzle ↔ katalog: tipe (numeric berpresisi; bigserial = bigint + default nextval), NOT NULL, default sederhana.
const dialek = new PgDialect();
const teksSql = (v: unknown) => v === undefined || v === null ? "" : is(v, SQL) ? dialek.sqlToQuery(v).sql : String(v);
const normDefault = (s: string | null | undefined) => (s ?? "").startsWith("nextval(") ? "serial" : (s ?? "").replace(/[()\s'"]/g, "");
const tipeDb = (r: { data_type: string; numeric_precision: number | null; numeric_scale: number | null }) =>
    r.data_type === "numeric" ? `numeric(${r.numeric_precision}, ${r.numeric_scale})` : r.data_type;

const kodeGalat = (kode: string) => (e: unknown) => (e as { code?: string }).code === kode;

test("PG K1a: migrate-pg dari kosong dua kali — OK lalu SKIP; SQL mentah aman diulang", { skip: pgSkip }, async () => {
    const m = await entri();
    await denganSkema(async (pool) => {
        assert.equal(await migrasi(pool, m), `OK ${NAMA_ENTRI}`);
        assert.equal(await migrasi(pool, m), `SKIP ${NAMA_ENTRI}`);
        const sebelum = await katalog(pool);
        await pool.query(m.sql);
        assert.deepEqual(await katalog(pool), sebelum, "SQL entri diulang tanpa perubahan");
        assert.equal(sebelum.indeks.length, 9, "9 indeks (PK + unik revisi + indeks baca)");
    });
});

test("PG K1a: keadaan sebagian — sudahAda tidak tertipu, entri melengkapi", { skip: pgSkip }, async () => {
    const m = await entri();
    const ada = async (pool: Pool) => (await pool.query(m.sudahAda)).rowCount;
    await denganSkema(async (pool) => {
        await pool.query(m.sql);
        await pool.query("DROP TABLE kasir_pelunasan_faktur");
        assert.equal(await ada(pool), 0, "tanpa kasir_pelunasan_faktur = belum ada");
        await pool.query(m.sql);
        assert.equal(await ada(pool), 1, "tabel dilengkapi");
        await pool.query("DROP INDEX idx_kasir_hari_event_tanggal");
        assert.equal(await ada(pool), 0, "tanpa indeks baca event = belum ada");
        await pool.query(m.sql);
        assert.equal(await ada(pool), 1, "indeks dilengkapi");
    });
});

test("PG K1a: DDL_K1A.sql dua kali idempoten + VERIFIKASI; sesudahnya migrate-pg melewati; bentuk = migrate-pg = db/migrations = Drizzle", { skip: pgSkip }, async () => {
    const m = await entri();
    const ddl = await ddlK1a();
    let bentuk: Awaited<ReturnType<typeof katalog>> | undefined;
    await denganSkema(async (pool) => {
        await migrasi(pool, m);
        bentuk = await katalog(pool);
    });
    await denganSkema(async (pool) => {
        for (let i = 0; i < 2; i++) {
            for (const v of await verifikasi(pool, ddl)) assert.notEqual(v.ok, false, `VERIFIKASI gagal: ${v.cek}`);
        }
        assert.equal(await migrasi(pool, m), `SKIP ${NAMA_ENTRI}`, "migrate-pg melewati sesudah DDL manual");
        assert.deepEqual(await katalog(pool), bentuk, "DDL manual = entri migrate-pg");
    });
    await denganSkema(async (pool) => {
        await pool.query(await berkas("../../db/migrations/0029_kasir.sql"));
        assert.deepEqual(await katalog(pool), bentuk, "db/migrations = entri migrate-pg");
    });
    const k = bentuk!;
    const tabelDrizzle: [string, PgTable][] = [["kasir_setoran", kasirSetoran], ["kasir_selisih_catatan", kasirSelisihCatatan],
        ["kasir_hari_event", kasirHariEvent], ["kasir_pelunasan", kasirPelunasan], ["kasir_pelunasan_faktur", kasirPelunasanFaktur]];
    for (const [nama, t] of tabelDrizzle) {
        const cfg = getTableConfig(t);
        assert.deepEqual(
            cfg.columns.map((c) => {
                const serial = c.getSQLType() === "bigserial";
                return [c.name, serial ? "bigint" : c.getSQLType(), c.notNull ? "NO" : "YES", serial ? "serial" : c.hasDefault ? normDefault(teksSql(c.default)) : ""].join("|");
            }).sort(),
            k.kolom.filter((r) => r.table_name === nama).map((r) => [r.column_name, tipeDb(r), r.is_nullable, normDefault(r.column_default)].join("|")).sort(),
            `kolom Drizzle ${nama} (nama|tipe|nullable|default)`);
        const indeksDb = new Map(k.indeks.filter((r) => r.tablename === nama).map((r) => [r.indexname, String(r.unik)]));
        for (const i of cfg.indexes) assert.equal(indeksDb.get(i.config.name), String(Boolean(i.config.unique)), `${nama}: indeks ${i.config.name}`);
        // CHECK / FK / UNIQUE: himpunan nama SAMA (constraint DB tanpa padanan Drizzle juga merah).
        assert.deepEqual(
            [...cfg.checks.map((c) => c.name), ...cfg.foreignKeys.map((f) => f.getName()), ...cfg.uniqueConstraints.map((u) => u.getName())].sort(),
            k.constraint.filter((r) => r.tabel === nama && ["c", "f", "u"].includes(r.contype)).map((r) => r.conname).sort(),
            `${nama}: nama CHECK/FK/UNIQUE Drizzle = DB`);
        for (const p of cfg.primaryKeys) assert.ok(k.constraint.some((r) => r.tabel === nama && r.conname === p.getName() && r.contype === "p"), `${nama}: PK ${p.getName()}`);
    }
});

test("PG K1a: constraint — nominal >= 0, revisi BERANTAI (menunjuk revisi sebelumnya, hari & kode sama), unik revisi, catatan, event, cache", { skip: pgSkip }, async () => {
    const m = await entri();
    await denganSkema(async (pool) => {
        await pool.query(m.sql);
        const q = (sql: string, p: unknown[] = []) => pool.query(sql, p);
        const setor = (kode: string, revisi: number, sebelum: number | null, nominal: [string, string, string] = ["100.00", "0", "0"],
            tanggal = "2026-10-05", lain: { form?: string | null; oleh?: string } = {}) =>
            q(`INSERT INTO kasir_setoran (tanggal, salesman_kode, revisi, revisi_sebelumnya, tunai, transfer, giro, no_form_kasir, dicatat_oleh)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [tanggal, kode, revisi, sebelum, ...nominal, lain.form ?? null, lain.oleh ?? "kasir-1"]);

        await setor("S-A", 1, null);
        await assert.rejects(setor("S-A", 1, null), kodeGalat("23505"), "revisi sama dua kali (dobel-klik) ditolak");
        await setor("S-A", 2, 1, ["0", "250000.50", "0"]);
        await assert.rejects(setor("S-A", 3, 1), kodeGalat("23514"), "revisi 3 harus menunjuk revisi 2");
        await assert.rejects(setor("S-A", 3, null), kodeGalat("23514"), "revisi > 1 tanpa penunjuk ditolak (bukan lolos NULL)");
        await assert.rejects(setor("S-A", 1, 0), kodeGalat("23514"), "revisi 1 tidak menunjuk apa pun");
        await assert.rejects(setor("S-A", 0, null), kodeGalat("23514"), "revisi mulai 1");
        await assert.rejects(setor("S-B", 2, 1), kodeGalat("23503"), "revisi 2 tanpa revisi 1 kode itu");
        await assert.rejects(setor("S-A", 2, 1, ["1", "0", "0"], "2026-10-06"), kodeGalat("23503"), "penunjuk tidak menyeberang hari");
        await setor("S-A", 3, 2, ["10", "20", "30"], "2026-10-05", { form: "#0415" });
        const terakhir = await q(`SELECT DISTINCT ON (salesman_kode) revisi, tunai, transfer, giro FROM kasir_setoran
            WHERE tanggal = '2026-10-05' ORDER BY salesman_kode, revisi DESC`);
        assert.deepEqual(terakhir.rows, [{ revisi: 3, tunai: "10.00", transfer: "20.00", giro: "30.00" }]);

        for (const nominal of [["-1", "0", "0"], ["0", "-0.01", "0"], ["0", "0", "-100"]] as [string, string, string][]) {
            await assert.rejects(setor("S-C", 1, null, nominal), kodeGalat("23514"), `nominal ${nominal.join("/")} ditolak`);
        }
        await assert.rejects(q(`INSERT INTO kasir_setoran (tanggal, salesman_kode, revisi, tunai, transfer, giro, dicatat_oleh)
            VALUES ('2026-10-05', 'S-C', 1, 0, 0, NULL, 'x')`), kodeGalat("23502"), "giro wajib diisi (tanpa default 0 diam-diam)");
        for (const kode of ["", " S-C", "S-C "]) await assert.rejects(setor(kode, 1, null), kodeGalat("23514"), `kode ${JSON.stringify(kode)}`);
        await assert.rejects(setor("S-C", 1, null, undefined, undefined, { form: "  " }), kodeGalat("23514"), "nomor Form Kasir kosong");
        await assert.rejects(setor("S-C", 1, null, undefined, undefined, { oleh: " " }), kodeGalat("23514"), "pencatat kosong");
        // numeric(18,2) MEMBULATKAN diam-diam -> penulis wajib lewat keSen (yang MENOLAK > 2 desimal) + senKeTeks.
        await setor("S-D", 1, null, ["0.005", "0", "0"]);
        assert.equal((await q(`SELECT tunai FROM kasir_setoran WHERE salesman_kode = 'S-D'`)).rows[0].tunai, "0.01");
        assert.throws(() => keSen("0.005"), RangeError);
        await setor("S-E", 1, null, [senKeTeks(keSen(41592193)), "0", "0"]);
        assert.equal(keSen((await q(`SELECT tunai FROM kasir_setoran WHERE salesman_kode = 'S-E'`)).rows[0].tunai), 4159219300, "pulang-pergi sen tepat");

        const jelaskan = (kode: string, penjelasan: string, tindak = "setor_susulan", setoran = "8750000") =>
            q(`INSERT INTO kasir_selisih_catatan (tanggal, salesman_kode, pelunasan, setoran, penjelasan, tindak_lanjut, dicatat_oleh)
               VALUES ('2026-10-05', $1, 9150000, $2, $3, $4, 'kasir-1')`, [kode, setoran, penjelasan, tindak]);
        await jelaskan("S-A", "Setor susulan 6 Okt");
        await jelaskan("", "Faktur tanpa salesman dicek Incaso", "koreksi_incaso"); // '' = Tanpa salesman
        await assert.rejects(jelaskan("S-A", "  pendek sekali  "), kodeGalat("23514"), "penjelasan < 15 huruf");
        await assert.rejects(jelaskan("S-A", "Setor susulan 6 Okt", "lain"), kodeGalat("23514"), "tindak lanjut di luar daftar");
        await assert.rejects(jelaskan("S-A", "Setor susulan 6 Okt", "lapor_om", "-1"), kodeGalat("23514"), "setoran negatif");

        const event = (jenis: string, alasan: string | null, snapshot: string | null) =>
            q(`INSERT INTO kasir_hari_event (tanggal, jenis, alasan, snapshot, oleh) VALUES ('2026-10-05', $1, $2, $3::jsonb, 'kasir-1')`, [jenis, alasan, snapshot]);
        await event("tutup", null, `{"versi":1}`);
        await event("kunci", null, `{"versi":1}`);
        await event("buka", "Setoran MKS-03 salah dicatat", null);
        await assert.rejects(event("buka", null, null), kodeGalat("23514"), "buka tanpa alasan (NULL tidak lolos)");
        await assert.rejects(event("buka", "kurang panjang", null), kodeGalat("23514"), "alasan buka < 15 huruf");
        await assert.rejects(event("buka", "Alasan yang cukup panjang", `{"versi":1}`), kodeGalat("23514"), "buka tanpa snapshot");
        await assert.rejects(event("tutup", null, null), kodeGalat("23514"), "tutup wajib snapshot");
        await assert.rejects(event("kunci", null, "[]"), kodeGalat("23514"), "snapshot harus objek");
        await assert.rejects(event("hapus", null, `{}`), kodeGalat("23514"), "jenis di luar daftar");

        const header = (id: number, nomor = `SR/${id}`) => q(`INSERT INTO kasir_pelunasan (database_id, pelunasan_id, nomor, tanggal, metode, cheque_amount, last_update)
            VALUES ('DB-1', $1, $2, '2026-10-05', 'CASH_OTHER', 108741.15, '05/10/2026 09:14:00')`, [id, nomor]);
        const baris = (pid: number, fid: number, salesman: number | null) => q(`INSERT INTO kasir_pelunasan_faktur
            (database_id, pelunasan_id, faktur_id, nomor_faktur, master_salesman_id, invoice_payment) VALUES ('DB-1', $1, $2, 'INV/1', $3, 54370.575)`, [pid, fid, salesman]);
        await header(1);
        await baris(1, 10, 4652);
        await baris(1, 11, null);
        await assert.rejects(header(1), kodeGalat("23505"), "pelunasan unik per database");
        await assert.rejects(baris(1, 10, 1), kodeGalat("23505"), "baris faktur unik per pelunasan");
        await assert.rejects(baris(2, 10, 1), kodeGalat("23503"), "baris tanpa kepala pelunasan");
        await assert.rejects(header(3, " "), kodeGalat("23514"), "nomor kosong");
        await q(`UPDATE kasir_pelunasan SET cheque_amount = 1, last_update = 'x' WHERE pelunasan_id = 1`);
        await q(`DELETE FROM kasir_pelunasan WHERE pelunasan_id = 1`);
        assert.equal((await q(`SELECT count(*)::int AS n FROM kasir_pelunasan_faktur`)).rows[0].n, 0, "hapus kepala = baris ikut terhapus (cache)");
    });
});

test("PG K1a: DDL — trigger append-only menolak UPDATE/DELETE/TRUNCATE pada setoran, catatan, event; cache tetap bisa diubah", { skip: pgSkip }, async () => {
    const ddl = await ddlK1a();
    await denganSkema(async (pool) => {
        await verifikasi(pool, ddl);
        await pool.query(`INSERT INTO kasir_setoran (tanggal, salesman_kode, revisi, tunai, transfer, giro, dicatat_oleh) VALUES ('2026-10-05', 'S-A', 1, 1, 0, 0, 'k')`);
        await pool.query(`INSERT INTO kasir_selisih_catatan (tanggal, salesman_kode, pelunasan, setoran, penjelasan, tindak_lanjut, dicatat_oleh)
            VALUES ('2026-10-05', 'S-A', 2, 1, 'Setor susulan 6 Okt pagi', 'setor_susulan', 'k')`);
        await pool.query(`INSERT INTO kasir_hari_event (tanggal, jenis, snapshot, oleh) VALUES ('2026-10-05', 'tutup', '{}', 'k')`);
        const ditolak = (e: unknown) => kodeGalat("23001")(e) && /append-only/.test(String((e as Error).message));
        for (const t of JEJAK) {
            await assert.rejects(pool.query(`UPDATE ${t} SET tanggal = tanggal`), ditolak, `${t}: UPDATE`);
            await assert.rejects(pool.query(`DELETE FROM ${t}`), ditolak, `${t}: DELETE`);
            await assert.rejects(pool.query(`TRUNCATE ${t} CASCADE`), ditolak, `${t}: TRUNCATE`);
            assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, 1, `${t}: baris utuh`);
        }
        // Koreksi = baris baru (INSERT tetap boleh).
        await pool.query(`INSERT INTO kasir_setoran (tanggal, salesman_kode, revisi, revisi_sebelumnya, tunai, transfer, giro, dicatat_oleh)
            VALUES ('2026-10-05', 'S-A', 2, 1, 2, 0, 0, 'k')`);
        await pool.query(`INSERT INTO kasir_pelunasan (database_id, pelunasan_id, nomor, tanggal, metode, cheque_amount) VALUES ('DB-1', 1, 'SR/1', '2026-10-05', 'CASH_OTHER', 1)`);
        await pool.query(`UPDATE kasir_pelunasan SET cheque_amount = 2`);
        await pool.query(`DELETE FROM kasir_pelunasan`);
    });
});

test("PG K1a: DDL — hak accapi_app (role sementara, transaksi di-ROLLBACK): jejak hanya SELECT/INSERT, cache DML, sequence USAGE", { skip: pgSkip }, async () => {
    const ddl = await ddlK1a();
    // Tanpa BEGIN/COMMIT berkas: semuanya ikut transaksi uji agar CREATE ROLE / GRANT tidak pernah ter-commit.
    const tanpaTransaksi = ddl.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
    assert.ok(!/^(BEGIN|COMMIT);$/m.test(tanpaTransaksi), "berkas DDL punya tepat satu BEGIN/COMMIT");
    await denganSkema(async (pool, skema) => {
        const c = await pool.connect();
        try {
            await c.query("BEGIN");
            if (!(await c.query("SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app'")).rowCount) await c.query("CREATE ROLE accapi_app NOLOGIN");
            // Default privileges L1g bisa memberi DML penuh: tiru dengan GRANT ALL sebelum DDL -> REVOKE di berkas wajib mencabutnya.
            await c.query(`GRANT USAGE ON SCHEMA ${skema} TO accapi_app`);
            await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${skema} GRANT ALL ON TABLES TO accapi_app`);
            const v = new Map((await verifikasi(c, tanpaTransaksi)).map((r) => [r.cek, r.ok]));
            for (const [cek, ok] of v) assert.equal(ok, true, `VERIFIKASI ${cek}`);
            await c.query("SET LOCAL ROLE accapi_app");
            await c.query(`INSERT INTO kasir_setoran (tanggal, salesman_kode, revisi, tunai, transfer, giro, dicatat_oleh) VALUES ('2026-10-05', 'S-A', 1, 1, 0, 0, 'k')`);
            await c.query(`INSERT INTO kasir_hari_event (tanggal, jenis, snapshot, oleh) VALUES ('2026-10-05', 'tutup', '{}', 'k')`);
            await c.query(`INSERT INTO kasir_pelunasan (database_id, pelunasan_id, nomor, tanggal, metode, cheque_amount) VALUES ('DB-1', 1, 'SR/1', '2026-10-05', 'CASH_OTHER', 1)`);
            await c.query(`UPDATE kasir_pelunasan SET cheque_amount = 2`);
            for (const sql of [`UPDATE kasir_setoran SET tunai = 9`, `DELETE FROM kasir_hari_event`, `TRUNCATE kasir_selisih_catatan`]) {
                await c.query("SAVEPOINT s");
                await assert.rejects(c.query(sql), kodeGalat("42501"), `accapi_app: ${sql} ditolak hak (sebelum trigger)`);
                await c.query("ROLLBACK TO SAVEPOINT s");
            }
        } finally {
            await c.query("ROLLBACK");
            c.release();
        }
        assert.equal((await pool.query("SELECT to_regclass('kasir_setoran') AS r")).rows[0].r, null, "transaksi uji benar-benar di-ROLLBACK");
    });
});
