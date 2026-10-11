/* S7-0 (BL-64 principal resmi + varian + alias, BL-63 grup utama) di Postgres EVALUASI (AM040_DATABASE_URL, bukan produksi).
 * Tiap uji memakai SKEMA SEKALI-PAKAI (search_path HANYA skema itu, DROP di akhir) berisi tabel dasar user/access_group/user_group
 * bentuk SEBELUM S7-0 — public dan DB bersama tidak disentuh. Diuji: entri migrate-pg dari kosong dua kali (OK lalu SKIP),
 * keadaan sebagian, DDL_S7_0.sql dua kali lalu migrate-pg melewati, bentuk katalog migrate-pg = DDL = db/migrations = Drizzle,
 * constraint (dua bintang, alias_norm unik, FK, CHECK), BACKFILL hanya user tepat 1 grup + idempoten, GRANT accapi_app
 * (role sementara di dalam transaksi yang di-ROLLBACK — tak pernah terlihat sesi lain). Tanpa env dilewati dengan sebabnya. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { principal, principalAlias, principalVariant, userGroup } from "../db/schema.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";

type Migration = { nama: string; sudahAda: string; sql: string };
const NAMA_ENTRI = ["principal (+variant, +alias)", "user_group.is_primary"];
const TABEL = ["principal", "principal_variant", "principal_alias", "user_group"];
const BATAS_BACKFILL = "-- ===== BACKFILL";

async function entri(): Promise<Migration[]> {
    const mod = await import(new URL("../scripts/migrate-pg.mjs", import.meta.url).href) as { migrations: Migration[] };
    return NAMA_ENTRI.map((nama) => {
        const m = mod.migrations.find((x) => x.nama === nama);
        assert.ok(m, `entri migrate-pg ${nama}`);
        return m;
    });
}

/** DDL_S7_0.sql dipecah: bagian DDL (+GRANT +VERIFIKASI) dan bagian BACKFILL. */
async function berkasDdl() {
    const teks = await readFile(new URL("../docs/handover/DDL_S7_0.sql", import.meta.url), "utf8");
    const i = teks.indexOf(BATAS_BACKFILL);
    assert.ok(i > 0, "penanda bagian BACKFILL ada");
    return { ddl: teks.slice(0, i), backfill: teks.slice(i) };
}

// Cermin db/schema.ts SEBELUM S7-0: user/access_group (kolom relevan saja), user_group utuh dengan nama constraint/indeks
// hasil drizzle-kit push (= produksi), agar perbandingan Drizzle di bawah memeriksa nama yang sebenarnya.
const DASAR = `
    CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE);
    CREATE TABLE access_group (id text PRIMARY KEY, name text NOT NULL UNIQUE, is_preset boolean NOT NULL DEFAULT false);
    CREATE TABLE user_group (
        user_id     text NOT NULL,
        group_id    text NOT NULL,
        assigned_by text,
        assigned_at timestamp NOT NULL,
        CONSTRAINT user_group_user_id_group_id_pk PRIMARY KEY (user_id, group_id),
        CONSTRAINT user_group_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES "user"(id),
        CONSTRAINT user_group_group_id_access_group_id_fk FOREIGN KEY (group_id) REFERENCES access_group(id)
    );
    CREATE INDEX idx_user_group_user ON user_group (user_id);
    CREATE INDEX idx_user_group_group ON user_group (group_id);`;

async function denganSkema(fn: (pool: Pool) => Promise<void>) {
    const skema = `uji_s70_${randomUUID().slice(0, 8)}`;
    const admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${skema}`);
    const url = new URL(PG_URL);
    url.searchParams.set("options", `-c search_path=${skema}`);
    const pool = new Pool({ connectionString: url.toString(), max: 3 });
    try {
        await pool.query(DASAR);
        await fn(pool);
    } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${skema} CASCADE`);
        await admin.end();
    }
}

/** Tiru loop scripts/migrate-pg.mjs main(): sudahAda ada baris -> SKIP, selain itu jalankan sql. */
async function jalankanMigrasi(pool: Pool, ms: Migration[]) {
    const log: string[] = [];
    for (const m of ms) {
        if ((await pool.query(m.sudahAda)).rowCount) { log.push(`SKIP ${m.nama}`); continue; }
        await pool.query(m.sql);
        log.push(`OK ${m.nama}`);
    }
    return log;
}

type Hasil = { command?: string; rowCount?: number | null; rows: { cek: string; ok: boolean | null }[] };
async function jalankanBerkas(pool: Pool, sql: string) {
    const hasil = await pool.query(sql) as unknown as Hasil[];
    return hasil;
}
const verifikasi = (hasil: Hasil[]) => hasil[hasil.length - 1].rows;

async function katalog(pool: Pool) {
    const kolom = await pool.query(`SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1) ORDER BY 1, 2`, [TABEL]);
    const constraint = await pool.query(`SELECT c.conrelid::regclass::text AS tabel, c.conname, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c WHERE c.connamespace = current_schema()::regnamespace AND c.conrelid::regclass::text = ANY($1)
        ORDER BY 1, 2`, [TABEL]);
    const indeks = await pool.query(`SELECT t.relname AS tablename, c.relname AS indexname,
            replace(pg_get_indexdef(c.oid), current_schema() || '.', '') AS def, x.indisunique AS unik,
            pg_get_expr(x.indpred, x.indrelid) AS predikat
        FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
        WHERE t.relnamespace = current_schema()::regnamespace AND t.relname = ANY($1) ORDER BY 1, 2`, [TABEL]);
    return { kolom: kolom.rows, constraint: constraint.rows, indeks: indeks.rows };
}

// Bentuk teks SQL yang sebanding antara Drizzle (sqlToQuery) dan katalog (pg_get_expr/column_default): tanpa awalan tabel,
// cast ::text/::boolean, kutip, kurung, spasi. Cukup untuk predikat/default sederhana di skema ini (bukan pembanding SQL umum).
const dialek = new PgDialect();
const teksSql = (v: unknown) => v === undefined || v === null ? "" : is(v, SQL) ? dialek.sqlToQuery(v).sql : typeof v === "string" ? `'${v}'` : String(v);
const normSql = (s: string | null | undefined) => (s ?? "").replace(/::(text|boolean)\b/g, "").replace(/"[^"]+"\./g, "").replace(/["()\s]/g, "");
const tipeDrizzle = (t: string) => (t === "timestamp" ? "timestamp without time zone" : t);

const kodeGalat = (kode: string) => (e: unknown) => (e as { code?: string }).code === kode;

test("PG S7-0: migrate-pg dari kosong dua kali — OK lalu SKIP; SQL mentah aman diulang", { skip: pgSkip }, async () => {
    const ms = await entri();
    await denganSkema(async (pool) => {
        assert.deepEqual(await jalankanMigrasi(pool, ms), NAMA_ENTRI.map((n) => `OK ${n}`));
        assert.deepEqual(await jalankanMigrasi(pool, ms), NAMA_ENTRI.map((n) => `SKIP ${n}`));
        const sebelum = await katalog(pool);
        for (const m of ms) await pool.query(m.sql);
        assert.deepEqual(await katalog(pool), sebelum, "SQL entri diulang tanpa perubahan");
        const kolom = (await pool.query(`SELECT is_nullable, column_default FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'user_group' AND column_name = 'is_primary'`)).rows[0];
        assert.deepEqual(kolom, { is_nullable: "NO", column_default: "false" });
    });
});

test("PG S7-0: keadaan sebagian — sudahAda tidak tertipu, entri melengkapi", { skip: pgSkip }, async () => {
    const [mPrincipal, mPrimary] = await entri();
    const cek = async (pool: Pool, m: Migration) => (await pool.query(m.sudahAda)).rowCount;
    await denganSkema(async (pool) => {
        await pool.query(mPrincipal.sql);
        await pool.query("DROP TABLE principal_alias");
        assert.equal(await cek(pool, mPrincipal), 0, "tanpa principal_alias = belum ada");
        await pool.query("DROP TABLE principal_variant");
        assert.equal(await cek(pool, mPrincipal), 0, "hanya principal = belum ada");
        await pool.query("DROP INDEX uq_principal_code");
        assert.equal(await cek(pool, mPrincipal), 0, "principal tanpa indeks unik kode = belum ada");
        await pool.query(mPrincipal.sql);
        assert.equal(await cek(pool, mPrincipal), 1, "dilengkapi");
        assert.ok((await pool.query("SELECT to_regclass('principal_alias') AS r")).rows[0].r);

        // Varian tanpa name/is_active (bentuk 893f8cbf) -> belum ada; entri menambah kolomnya.
        await pool.query("ALTER TABLE principal_variant DROP COLUMN name, DROP COLUMN is_active");
        assert.equal(await cek(pool, mPrincipal), 0, "varian tanpa name/is_active = belum ada");
        await pool.query(mPrincipal.sql);
        assert.equal(await cek(pool, mPrincipal), 1, "kolom varian ditambahkan");

        // Kolom sudah ada (mis. ditambah tangan) tetapi indeks unik parsial belum.
        await pool.query("ALTER TABLE user_group ADD COLUMN is_primary boolean NOT NULL DEFAULT false");
        assert.equal(await cek(pool, mPrimary), 0, "kolom tanpa indeks = belum ada");
        await pool.query(mPrimary.sql);
        assert.equal(await cek(pool, mPrimary), 1, "indeks dibuat");
    });
});

// Bentuk entri principal di commit 893f8cbf (alias_norm = PK global; varian tanpa name/is_active) — dibekukan untuk uji
// "DB yang sudah menjalankan versi lama". Jangan diubah mengikuti skema baru.
const BENTUK_893F8CBF = `
    CREATE TABLE principal (
        id text PRIMARY KEY DEFAULT gen_random_uuid()::text, code text NOT NULL, name text NOT NULL,
        is_active boolean NOT NULL DEFAULT true, created_by text, created_at timestamptz NOT NULL DEFAULT now(),
        updated_by text, updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT principal_code_format CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
        CONSTRAINT principal_name_isi CHECK (btrim(name) <> ''));
    CREATE UNIQUE INDEX uq_principal_code ON principal (code);
    CREATE TABLE principal_variant (
        principal_id text NOT NULL, variant_key text NOT NULL DEFAULT '', created_by text, created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT principal_variant_pkey PRIMARY KEY (principal_id, variant_key),
        CONSTRAINT principal_variant_principal_fk FOREIGN KEY (principal_id) REFERENCES principal (id) ON DELETE RESTRICT,
        CONSTRAINT principal_variant_key_format CHECK (variant_key ~ '^[A-Z0-9_-]{0,20}$'));
    CREATE TABLE principal_alias (
        alias_norm text NOT NULL, principal_id text NOT NULL, variant_key text, alias_asli text NOT NULL, jenis text NOT NULL,
        sumber text NOT NULL, created_by text, created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT principal_alias_pkey PRIMARY KEY (alias_norm),
        CONSTRAINT principal_alias_principal_fk FOREIGN KEY (principal_id) REFERENCES principal (id) ON DELETE RESTRICT,
        CONSTRAINT principal_alias_variant_fk FOREIGN KEY (principal_id, variant_key)
            REFERENCES principal_variant (principal_id, variant_key) ON DELETE RESTRICT,
        CONSTRAINT principal_alias_norm_isi CHECK (btrim(alias_norm) <> ''),
        CONSTRAINT principal_alias_asli_isi CHECK (btrim(alias_asli) <> ''),
        CONSTRAINT principal_alias_sumber_isi CHECK (btrim(sumber) <> ''),
        CONSTRAINT principal_alias_jenis CHECK (jenis IN
            ('nama', 'kode_master_barang', 'label_mapping', 'nama_bank', 'nama_summary', 'nama_surat')));
    CREATE INDEX idx_principal_alias_principal ON principal_alias (principal_id, variant_key);
    ALTER TABLE user_group ADD COLUMN is_primary boolean NOT NULL DEFAULT false;
    CREATE UNIQUE INDEX uq_user_group_primary ON user_group (user_id) WHERE is_primary;`;

test("PG S7-0: DB yang sudah menjalankan 893f8cbf — sudahAda tidak tertipu, migrate-pg menolak jelas, DDL mengubah tabel alias KOSONG dan berhenti bila berisi", { skip: pgSkip }, async () => {
    const ms = await entri();
    const { ddl } = await berkasDdl();
    let bentukBaru: Awaited<ReturnType<typeof katalog>> | undefined;
    await denganSkema(async (pool) => {
        await jalankanMigrasi(pool, ms);
        bentukBaru = await katalog(pool);
    });
    await denganSkema(async (pool) => {
        await pool.query(BENTUK_893F8CBF);
        assert.equal((await pool.query(ms[0].sudahAda)).rowCount, 0, "bentuk lama = belum ada");
        assert.equal((await pool.query(ms[1].sudahAda)).rowCount, 1, "is_primary tidak berubah sejak 893f8cbf");
        await assert.rejects(pool.query(ms[0].sql), /DDL_S7_0\.sql/, "migrate-pg tidak diam-diam membiarkan PK global");

        // Tabel alias lama BERISI -> DDL berhenti (tidak pernah DROP data), baris tetap ada.
        await pool.query(`INSERT INTO principal (id, code, name) VALUES ('p1', 'KINO', 'KINO')`);
        await pool.query(`INSERT INTO principal_alias (alias_norm, principal_id, alias_asli, jenis, sumber) VALUES ('KINO', 'p1', 'KINO', 'nama', 'uji')`);
        const c = await pool.connect();
        try {
            await assert.rejects(c.query(ddl), /BERISI/);
        } finally {
            await c.query("ROLLBACK"); // BEGIN berkas meninggalkan transaksi gagal di koneksi ini
            c.release();
        }
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM principal_alias")).rows[0].n, 1, "data lama utuh");

        await pool.query("DELETE FROM principal_alias");
        await pool.query("DELETE FROM principal");
        for (const v of verifikasi(await jalankanBerkas(pool, ddl))) assert.notEqual(v.ok, false, `VERIFIKASI gagal: ${v.cek}`);
        assert.deepEqual(await jalankanMigrasi(pool, ms), NAMA_ENTRI.map((n) => `SKIP ${n}`), "sesudah DDL, migrate-pg melewati");
        assert.deepEqual(await katalog(pool), bentukBaru, "bentuk lama diubah persis ke bentuk baru");
    });
});

test("PG S7-0: DDL_S7_0.sql dua kali idempoten + VERIFIKASI; sesudahnya migrate-pg melewati; bentuk = migrate-pg = db/migrations = Drizzle", { skip: pgSkip }, async () => {
    const ms = await entri();
    const { ddl } = await berkasDdl();
    let bentukMigrasi: Awaited<ReturnType<typeof katalog>> | undefined;
    await denganSkema(async (pool) => {
        await jalankanMigrasi(pool, ms);
        bentukMigrasi = await katalog(pool);
    });
    await denganSkema(async (pool) => {
        for (let i = 0; i < 2; i++) {
            for (const v of verifikasi(await jalankanBerkas(pool, ddl))) assert.notEqual(v.ok, false, `VERIFIKASI gagal: ${v.cek}`);
        }
        assert.deepEqual(await jalankanMigrasi(pool, ms), NAMA_ENTRI.map((n) => `SKIP ${n}`), "migrate-pg melewati sesudah DDL manual");
        assert.deepEqual(await katalog(pool), bentukMigrasi, "DDL manual = entri migrate-pg");
    });
    await denganSkema(async (pool) => {
        for (const berkas of ["0027_principal.sql", "0028_user_group_primary.sql"]) {
            await pool.query(await readFile(new URL(`../db/migrations/${berkas}`, import.meta.url), "utf8"));
        }
        assert.deepEqual(await katalog(pool), bentukMigrasi, "db/migrations = entri migrate-pg");
    });
    // Drizzle: kolom (tipe, NOT NULL, default), indeks (unik + predikat parsial), CHECK/FK/PK (nama) sama dengan katalog.
    const k = bentukMigrasi!;
    const tabelDrizzle: [string, PgTable][] = [["principal", principal], ["principal_variant", principalVariant], ["principal_alias", principalAlias], ["user_group", userGroup]];
    for (const [nama, t] of tabelDrizzle) {
        const cfg = getTableConfig(t);
        assert.deepEqual(
            cfg.columns.map((c) => [c.name, tipeDrizzle(c.getSQLType()), c.notNull ? "NO" : "YES", c.hasDefault ? normSql(teksSql(c.default)) : ""].join("|")).sort(),
            k.kolom.filter((r) => r.table_name === nama).map((r) => [r.column_name, r.data_type, r.is_nullable, normSql(r.column_default)].join("|")).sort(),
            `kolom Drizzle ${nama} (nama|tipe|nullable|default)`);
        const indeksDb = new Map(k.indeks.filter((r) => r.tablename === nama).map((r) => [r.indexname, `${r.unik}|${normSql(r.predikat)}`]));
        for (const i of cfg.indexes) {
            assert.equal(indeksDb.get(i.config.name), `${Boolean(i.config.unique)}|${normSql(teksSql(i.config.where))}`, `${nama}: indeks ${i.config.name} (unik|predikat)`);
        }
        const namaDb = new Set(k.constraint.filter((r) => r.tabel === nama).map((r) => r.conname));
        for (const n of [...cfg.checks.map((c) => c.name), ...cfg.foreignKeys.map((f) => f.getName()), ...cfg.primaryKeys.map((p) => p.getName())]) {
            assert.ok(namaDb.has(n), `${nama}: ${n} (Drizzle) ada di DB`);
        }
    }
});

test("PG S7-0: constraint — satu bintang per user, alias_norm unik per kelompok jenis, FK principal/varian, CHECK kode/varian/jenis", { skip: pgSkip }, async () => {
    const ms = await entri();
    await denganSkema(async (pool) => {
        await jalankanMigrasi(pool, ms);
        const q = (sql: string, p: unknown[] = []) => pool.query(sql, p);
        const id = async (code: string) => (await q("SELECT id FROM principal WHERE code = $1", [code])).rows[0].id as string;
        await q(`INSERT INTO principal (code, name, created_by) VALUES ('KINO', 'KINO INDONESIA TBK, PT', 'uji'), ('HEINZ', 'HEINZ ABC INDONESIA, PT', 'uji')`);
        const kino = await id("KINO"), heinz = await id("HEINZ");
        await q(`INSERT INTO principal_variant (principal_id, variant_key) VALUES ($1, ''), ($2, 'HZ'), ($2, 'BS')`, [kino, heinz]);
        await q(`INSERT INTO principal_variant (principal_id, variant_key, name) VALUES ($1, 'NON_FOOD', 'KINO NON FOOD')`, [kino]);
        // B-SEDANG-2: varian punya nama tampilan (opsional) + aktif (bawaan true).
        assert.deepEqual((await q(`SELECT variant_key, name, is_active FROM principal_variant WHERE principal_id = $1 ORDER BY 1`, [kino])).rows,
            [{ variant_key: "", name: null, is_active: true }, { variant_key: "NON_FOOD", name: "KINO NON FOOD", is_active: true }]);
        await assert.rejects(q(`UPDATE principal_variant SET is_active = NULL WHERE principal_id = $1`, [kino]), kodeGalat("23502"), "is_active NOT NULL");
        const alias = (norm: string, pid: string, varian: string | null, jenis = "nama") =>
            q(`INSERT INTO principal_alias (alias_norm, principal_id, variant_key, alias_asli, jenis, sumber) VALUES ($1, $2, $3, $1, $4, 'uji')`, [norm, pid, varian, jenis]);
        await alias("KINO NON FOOD", kino, "NON_FOOD", "label_mapping");
        await alias("KINO", kino, null);
        await alias("HZ", heinz, "HZ", "kode_master_barang");

        // B-SEDANG-1: kode Master Barang 2 karakter tidak boleh bertabrakan dengan nama/kode OPC (probe peninjau "MI");
        // di dalam kelompoknya masing-masing tetap unik — tabrakan nama sah DITOLAK (laporan ambiguous S7-2).
        await alias("MI", kino, null, "nama");
        await alias("MI", heinz, "HZ", "kode_master_barang");
        await assert.rejects(alias("MI", kino, null, "kode_master_barang"), kodeGalat("23505"), "kode Master Barang unik antar principal");
        await assert.rejects(alias("KINO", heinz, null), kodeGalat("23505"), "nama unik global");
        await assert.rejects(alias("KINO", heinz, null, "nama_bank"), kodeGalat("23505"), "nama unik lintas jenis non-kode");
        await assert.rejects(alias("TAK ADA", randomUUID(), null), kodeGalat("23503"), "FK principal");
        await assert.rejects(alias("HEINZ NON FOOD", heinz, "NON_FOOD"), kodeGalat("23503"), "varian milik principal lain ditolak");
        await assert.rejects(alias("", kino, null), kodeGalat("23514"), "alias_norm kosong");
        await assert.rejects(alias("KINO X", kino, null, "lain"), kodeGalat("23514"), "jenis di luar daftar");
        await assert.rejects(q(`INSERT INTO principal_variant (principal_id, variant_key) VALUES ($1, '')`, [randomUUID()]), kodeGalat("23503"), "FK varian");
        await assert.rejects(q(`INSERT INTO principal_variant (principal_id, variant_key) VALUES ($1, 'non food')`, [kino]), kodeGalat("23514"), "format varian");
        for (const kode of ["kino", "", "KINO INDONESIA", "A".repeat(21)]) {
            await assert.rejects(q(`INSERT INTO principal (code, name) VALUES ($1, 'X')`, [kode]), kodeGalat("23514"), `kode ${JSON.stringify(kode)}`);
        }
        await assert.rejects(q(`INSERT INTO principal (code, name) VALUES ('KINO', 'GANDA')`), kodeGalat("23505"), "kode unik");
        await assert.rejects(q(`INSERT INTO principal (code, name) VALUES ('KOSONG', '  ')`), kodeGalat("23514"), "nama kosong");
        await assert.rejects(q("DELETE FROM principal WHERE id = $1", [kino]), kodeGalat("23503"), "principal ber-varian/alias tidak bisa dihapus");

        // Bintang: satu per user; user lain boleh berbintang di grup yang sama.
        await q(`INSERT INTO "user" (id, name, email) VALUES ('u1', 'A', 'a@x'), ('u2', 'B', 'b@x')`);
        await q(`INSERT INTO access_group (id, name) VALUES ('g1', 'G1'), ('g2', 'G2')`);
        await q(`INSERT INTO user_group (user_id, group_id, assigned_at) VALUES ('u1', 'g1', now()), ('u1', 'g2', now()), ('u2', 'g1', now())`);
        await q(`UPDATE user_group SET is_primary = true WHERE user_id = 'u1' AND group_id = 'g1'`);
        await q(`UPDATE user_group SET is_primary = true WHERE user_id = 'u2' AND group_id = 'g1'`);
        await assert.rejects(q(`UPDATE user_group SET is_primary = true WHERE user_id = 'u1' AND group_id = 'g2'`), kodeGalat("23505"), "dua bintang ditolak");
    });
});

test("PG S7-0: BACKFILL — hanya user tepat 1 grup, user > 1 grup / sudah berbintang tidak disentuh, idempoten", { skip: pgSkip }, async () => {
    const { ddl, backfill } = await berkasDdl();
    await denganSkema(async (pool) => {
        await jalankanBerkas(pool, ddl);
        await pool.query(`INSERT INTO "user" (id, name, email) VALUES ('u1','1','1@x'), ('u2','2','2@x'), ('u3','3','3@x'), ('u4','4','4@x'), ('u5','5','5@x')`);
        await pool.query(`INSERT INTO access_group (id, name) VALUES ('g1', 'G1'), ('g2', 'G2')`);
        await pool.query(`INSERT INTO user_group (user_id, group_id, is_primary, assigned_at) VALUES
            ('u1','g1',false,now()), ('u2','g1',false,now()), ('u2','g2',false,now()), ('u4','g2',true,now()), ('u5','g1',false,now()), ('u5','g2',true,now())`);
        const keadaan = async () => (await pool.query(`SELECT user_id, group_id, is_primary FROM user_group ORDER BY 1, 2`)).rows
            .map((r) => `${r.user_id}/${r.group_id}:${r.is_primary}`);
        const diperbarui = (h: Hasil[]) => h.filter((r) => r.command === "UPDATE").reduce((n, r) => n + (r.rowCount ?? 0), 0);

        const pertama = await jalankanBerkas(pool, backfill);
        assert.equal(diperbarui(pertama), 1, "hanya u1 yang diberi bintang");
        for (const v of verifikasi(pertama)) assert.notEqual(v.ok, false, `VERIFIKASI BACKFILL gagal: ${v.cek}`);
        const sesudah = await keadaan();
        assert.deepEqual(sesudah, ["u1/g1:true", "u2/g1:false", "u2/g2:false", "u4/g2:true", "u5/g1:false", "u5/g2:true"]);
        const kedua = await jalankanBerkas(pool, backfill);
        assert.equal(diperbarui(kedua), 0, "jalan kedua tanpa perubahan");
        assert.deepEqual(await keadaan(), sesudah);
    });
});

test("PG S7-0: DDL — GRANT DML principal* ke accapi_app (role sementara di transaksi yang di-ROLLBACK)", { skip: pgSkip }, async () => {
    const { ddl } = await berkasDdl();
    // Tanpa BEGIN/COMMIT berkas: semuanya ikut transaksi uji agar CREATE ROLE tidak pernah ter-commit.
    const tanpaTransaksi = ddl.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
    assert.ok(!/^(BEGIN|COMMIT);$/m.test(tanpaTransaksi), "berkas DDL punya tepat satu BEGIN/COMMIT di bagian DDL");
    await denganSkema(async (pool) => {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const ada = (await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app'")).rowCount;
            if (!ada) await client.query("CREATE ROLE accapi_app NOLOGIN");
            const hasil = await client.query(tanpaTransaksi) as unknown as Hasil[];
            const v = new Map(verifikasi(hasil).map((r) => [r.cek, r.ok]));
            assert.equal(v.get("accapi_app boleh SELECT/INSERT/UPDATE/DELETE principal*"), true, "dengan role ada, baris hak WAJIB true");
            for (const [cek, ok] of v) assert.equal(ok, true, `VERIFIKASI ${cek}`);
        } finally {
            await client.query("ROLLBACK");
            client.release();
        }
        assert.equal((await pool.query("SELECT to_regclass('principal') AS r")).rows[0].r, null, "transaksi uji benar-benar di-ROLLBACK");
    });
});
