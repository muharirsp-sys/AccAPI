/* S7-2 (BL-64) di Postgres EVALUASI (AM040_DATABASE_URL, bukan produksi). Tiap kelompok uji memakai SKEMA SEKALI-PAKAI
 * (search_path HANYA skema itu, DROP di akhir) berisi user/access_group/user_group bentuk sebelum S7-0, lalu DDL_S7_0.sql +
 * DDL_S7_2.sql dijalankan sungguhan. Diuji: DDL_S7_2 (prasyarat, idempoten, append-only, hak accapi_app, = migrate-pg = migrasi =
 * Drizzle), route ASLI /api/principals/** pada DB nyata (409 tabrakan tanpa menimpa, kode tetap + trigger, 503 tanpa trigger,
 * atomik + principal_log, balapan alias), resolver dari DB, dan skrip laporan (baca-saja, galat ≠ kosong) + benih SQL-nya pada
 * data sintetis berejaan nyata (dua kali = idempoten). Sesi & grup izin dipalsukan. Tanpa env dilewati dengan sebabnya. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { getTableConfig } from "drizzle-orm/pg-core";
import { NextRequest } from "next/server";
import { principalLog, userGroup } from "../db/schema.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";
const ME = "u-prin";

const DASAR = `
    CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE);
    CREATE TABLE access_group (id text PRIMARY KEY, name text NOT NULL UNIQUE, is_preset boolean NOT NULL DEFAULT false);
    CREATE TABLE user_group (user_id text NOT NULL REFERENCES "user"(id), group_id text NOT NULL REFERENCES access_group(id),
        assigned_by text, assigned_at timestamp NOT NULL, PRIMARY KEY (user_id, group_id));`;
const berkas = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");
const urlSkema = (skema: string) => {
    const u = new URL(PG_URL);
    u.searchParams.set("options", `-c search_path=${skema}`);
    return u.toString();
};
type Hasil = { rows: { cek: string; ok: boolean | null }[] };
const verifikasi = (hasil: unknown) => { const h = (Array.isArray(hasil) ? hasil : [hasil]) as Hasil[]; return h[h.length - 1].rows; };
const semuaOk = (rows: { cek: string; ok: boolean | null }[]) => { for (const v of rows) assert.notEqual(v.ok, false, `VERIFIKASI gagal: ${v.cek}`); };
const kodeGalat = (kode: string) => (e: unknown) => (e as { code?: string }).code === kode;

const skemaDibuat: string[] = [];
let admin: Pool;
async function skemaBaru(isi: "dasar" | "s70" | "s72"): Promise<{ skema: string; pool: Pool }> {
    const skema = `uji_s72_${randomUUID().slice(0, 8)}`;
    await admin.query(`CREATE SCHEMA ${skema}`);
    skemaDibuat.push(skema);
    const pool = new Pool({ connectionString: urlSkema(skema), max: 3 });
    await pool.query(DASAR);
    if (isi !== "dasar") await pool.query(await berkas("../docs/handover/DDL_S7_0.sql"));
    if (isi === "s72") semuaOk(verifikasi(await pool.query(await berkas("../docs/handover/DDL_S7_2.sql"))));
    return { skema, pool };
}

// Skema utama untuk route: DATABASE_URL diarahkan ke sana SEBELUM lib/db dimuat (impor dinamis).
let utama: { skema: string; pool: Pool };
type Route = (req: NextRequest, ctx?: unknown) => Promise<Response>;
let m: Awaited<ReturnType<typeof muatModul>>;
async function muatModul() {
    const { db } = await import("./db.ts");
    const { auth } = await import("./auth.ts");
    const r = (p: string) => import(p) as Promise<Record<string, Route>>;
    return {
        db, auth, tulis: await import("./principal/tulis.ts"), resolver: await import("./principal/resolver.ts"),
        daftar: await r("../app/api/principals/route.ts"), satu: await r("../app/api/principals/[id]/route.ts"),
        riwayat: await r("../app/api/principals/[id]/history/route.ts"), varian: await r("../app/api/principals/[id]/variants/route.ts"),
        alias: await r("../app/api/principals/[id]/aliases/route.ts"), hapus: await r("../app/api/principals/[id]/aliases/[aliasId]/route.ts"),
        resolve: await r("../app/api/principals/resolve/route.ts"),
    };
}

before(async () => {
    if (!PG_URL) return;
    admin = new Pool({ connectionString: PG_URL, max: 1 });
    utama = await skemaBaru("s72");
    process.env.DATABASE_URL = urlSkema(utama.skema);
    delete process.env.LOCAL_AUTH_BYPASS;
    m = await muatModul();
    // Sesi & grup izin palsu (izin principles.*); semua tabel lain = DB nyata skema uji.
    const realSelect = m.db.select.bind(m.db);
    Object.defineProperty(m.auth.api, "getSession", { configurable: true, value: async () => ({ user: { id: ME, role: "staff" }, session: { id: "s1" } }) });
    Object.defineProperty(m.db, "select", { configurable: true, value: (...a: unknown[]) => {
        const b = (realSelect as (...x: unknown[]) => { from: (t: unknown) => unknown })(...a);
        const realFrom = b.from.bind(b);
        b.from = (t: unknown) => (t === userGroup
            ? { leftJoin: () => ({ where: async () => ["principles.view", "principles.upload", "principles.delete"].map((key) => ({ groupId: "g", key })) }) }
            : realFrom(t));
        return b;
    } });
});

after(async () => {
    if (!PG_URL) return;
    await utama?.pool.end();
    await (await import("./db.ts")).pool.end();
    for (const s of skemaDibuat) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await admin.end();
});

const req = (method: string, url: string, body?: unknown) => new NextRequest(`http://app.test${url}`, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});
const ctx = (id: string, aliasId = "") => ({ params: Promise.resolve({ id, aliasId }) });
async function panggil(res: Promise<Response>) {
    const r = await res;
    return { status: r.status, body: await r.json() as Record<string, unknown> & { code?: string } };
}
const hitung = async (tabel: string) => Number((await utama.pool.query(`SELECT count(*) AS n FROM ${tabel}`)).rows[0].n);
const buat = (code: string, name: string) => panggil(m.daftar.POST(req("POST", "/api/principals", { code, name })));

// --------------------------------------------------------------------------- DDL

test("PG S7-2: DDL_S7_2 berhenti tanpa S7-0 (tidak membuat apa pun); dua kali idempoten; migrate-pg SKIP; = migrasi = Drizzle", { skip: pgSkip }, async () => {
    const ddl = await berkas("../docs/handover/DDL_S7_2.sql");
    const { migrations } = await import(new URL("../scripts/migrate-pg.mjs", import.meta.url).href) as { migrations: { nama: string; sudahAda: string; sql: string }[] };
    const entri = migrations.find((x) => x.nama === "principal_log");
    assert.ok(entri);
    const katalog = async (pool: Pool) => ({
        kolom: (await pool.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'principal_log' ORDER BY 1`)).rows,
        constraint: (await pool.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conrelid = to_regclass('principal_log') ORDER BY 1`)).rows,
        indeks: (await pool.query(`SELECT indexname, replace(indexdef, current_schema() || '.', '') AS def FROM pg_indexes
            WHERE schemaname = current_schema() AND tablename = 'principal_log' ORDER BY 1`)).rows,
    });

    const dasar = await skemaBaru("dasar");
    const c = await dasar.pool.connect();
    try {
        await assert.rejects(c.query(ddl), /tabel principal belum ada/);
    } finally {
        await c.query("ROLLBACK");
        c.release();
    }
    assert.equal((await dasar.pool.query("SELECT to_regclass('principal_log') AS r")).rows[0].r, null, "tidak ada yang dibuat");
    await dasar.pool.query(await berkas("../docs/handover/DDL_S7_0.sql"));
    await dasar.pool.query("ALTER TABLE principal DISABLE TRIGGER trg_principal_code_tetap");
    const c2 = await dasar.pool.connect();
    try {
        await assert.rejects(c2.query(ddl), /trg_principal_code_tetap tidak terpasang persis/, "trigger S7-0 nonaktif = prasyarat gagal");
    } finally {
        await c2.query("ROLLBACK");
        c2.release();
    }
    await dasar.pool.query("ALTER TABLE principal ENABLE TRIGGER trg_principal_code_tetap");
    semuaOk(verifikasi(await dasar.pool.query(ddl)));
    const sekali = await katalog(dasar.pool);
    semuaOk(verifikasi(await dasar.pool.query(ddl)));
    assert.deepEqual(await katalog(dasar.pool), sekali, "jalan kedua tanpa perubahan");
    assert.equal((await dasar.pool.query(entri.sudahAda)).rowCount, 1, "sesudah DDL manual, migrate-pg SKIP");

    const lewatMigrasi = await skemaBaru("s70");
    assert.equal((await lewatMigrasi.pool.query(entri.sudahAda)).rowCount, 0);
    await lewatMigrasi.pool.query(entri.sql);
    assert.equal((await lewatMigrasi.pool.query(entri.sudahAda)).rowCount, 1);
    await lewatMigrasi.pool.query(entri.sql);
    assert.deepEqual(await katalog(lewatMigrasi.pool), sekali, "entri migrate-pg = DDL manual");
    const tanpaTrigger = await lewatMigrasi.pool.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = to_regclass('principal_log') AND NOT tgisinternal`);
    assert.equal(tanpaTrigger.rows[0].n, 0, "migrate-pg TIDAK memasang trigger (DDL manual wajib)");
    semuaOk(verifikasi(await lewatMigrasi.pool.query(ddl)));

    const lewatBerkas = await skemaBaru("s70");
    await lewatBerkas.pool.query(await berkas("../db/migrations/0030_principal_log.sql"));
    assert.deepEqual(await katalog(lewatBerkas.pool), sekali, "db/migrations/0030 = DDL manual");

    const cfg = getTableConfig(principalLog);
    assert.deepEqual(cfg.columns.map((k) => [k.name, k.notNull ? "NO" : "YES"].join("|")).sort(),
        sekali.kolom.map((k) => [k.column_name, k.is_nullable].join("|")).sort(), "kolom Drizzle = DB");
    assert.deepEqual(cfg.columns.map((k) => k.getSQLType()).sort(), ["bigserial", "jsonb", "jsonb", "text", "text", "text", "text", "text", "timestamp with time zone"]);
    const namaDb = new Set(sekali.constraint.map((k) => k.conname));
    for (const n of cfg.checks.map((k) => k.name)) assert.ok(namaDb.has(n), `CHECK ${n}`);
    assert.deepEqual(cfg.indexes.map((i) => i.config.name), ["idx_principal_log_principal"]);
});

test("PG S7-2: principal_log append-only — UPDATE/DELETE/TRUNCATE ditolak trigger; accapi_app hanya SELECT/INSERT (role sementara, ROLLBACK)", { skip: pgSkip }, async () => {
    const { pool } = await skemaBaru("s72");
    await pool.query(`INSERT INTO principal_log (entitas, kunci, principal_id, aksi, aktor) VALUES ('principal', 'p', 'p', 'buat', 'uji')`);
    for (const q of ["UPDATE principal_log SET aktor = 'x'", "DELETE FROM principal_log", "TRUNCATE principal_log"]) {
        await assert.rejects(pool.query(q), kodeGalat("23001"), q);
    }
    assert.equal(Number((await pool.query("SELECT count(*) AS n FROM principal_log")).rows[0].n), 1);
    await assert.rejects(pool.query(`INSERT INTO principal_log (entitas, kunci, principal_id, aksi, aktor) VALUES ('x', 'p', 'p', 'buat', 'uji')`), kodeGalat("23514"));
    await assert.rejects(pool.query(`INSERT INTO principal_log (entitas, kunci, principal_id, aksi, aktor) VALUES ('alias', 'p', 'p', 'ubah', ' ')`), kodeGalat("23514"));

    // Hak: tanpa BEGIN/COMMIT berkas, semua di transaksi uji yang di-ROLLBACK -> role sementara tak pernah ter-commit.
    const ddl = (await berkas("../docs/handover/DDL_S7_2.sql")).replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
    const c = await pool.connect();
    try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(61000423)"); // kunci yang sama dengan uji role invoice-outbox-event
        if (!(await c.query("SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app'")).rowCount) await c.query("CREATE ROLE accapi_app NOLOGIN");
        await c.query("GRANT ALL ON principal_log TO accapi_app"); // tiru default privileges L1g: DDL wajib mencabutnya
        await c.query(`GRANT USAGE ON SCHEMA ${(await c.query("SELECT current_schema() AS s")).rows[0].s} TO accapi_app`);
        await c.query("GRANT SELECT, INSERT, UPDATE, DELETE ON principal, principal_variant, principal_alias TO accapi_app");
        const v = verifikasi(await c.query(ddl));
        for (const r of v) assert.equal(r.ok, true, `VERIFIKASI dengan role: ${r.cek}`);
        await c.query("SET LOCAL ROLE accapi_app");
        await c.query(`INSERT INTO principal_log (entitas, kunci, principal_id, aksi, aktor) VALUES ('principal', 'q', 'q', 'buat', 'app')`);
        await c.query("SAVEPOINT s");
        await assert.rejects(c.query("UPDATE principal_log SET aktor = 'x'"), kodeGalat("42501"), "dicabut HAK, bukan hanya trigger");
        await c.query("ROLLBACK TO SAVEPOINT s");
        await assert.rejects(c.query("DELETE FROM principal_log"), kodeGalat("42501"));
    } finally {
        await c.query("ROLLBACK");
        c.release();
    }
});

// --------------------------------------------------------------------------- route + DB nyata

test("PG S7-2: buat principal = principal + alias kode & nama + principal_log satu transaksi; kode ganda 409; nama bertabrakan 409 tanpa sisa", { skip: pgSkip }, async () => {
    const kino = await buat("kino", " KINO INDONESIA. TBK, PT ");
    assert.equal(kino.status, 201, JSON.stringify(kino.body));
    const p = kino.body.principal as { id: string; code: string; name: string };
    assert.deepEqual([p.code, p.name], ["KINO", "KINO INDONESIA. TBK, PT"]);
    const alias = (await utama.pool.query(`SELECT alias_norm, jenis, sumber, variant_key FROM principal_alias WHERE principal_id = $1 ORDER BY alias_norm`, [p.id])).rows;
    assert.deepEqual(alias, [
        { alias_norm: "KINO", jenis: "nama", sumber: "kode_principal", variant_key: null },
        { alias_norm: "KINO INDONESIA. TBK, PT", jenis: "nama", sumber: "nama_resmi", variant_key: null },
    ]);
    const log = (await utama.pool.query(`SELECT entitas, aksi, aktor, after->>'code' AS code FROM principal_log WHERE principal_id = $1 ORDER BY id`, [p.id])).rows;
    assert.deepEqual(log.map((l) => `${l.entitas}:${l.aksi}:${l.aktor}`), [`principal:buat:${ME}`, `alias:buat:${ME}`, `alias:buat:${ME}`]);
    assert.equal(log[0].code, "KINO");

    const sebelum = [await hitung("principal"), await hitung("principal_alias"), await hitung("principal_log")];
    const ganda = await buat("KINO", "Lain");
    assert.deepEqual([ganda.status, ganda.body.code], [409, "KODE_SUDAH_ADA"]);
    const tabrak = await buat("KINO2", "kino indonesia. tbk, pt");
    assert.deepEqual([tabrak.status, tabrak.body.code, (tabrak.body.pemilik as { code: string }).code], [409, "ALIAS_TABRAKAN", "KINO"]);
    assert.deepEqual([await hitung("principal"), await hitung("principal_alias"), await hitung("principal_log")], sebelum, "tak ada sisa (atomik)");
    assert.equal((await utama.pool.query(`SELECT count(*)::int AS n FROM principal WHERE code = 'KINO2'`)).rows[0].n, 0);
});

test("PG S7-2: varian & alias — varian dasar ditolak tanpa varian lain; tabrakan 409 TIDAK menimpa; ruang kode Master Barang terpisah; resolver dari DB", { skip: pgSkip }, async () => {
    const id = (code: string) => utama.pool.query(`SELECT id FROM principal WHERE code = $1`, [code]).then((r) => r.rows[0].id as string);
    const kino = await id("KINO");
    const mi = (await buat("MI", "MARKETAMA INDAH, PT")).body.principal as { id: string };
    const frs = (await buat("FRS", "FORISA NUSAPERSADA, PT")).body.principal as { id: string };
    const varian = (pid: string, body: unknown) => panggil(m.varian.POST(req("POST", `/api/principals/${pid}/variants`, body), ctx(pid)));
    const alias = (pid: string, body: unknown) => panggil(m.alias.POST(req("POST", `/api/principals/${pid}/aliases`, body), ctx(pid)));

    assert.deepEqual((await varian(frs.id, { variantKey: "" })).body.code, "VARIAN_DASAR_TANPA_LAIN");
    const nf = await varian(kino, { variantKey: "non_food", name: "KINO NON FOOD" });
    assert.equal(nf.status, 201, JSON.stringify(nf.body));
    assert.deepEqual((await varian(kino, { variantKey: "NON_FOOD" })).body.code, "VARIAN_SUDAH_ADA");
    assert.equal((await varian(kino, { variantKey: "", name: "KINO FOOD" })).status, 201, "dasar boleh sesudah ada varian lain");
    assert.equal((await varian(frs.id, { variantKey: "MT", name: "FORISA MT" })).status, 201);

    const sama = await alias(kino, { alias: "Kino Non  Food", jenis: "label_mapping", variantKey: "NON_FOOD" });
    assert.deepEqual([sama.status, sama.body.code], [409, "ALIAS_SUDAH_ADA"]);
    const rebut = await alias(mi.id, { alias: "kino non food", jenis: "label_mapping" });
    assert.deepEqual([rebut.status, rebut.body.code, (rebut.body.pemilik as { code: string; variantKey: string }).variantKey], [409, "ALIAS_TABRAKAN", "NON_FOOD"]);
    const pemilik = (await utama.pool.query(`SELECT p.code, a.variant_key FROM principal_alias a JOIN principal p ON p.id = a.principal_id WHERE a.alias_norm = 'KINO NON FOOD'`)).rows;
    assert.deepEqual(pemilik, [{ code: "KINO", variant_key: "NON_FOOD" }], "pemilik lama utuh — tidak ditimpa");

    assert.equal((await alias(kino, { alias: "mi", jenis: "kode_master_barang" })).status, 201, "'MI' kode Master Barang KINO sah walau 'MI' = kode principal MI");
    assert.deepEqual((await alias(mi.id, { alias: "MI", jenis: "kode_master_barang" })).body.code, "ALIAS_TABRAKAN");
    assert.deepEqual((await alias(kino, { alias: "KINO NON FOOD", jenis: "nama", variantKey: "MT" })).body.code, "VARIAN_TIDAK_ADA");
    assert.equal((await alias(frs.id, { alias: "PT.FORISA**", jenis: "nama_surat", sumber: "surat Okt" })).status, 201);

    // Balapan: dua permintaan bersamaan, ejaan sama, principal berbeda -> tepat satu menang, yang lain 409.
    const [x, y] = await Promise.all([alias(mi.id, { alias: "RAJA SNACK", jenis: "nama" }), alias(frs.id, { alias: "raja snack", jenis: "nama_surat" })]);
    assert.deepEqual([x.status, y.status].sort(), [201, 409]);
    assert.ok(["ALIAS_TABRAKAN"].includes(String((x.status === 409 ? x : y).body.code)));

    const indeks = await m.tulis.muatIndeksAlias();
    const r = (t: string, ruang: "nama" | "kode_master_barang" = "nama") => m.resolver.resolvePrincipal(t, indeks, ruang);
    const nfr = r("kino\tnon food");
    assert.deepEqual(nfr.status === "cocok" && [nfr.code, nfr.variantKey], ["KINO", "NON_FOOD"]);
    assert.deepEqual((x => x.status === "cocok" && x.code)(r("MI")), "MI");
    assert.deepEqual((x => x.status === "cocok" && x.code)(r("MI", "kode_master_barang")), "KINO");
    assert.equal(r("FORISA").status, "tak_dikenal", "resolver tidak menebak");

    // HTTP /api/principals/resolve (pemakai Python tahap 2): normalizer & ruang yang sama, DB nyata.
    const lewatHttp = async (q: string) => (await panggil(m.resolve.GET(req("GET", `/api/principals/resolve?${q}`)))).body.hasil as { status: string; code?: string; variantKey?: string | null };
    const nfHttp = await lewatHttp("teks=%20kino%C2%A0non%20food&ruang=nama");
    assert.deepEqual([nfHttp.status, nfHttp.code, nfHttp.variantKey], ["cocok", "KINO", "NON_FOOD"]);
    assert.deepEqual([(await lewatHttp("teks=MI&ruang=kode_master_barang")).code, (await lewatHttp("teks=mi&ruang=nama")).code], ["KINO", "MI"]);
    assert.equal((await lewatHttp("teks=MI%20GORENG&ruang=nama")).status, "tak_dikenal");
});

test("PG S7-2: kode tidak bisa diubah (route 400 + trigger DB); nonaktif/aktif tercatat; nonaktif menolak tambah alias; hapus alias", { skip: pgSkip }, async () => {
    const { id: kino } = (await utama.pool.query(`SELECT id FROM principal WHERE code = 'KINO'`)).rows[0];
    const patch = (body: unknown) => panggil(m.satu.PATCH(req("PATCH", `/api/principals/${kino}`, body), ctx(kino)));
    assert.deepEqual((await patch({ code: "KINO_BARU" })).body.code, "KODE_TETAP");
    await assert.rejects(utama.pool.query(`UPDATE principal SET code = 'KINO_BARU' WHERE id = $1`, [kino]), kodeGalat("23001"), "trigger S7-0");
    assert.equal((await utama.pool.query(`SELECT code FROM principal WHERE id = $1`, [kino])).rows[0].code, "KINO");

    const logAwal = await hitung("principal_log");
    const mati = await patch({ isActive: false });
    assert.deepEqual([mati.status, mati.body.berubah, (mati.body.principal as { isActive: boolean }).isActive], [200, true, false]);
    assert.deepEqual([(await patch({ isActive: false })).body.berubah, await hitung("principal_log")], [false, logAwal + 1], "status sama = tanpa riwayat");
    const nonaktif = await panggil(m.alias.POST(req("POST", `/api/principals/${kino}/aliases`, { alias: "KINO X", jenis: "nama" }), ctx(kino)));
    assert.deepEqual([nonaktif.status, nonaktif.body.code], [409, "PRINCIPAL_NONAKTIF"]);
    assert.equal((await patch({ isActive: true })).body.berubah, true);
    const indeks = await m.tulis.muatIndeksAlias();
    const k = m.resolver.resolvePrincipal("KINO", indeks, "nama");
    assert.deepEqual(k.status === "cocok" && k.aktif, true);

    const vPatch = (body: unknown) => panggil(m.varian.PATCH(req("PATCH", `/api/principals/${kino}/variants`, body), ctx(kino)));
    assert.equal((await vPatch({ variantKey: "NON_FOOD", isActive: false })).body.berubah, true);
    const keVarianMati = await panggil(m.alias.POST(req("POST", `/api/principals/${kino}/aliases`, { alias: "KNF", jenis: "nama", variantKey: "NON_FOOD" }), ctx(kino)));
    assert.deepEqual(keVarianMati.body.code, "VARIAN_NONAKTIF");
    const nf = m.resolver.resolvePrincipal("KINO NON FOOD", await m.tulis.muatIndeksAlias(), "nama");
    assert.deepEqual(nf.status === "cocok" && nf.aktif, false, "varian nonaktif ditandai");
    assert.deepEqual((await vPatch({ variantKey: "ZZ", isActive: true })).body.code, "VARIAN_TIDAK_ADA");
    await vPatch({ variantKey: "NON_FOOD", isActive: true });

    const aliasKode = (await utama.pool.query(`SELECT id FROM principal_alias WHERE principal_id = $1 AND sumber = 'kode_principal'`, [kino])).rows[0].id;
    const hapus = (aid: string) => panggil(m.hapus.DELETE(req("DELETE", `/api/principals/${kino}/aliases/${aid}`), ctx(kino, aid)));
    assert.deepEqual((await hapus(aliasKode)).body.code, "ALIAS_KODE_TETAP");
    const mb = (await utama.pool.query(`SELECT id FROM principal_alias WHERE principal_id = $1 AND jenis = 'kode_master_barang'`, [kino])).rows[0].id;
    const h = await hapus(mb);
    assert.equal(h.status, 200);
    const jejak = (await utama.pool.query(`SELECT aksi, before->>'aliasNorm' AS norm, after FROM principal_log WHERE kunci = $1 ORDER BY id`, [mb])).rows;
    assert.deepEqual(jejak, [{ aksi: "buat", norm: null, after: jejak[0].after }, { aksi: "hapus", norm: "MI", after: null }]);
    assert.deepEqual((await hapus(mb)).body.code, "ALIAS_TIDAK_ADA");

    const daftar = await panggil(m.daftar.GET(req("GET", "/api/principals")));
    const p = (daftar.body.principals as { code: string; variants: { variantKey: string }[]; aliases: unknown[] }[]).find((x) => x.code === "KINO");
    assert.deepEqual(p?.variants.map((v) => v.variantKey), ["", "NON_FOOD"]);
    const r1 = await panggil(m.riwayat.GET(req("GET", `/api/principals/${kino}/history?batas=3`), ctx(kino)));
    const r1b = r1.body as { riwayat: { id: number; aksi: string }[]; sebelum: number };
    assert.equal(r1b.riwayat[0].aksi, "hapus", "terbaru dulu");
    const r2 = await panggil(m.riwayat.GET(req("GET", `/api/principals/${kino}/history?sebelum=${r1b.sebelum}&batas=200`), ctx(kino)));
    const semua = [...r1b.riwayat, ...(r2.body.riwayat as { id: number }[])].map((x) => x.id);
    assert.deepEqual(semua, [...semua].sort((a, b) => b - a));
    assert.equal(new Set(semua).size, Number((await utama.pool.query(`SELECT count(*) AS n FROM principal_log WHERE principal_id = $1`, [kino])).rows[0].n));
    assert.equal((await panggil(m.riwayat.GET(req("GET", "/api/principals/tidak-ada/history"), ctx("tidak-ada")))).status, 404);
});

test("PG S7-2: atomik — principal_log gagal = principal TIDAK tercipta; trigger dimatikan/dihapus = 503 tanpa tulisan", { skip: pgSkip }, async () => {
    const sebelum = [await hitung("principal"), await hitung("principal_alias"), await hitung("principal_log")];
    await utama.pool.query("ALTER TABLE principal_log ADD CONSTRAINT uji_tolak_log CHECK (false) NOT VALID");
    try {
        const r = await buat("ATOM", "ATOMIK, PT");
        assert.ok(r.status >= 400 && r.body.ok === false, `log ditolak -> transaksi batal (${r.status})`);
    } finally {
        await utama.pool.query("ALTER TABLE principal_log DROP CONSTRAINT uji_tolak_log");
    }
    assert.deepEqual([await hitung("principal"), await hitung("principal_alias"), await hitung("principal_log")], sebelum);
    // Arah sebaliknya: perubahan gagal SESUDAH riwayat ditulis (saat COMMIT) -> riwayat ikut batal (bukan jejak yatim).
    await utama.pool.query(`CREATE FUNCTION uji_gagal_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'uji: gagal saat commit'; END $$;
        CREATE CONSTRAINT TRIGGER uji_gagal_commit AFTER INSERT ON principal DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION uji_gagal_commit()`);
    try {
        const r = await buat("ATOM2", "ATOMIK DUA, PT");
        assert.equal(r.status, 500);
    } finally {
        await utama.pool.query("DROP TRIGGER uji_gagal_commit ON principal; DROP FUNCTION uji_gagal_commit()");
    }
    assert.deepEqual([await hitung("principal"), await hitung("principal_alias"), await hitung("principal_log")], sebelum, "riwayat tidak tertinggal");

    await utama.pool.query("ALTER TABLE principal DISABLE TRIGGER trg_principal_code_tetap");
    try {
        const r = await buat("TANPA", "TANPA TRIGGER, PT");
        assert.deepEqual([r.status, r.body.code, r.body.kurang], [503, "PRINCIPAL_DDL_BELUM", ["trg_principal_code_tetap"]]);
    } finally {
        await utama.pool.query("ALTER TABLE principal ENABLE TRIGGER trg_principal_code_tetap");
    }
    await utama.pool.query("DROP TRIGGER trg_principal_log_append_only ON principal_log");
    try {
        const { id } = (await utama.pool.query(`SELECT id FROM principal WHERE code = 'KINO'`)).rows[0];
        const r = await panggil(m.satu.PATCH(req("PATCH", `/api/principals/${id}`, { isActive: false }), ctx(id)));
        assert.deepEqual([r.status, r.body.kurang], [503, ["trg_principal_log_append_only"]]);
        assert.equal((await utama.pool.query(`SELECT is_active FROM principal WHERE id = $1`, [id])).rows[0].is_active, true);
    } finally {
        semuaOk(verifikasi(await utama.pool.query(await berkas("../docs/handover/DDL_S7_2.sql"))));
    }
    assert.deepEqual([await hitung("principal"), await hitung("principal_alias"), await hitung("principal_log")], sebelum);
    assert.equal((await buat("SESUDAH", "SESUDAH DDL, PT")).status, 201, "DDL dipasang ulang -> tulis jalan lagi");
});

test("PG S7-2: penjaga KETAT — trigger bernama sama tetapi jenis event / kolom / WHEN / fungsi / isi fungsi lain = 503 + VERIFIKASI false + prasyarat DDL berhenti", { skip: pgSkip }, async () => {
    const ddl72 = await berkas("../docs/handover/DDL_S7_2.sql");
    const ddl70 = await berkas("../docs/handover/DDL_S7_0.sql");
    const blokVerifikasi = ddl72.slice(ddl72.indexOf("-- 4. VERIFIKASI"));
    assert.ok(blokVerifikasi.length > 100);
    const { id: kino } = (await utama.pool.query(`SELECT id FROM principal WHERE code = 'KINO'`)).rows[0];
    const sebelum = [await hitung("principal"), await hitung("principal_log")];
    const kasus: { nama: string; rusak: string; pulih: string; kurang: string[] }[] = [
        { nama: "fungsi log diganti RETURN NEW", kurang: ["trg_principal_log_append_only", "trg_principal_log_no_truncate"], pulih: ddl72,
            rusak: "CREATE OR REPLACE FUNCTION principal_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$" },
        { nama: "nama sama, jenis AFTER INSERT", kurang: ["trg_principal_log_append_only"], pulih: ddl72,
            rusak: `DROP TRIGGER trg_principal_log_append_only ON principal_log;
                    CREATE TRIGGER trg_principal_log_append_only AFTER INSERT ON principal_log FOR EACH ROW EXECUTE FUNCTION principal_log_append_only()` },
        { nama: "TRUNCATE jadi BEFORE INSERT statement", kurang: ["trg_principal_log_no_truncate"], pulih: ddl72,
            rusak: `DROP TRIGGER trg_principal_log_no_truncate ON principal_log;
                    CREATE TRIGGER trg_principal_log_no_truncate BEFORE INSERT ON principal_log FOR EACH STATEMENT EXECUTE FUNCTION principal_log_append_only()` },
        { nama: "nama & jenis sama, fungsi lain (isi sama)", kurang: ["trg_principal_log_append_only"], pulih: `${ddl72}; DROP FUNCTION IF EXISTS uji_lain()`,
            rusak: `CREATE FUNCTION uji_lain() RETURNS trigger LANGUAGE plpgsql AS $fn$
                    BEGIN RAISE EXCEPTION 'S7-2: principal_log append-only — % ditolak (riwayat principal)', TG_OP USING ERRCODE = 'restrict_violation'; END $fn$;
                    CREATE OR REPLACE TRIGGER trg_principal_log_append_only BEFORE UPDATE OR DELETE ON principal_log FOR EACH ROW EXECUTE FUNCTION uji_lain()` },
        { nama: "fungsi kode tetap diganti RETURN NEW", kurang: ["trg_principal_code_tetap"], pulih: ddl70,
            rusak: "CREATE OR REPLACE FUNCTION principal_code_tetap() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$" },
        { nama: "kode tetap WHEN (false)", kurang: ["trg_principal_code_tetap"], pulih: ddl70,
            rusak: "CREATE OR REPLACE TRIGGER trg_principal_code_tetap BEFORE UPDATE OF code ON principal FOR EACH ROW WHEN (false) EXECUTE FUNCTION principal_code_tetap()" },
        { nama: "kode tetap tanpa OF code (kolom lain)", kurang: ["trg_principal_code_tetap"], pulih: ddl70,
            rusak: "CREATE OR REPLACE TRIGGER trg_principal_code_tetap BEFORE UPDATE OF name ON principal FOR EACH ROW EXECUTE FUNCTION principal_code_tetap()" },
    ];
    for (const k of kasus) {
        await utama.pool.query(k.rusak);
        try {
            const r = await panggil(m.satu.PATCH(req("PATCH", `/api/principals/${kino}`, { isActive: false }), ctx(kino)));
            assert.deepEqual([r.status, r.body.code, r.body.kurang], [503, "PRINCIPAL_DDL_BELUM", k.kurang], k.nama);
            const v = verifikasi(await utama.pool.query(blokVerifikasi));
            assert.ok(v.some((x) => x.ok === false), `${k.nama}: VERIFIKASI DDL_S7_2 harus menandai false`);
            if (k.kurang.includes("trg_principal_code_tetap")) {
                const c = await utama.pool.connect();
                try {
                    await assert.rejects(c.query(ddl72), /trg_principal_code_tetap/, `${k.nama}: prasyarat DDL_S7_2 berhenti`);
                } finally {
                    await c.query("ROLLBACK");
                    c.release();
                }
            }
        } finally {
            await utama.pool.query(k.pulih);
        }
        semuaOk(verifikasi(await utama.pool.query(blokVerifikasi)));
    }
    assert.equal((await utama.pool.query(`SELECT is_active FROM principal WHERE id = $1`, [kino])).rows[0].is_active, true);
    assert.deepEqual([await hitung("principal"), await hitung("principal_log")], sebelum, "tidak ada tulisan selama penjaga rusak");
    const pulih = await panggil(m.satu.PATCH(req("PATCH", `/api/principals/${kino}`, { isActive: true }), ctx(kino)));
    assert.deepEqual([pulih.status, pulih.body.berubah], [200, false], "penjaga dipulihkan -> tulis jalan");
});

// --------------------------------------------------------------------------- laporan + benih

const SUMBER = `
    CREATE TABLE master_barang (id text PRIMARY KEY, principle_code text NOT NULL, principle_name text NOT NULL);
    CREATE TABLE principal_mapping (principal text NOT NULL, kind text NOT NULL, source_code text NOT NULL, PRIMARY KEY (principal, kind, source_code));
    CREATE TABLE no_claim_template (principle_code text NOT NULL, variant_key text NOT NULL DEFAULT '', PRIMARY KEY (principle_code, variant_key));
    CREATE TABLE off_batch (id text PRIMARY KEY, principle_code text NOT NULL, principle_name text NOT NULL);
    INSERT INTO master_barang VALUES ('m1', 'K1', 'KINO INDONESIA. TBK, PT'), ('m2', 'K1', 'KINO INDONESIA. TBK, PT'), ('m3', 'KN', 'KINO NON FOOD'),
        ('m4', 'GD', 'GODREJ'), ('m5', 'P1', 'PT. PRISKILA PRIMA MAKMUR'), ('m6', 'UR', 'URC INDONESIA, PTMIX FOOD'), ('m7', 'AC', 'ABC INDONESIA'),
        ('m8', 'XX', 'PT MAJU JAYA'), ('m9', 'P2', '**PT.PRISKILA PRIMA MAKMUR**');
    INSERT INTO principal_mapping VALUES ('KINO NON FOOD', 'item', 'A1'), ('KINO NON FOOD', 'customer', 'C1'), ('KINO NON FOOD-KN', 'item', 'A2'),
        ('Forisa' || chr(160) || 'MT', 'item', 'F1'), ('PRISKILA''S PRIMA MAKMUR', 'brand', 'B1');
    INSERT INTO no_claim_template VALUES ('HEINZ', 'HZ'), ('KINO', ''), ('ZZZ', '');
    INSERT INTO off_batch VALUES ('o1', 'KINO', 'KINO INDONESIA. TBK, PT'), ('o2', 'XYZ', 'XYZ, PT');`;

test("PG S7-2: laporan BACA-SAJA pada data sintetis (ejaan nyata) — sumber hilang = GAGAL; benih dua kali idempoten + VERIFIKASI; benih menolak tanpa trigger", { skip: pgSkip }, async () => {
    const lap = await skemaBaru("s72");
    await lap.pool.query(SUMBER); // claim_workflow sengaja TIDAK dibuat -> GAGAL dibaca, bukan kosong
    const url = urlSkema(lap.skema);
    const skrip = await import(new URL("../scripts/principal-laporan.mjs", import.meta.url).href) as {
        bukaBacaSaja: (u: string) => Promise<import("pg").Client>;
        jalankan: (o: { url: string; keluar: string; sekarang?: Date }) => Promise<{ gagal: string[] }>;
    };
    const ro = await skrip.bukaBacaSaja(url);
    try {
        assert.equal((await ro.query("SHOW default_transaction_read_only")).rows[0].default_transaction_read_only, "on");
        await assert.rejects(ro.query(`INSERT INTO principal_log (entitas, kunci, principal_id, aksi, aktor) VALUES ('principal', 'x', 'x', 'buat', 'x')`), kodeGalat("25006"));
    } finally {
        await ro.end();
    }

    const folder = await mkdtemp(path.join(tmpdir(), "s72-laporan-"));
    try {
        const { gagal } = await skrip.jalankan({ url, keluar: folder, sekarang: new Date("2026-10-11T00:00:00Z") });
        assert.deepEqual(gagal, ["claim_workflow — kode Klaim"]);
        const md = await readFile(path.join(folder, "laporan.md"), "utf8");
        assert.match(md, /\| claim_workflow — kode Klaim \| GAGAL \| GAGAL \| GAGAL \|/);
        assert.match(md, /\| master_barang — nama principal \| 6 \| 1 \| 1 \|/, "persis 3 + longgar 3 (P1, P2, UR) / ABC ambigu / MAJU unmatched");
        const json = JSON.parse(await readFile(path.join(folder, "laporan.json"), "utf8")) as { sumber: { judul: string; baris: { nilai: string; status: string; cara?: string }[] }[] };
        const nama = json.sumber.find((s) => s.judul.startsWith("master_barang — nama"))!.baris;
        const ocr = nama.find((b) => b.nilai === "**PT.PRISKILA PRIMA MAKMUR**");
        assert.deepEqual([ocr?.status, ocr?.cara], ["matched", "longgar"], "ejaan OCR surat");
        assert.equal(await hitungDi(lap.pool, "principal"), 0, "laporan tidak menulis apa pun");

        const benih = await readFile(path.join(folder, "benih.sql"), "utf8");
        for (let i = 0; i < 2; i++) {
            const v = verifikasi(await lap.pool.query(benih));
            assert.ok(v.length > 100);
            semuaOk(v);
        }
        assert.deepEqual([await hitungDi(lap.pool, "principal"), await hitungDi(lap.pool, "principal_variant")], [25, 5]);
        const jumlahAlias = await hitungDi(lap.pool, "principal_alias");
        assert.equal(await hitungDi(lap.pool, "principal_log"), 25 + 5 + jumlahAlias, "satu baris riwayat per baris benih, tidak berlipat saat diulang");
        const mb = (await lap.pool.query(`SELECT a.alias_norm, p.code, a.variant_key FROM principal_alias a JOIN principal p ON p.id = a.principal_id
            WHERE a.jenis = 'kode_master_barang' ORDER BY 1`)).rows;
        assert.deepEqual(mb, [{ alias_norm: "GD", code: "GDI", variant_key: null }, { alias_norm: "K1", code: "KINO", variant_key: null },
            { alias_norm: "KN", code: "KINO", variant_key: "NON_FOOD" }], "hanya kode MB dari nama PERSIS; P1/P2/UR (longgar) tetap komentar");
        assert.equal((await lap.pool.query(`SELECT count(*)::int AS n FROM principal_alias WHERE alias_norm LIKE '%PTMIX%'`)).rows[0].n, 0);
        assert.equal((await lap.pool.query(`SELECT count(*)::int AS n FROM principal_variant WHERE variant_key = ''`)).rows[0].n, 0, "tanpa varian dasar");

        // Laporan ulang sesudah benih: tidak ada usulan principal/varian baru, tanpa konflik.
        const folder2 = path.join(folder, "ulang");
        await skrip.jalankan({ url, keluar: folder2 });
        const benih2 = await readFile(path.join(folder2, "benih.sql"), "utf8");
        assert.match(benih2, /-- 1\. Principal \(0 baru\)\./);
        assert.match(benih2, /-- 2\. Varian \(0 baru;/);
        assert.doesNotMatch(await readFile(path.join(folder2, "laporan.md"), "utf8"), /KONFLIK registri/);

        // Benih menolak berjalan tanpa penjaga (skema tanpa DDL_S7_2) dan tidak menyisipkan apa pun.
        const tanpa = await skemaBaru("s70");
        await tanpa.pool.query((await import(new URL("../scripts/migrate-pg.mjs", import.meta.url).href)).migrations.find((x: { nama: string }) => x.nama === "principal_log").sql);
        const c = await tanpa.pool.connect();
        try {
            await assert.rejects(c.query(benih), /trg_principal_log_append_only tidak terpasang persis/);
        } finally {
            await c.query("ROLLBACK");
            c.release();
        }
        assert.equal(await hitungDi(tanpa.pool, "principal"), 0);

        // CLI: keluar 2 (ada sumber GAGAL), URL/sandi tidak pernah tercetak.
        const cli = spawnSync(process.execPath, ["--import", "tsx", "scripts/principal-laporan.mjs", "--keluar", path.join(folder, "cli")], {
            cwd: new URL("..", import.meta.url), env: { ...process.env, DATABASE_URL: url }, encoding: "utf8", timeout: 120_000,
        });
        assert.equal(cli.status, 2, cli.stderr);
        const sandi = decodeURIComponent(new URL(PG_URL).password);
        assert.ok(sandi && !cli.stdout.includes(sandi) && !cli.stderr.includes(sandi), "sandi tidak tercetak");
        assert.match(cli.stdout, /claim_workflow — kode Klaim: GAGAL/);
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
});

async function hitungDi(pool: Pool, tabel: string) {
    return Number((await pool.query(`SELECT count(*) AS n FROM ${tabel}`)).rows[0].n);
}
