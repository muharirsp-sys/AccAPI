/* S7-1b butir 7 dengan Postgres EVALUASI (AM040_DATABASE_URL, BUKAN produksi): RBAC_S7_1B_CEK/KUNCI/PENSIUN.sql dijalankan apa adanya
 * lewat klien pg di SKEMA sekali-pakai (CREATE SCHEMA uji_s71b_* + search_path; pola lib/kasir/skema-pg.test.ts) — data DB bersama tidak
 * tersentuh. Mode cek = 0 perubahan; terapkan (SET rbac.terapkan = '1') = hanya pemegang kunci lama bertambah, audit satu baris per grup
 * berubah, jalan kedua 0; PENSIUN menghapus persis KUNCI_PENSIUN; CEK menolak tulisan (READ ONLY). Tanpa env dilewati dengan sebabnya. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { KUNCI_PENSIUN } from "./registry.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";
const berkas = (nama: string) => readFileSync(new URL(`../../docs/handover/${nama}`, import.meta.url), "utf8");

const SKEMA = `
    CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, role text, banned boolean DEFAULT false);
    CREATE TABLE access_group (id text PRIMARY KEY, name text NOT NULL UNIQUE, description text, is_preset boolean NOT NULL DEFAULT false,
        created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
    CREATE TABLE group_permission (group_id text NOT NULL REFERENCES access_group(id), permission_key text NOT NULL, PRIMARY KEY (group_id, permission_key));
    CREATE TABLE user_group (user_id text NOT NULL REFERENCES "user"(id), group_id text NOT NULL REFERENCES access_group(id), assigned_at timestamp NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, group_id));
    CREATE TABLE permission_audit_log (id text PRIMARY KEY, actor_user_id text, actor_name text, action text NOT NULL, target_user_id text,
        target_group_id text, detail jsonb, created_at timestamp NOT NULL);`;

const DATA = `
    INSERT INTO access_group (id, name, is_preset) VALUES ('g-mgr', 'Manager', true), ('g-claim', 'Claim', true), ('g-konsol', 'Konsol Baca', false),
        ('g-fin', 'Finance', true), ('g-adm', 'Admin', true), ('g-kosong', 'Tanpa Kunci', false);
    INSERT INTO group_permission VALUES
        ('g-mgr', 'off_program_control.view'), ('g-mgr', 'off_program_control.approve'), ('g-mgr', 'off_program_control.export'), ('g-mgr', 'api_wrapper.view'),
        ('g-mgr', 'api_wrapper.execute'), ('g-mgr', 'finance.update'),
        ('g-claim', 'off_program_control.audit_read'), ('g-claim', 'off_program_control.update'), ('g-claim', 'off_program_control.create'),
        ('g-konsol', 'api_wrapper.view'), ('g-konsol', 'users.create_user'), ('g-konsol', 'users.set_permission'),
        ('g-fin', 'finance.view'), ('g-fin', 'off_program_control.update'),
        ('g-adm', 'off_program_control.audit_read'), ('g-adm', 'off_program_control.audit_export'), ('g-adm', 'users.manage');
    INSERT INTO "user" (id, name, email, role, banned) VALUES ('u-mgr', 'Uji Mgr', 'mgr@s71b.test', 'manager', false),
        ('u-konsol', 'Uji Konsol', 'konsol@s71b.test', 'staff', false), ('u-lama', 'Uji Lama', 'lama@s71b.test', 'manager', false),
        ('u-nonaktif', 'Uji Nonaktif', 'nonaktif@s71b.test', 'admin', true);
    INSERT INTO user_group (user_id, group_id) VALUES ('u-mgr', 'g-mgr'), ('u-konsol', 'g-konsol');`;

type Hasil = { fields?: { name: string }[]; rows: Record<string, unknown>[] };

async function denganSkema(fn: (pool: pg.Pool) => Promise<void>) {
    const skema = `uji_s71b_${randomUUID().slice(0, 8)}`;
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${skema}`);
    const url = new URL(PG_URL);
    url.searchParams.set("options", `-c search_path=${skema}`);
    const pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
    try {
        await pool.query(SKEMA);
        await pool.query(DATA);
        await fn(pool);
    } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${skema} CASCADE`);
        await admin.end();
    }
}

/** Jalankan berkas SQL apa adanya. Mode cek: galat "MODE CEK" ditangkap, koneksi di-ROLLBACK. */
async function jalan(pool: pg.Pool, sql: string, terapkan: boolean) {
    const c = await pool.connect();
    const notice: string[] = [];
    c.on("notice", (n) => notice.push(String(n.message)));
    try {
        if (terapkan) await c.query("SET rbac.terapkan = '1'");
        try {
            const hasil = await c.query(sql) as unknown as Hasil[];
            return { hasil, notice, galat: null as string | null };
        } catch (e) {
            await c.query("ROLLBACK");
            return { hasil: [] as Hasil[], notice, galat: e instanceof Error ? e.message : String(e) };
        }
    } finally {
        c.release();
    }
}

const keadaan = async (pool: pg.Pool) => ({
    izin: (await pool.query(`SELECT group_id || ':' || permission_key AS k FROM group_permission ORDER BY 1`)).rows.map((r) => r.k as string),
    audit: Number((await pool.query(`SELECT count(*) AS n FROM permission_audit_log`)).rows[0].n),
});
const kunciGrup = async (pool: pg.Pool, id: string) =>
    (await pool.query(`SELECT permission_key AS k FROM group_permission WHERE group_id = $1 ORDER BY 1`, [id])).rows.map((r) => r.k as string);

test("RBAC_S7_1B_CEK.sql: BEGIN READ ONLY … ROLLBACK, menolak tulisan, 7 bagian berisi data uji, data tidak berubah", { skip: pgSkip }, async () => {
    const sql = berkas("RBAC_S7_1B_CEK.sql");
    const tanpaKomentar = sql.replace(/--.*$/gm, "").trim();
    assert.match(tanpaKomentar, /^BEGIN READ ONLY;/);
    assert.match(tanpaKomentar, /ROLLBACK;$/);
    assert.doesNotMatch(tanpaKomentar, /\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+"?\w+"?\s+SET)\b|(^|;)\s*(COMMIT|TRUNCATE|ALTER|DROP|CREATE)\b/im, "tanpa tulisan");
    assert.doesNotMatch(tanpaKomentar, /is_primary/, "tanpa kolom DDL_S7_0 (aman di image main)");
    await denganSkema(async (pool) => {
        const sebelum = await keadaan(pool);
        const r = await jalan(pool, sql, false);
        assert.equal(r.galat, null);
        const bagian = (awal: string) => r.hasil.filter((h) => String(h.rows[0]?.cek ?? "").startsWith(awal)).flatMap((h) => h.rows);
        assert.deepEqual(bagian("1 ").map((x) => x.grup), ["Admin", "Claim", "Finance", "Konsol Baca", "Manager", "Tanpa Kunci"]);
        assert.equal(bagian("1 ").find((x) => x.grup === "Konsol Baca")!.kunci_dari_31, "users.create_user, users.set_permission");
        assert.deepEqual(bagian("2 ").map((x) => [x.grup, x.nasib_rilis]), [["Konsol Baca", "view tanpa execute: KEHILANGAN tulis Konsol"], ["Manager", "tetap (view + execute)"]]);
        assert.match(String(bagian("2 ")[0].daftar_anggota), /konsol@s71b\.test/);
        assert.deepEqual(bagian("2b").map((x) => x.email), ["konsol@s71b.test"]);
        assert.deepEqual(bagian("3 ").map((x) => [x.email, x.role, x.catatan]), [["lama@s71b.test", "manager", "preset lama: api_wrapper.view + execute"]], "nonaktif tidak ikut");
        assert.deepEqual(bagian("4 ").map((x) => [x.ada, x.audit_read, x.audit_export]), [[true, false, false]]);
        assert.deepEqual(bagian("5 ").map((x) => x.grup), ["Claim", "Finance", "Konsol Baca", "Manager"]);
        const p2 = bagian("6 ").find((x) => String(x.pasangan).startsWith("off_program_control.audit_read"))!;
        assert.deepEqual([p2.slice, p2.akan_diberi, p2.grup_akan_diberi], ["1b", "1", "Claim"]);
        assert.deepEqual(await keadaan(pool), sebelum);
        // Pembungkus READ ONLY benar-benar menolak tulisan (tulisan disisipkan sebelum ROLLBACK).
        const tulis = await jalan(pool, sql.replace(/ROLLBACK;\s*$/, "INSERT INTO access_group (id, name) VALUES ('x', 'x');\nROLLBACK;"), false);
        assert.match(String(tulis.galat), /read-only transaction/);
        assert.deepEqual(await keadaan(pool), sebelum);
    });
});

test("RBAC_S7_1B_KUNCI.sql: mode cek 0 perubahan; terapkan = hanya pemegang audit_read + Manager; api_wrapper.* tidak disentuh (PK-1 = biarkan); audit per grup; jalan kedua 0", { skip: pgSkip }, async () => {
    const sql = berkas("RBAC_S7_1B_KUNCI.sql");
    // PK-1 owner 12 Okt "biarkan": bagian tulis (sebelum VERIFIKASI) tanpa api_wrapper apa pun; sisa berkas hanya membaca.
    const aktif = sql.replace(/--.*$/gm, "");
    assert.doesNotMatch(aktif.slice(0, aktif.indexOf("SELECT 'VERIFIKASI'")), /api_wrapper/, "tidak ada INSERT/DELETE api_wrapper.*");
    assert.match(sql, /PK-1 \(owner 12 Okt[^)]*\): "BIARKAN SEPERTI SEKARANG"/);
    assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /\b(DELETE\s+FROM|UPDATE\s+"?\w+"?\s+SET)\b|(^|;)\s*(TRUNCATE|ALTER|DROP|CREATE)\b/im, "data saja, hanya INSERT");
    await denganSkema(async (pool) => {
        const sebelum = await keadaan(pool);
        const cek = await jalan(pool, sql, false);
        assert.match(String(cek.galat), /S7-1b MODE CEK/);
        assert.ok(cek.notice.some((n) => /izin_disisipkan=3 audit=2/.test(n)), `ringkasan tercetak: ${cek.notice.join(" | ")}`);
        const executeSebelum = (await pool.query(`SELECT group_id FROM group_permission WHERE permission_key LIKE 'api_wrapper.%' ORDER BY 1, permission_key`)).rows;
        assert.deepEqual(await keadaan(pool), sebelum, "mode cek = 0 perubahan");

        const r1 = await jalan(pool, sql, true);
        assert.equal(r1.galat, null);
        assert.ok(r1.notice.some((n) => /izin_disisipkan=3 audit=2$/.test(n)), r1.notice.join(" | "));
        assert.deepEqual(await kunciGrup(pool, "g-claim"), ["off_program_control.audit_export", "off_program_control.audit_read", "off_program_control.create", "off_program_control.update"]);
        assert.deepEqual((await kunciGrup(pool, "g-mgr")).filter((k) => k.includes("audit")), ["off_program_control.audit_export", "off_program_control.audit_read"]);
        // Grup tanpa kunci lama TIDAK mendapat apa pun; Admin sudah lengkap; tidak ada api_wrapper.execute baru.
        for (const g of ["g-konsol", "g-fin", "g-kosong", "g-adm"]) {
            assert.deepEqual(await kunciGrup(pool, g), sebelum.izin.filter((k) => k.startsWith(`${g}:`)).map((k) => k.slice(g.length + 1)), g);
        }
        assert.deepEqual((await pool.query(`SELECT group_id FROM group_permission WHERE permission_key LIKE 'api_wrapper.%' ORDER BY 1, permission_key`)).rows, executeSebelum, "api_wrapper.* tidak berubah");
        const audit = (await pool.query(`SELECT action, target_group_id, detail FROM permission_audit_log ORDER BY target_group_id`)).rows;
        assert.deepEqual(audit, [
            { action: "group_permission.sync", target_group_id: "g-claim", detail: { added: ["off_program_control.audit_export"], removed: [], sumber: "docs/handover/RBAC_S7_1B_KUNCI.sql" } },
            { action: "group_permission.sync", target_group_id: "g-mgr", detail: { added: ["off_program_control.audit_export", "off_program_control.audit_read"], removed: [], sumber: "docs/handover/RBAC_S7_1B_KUNCI.sql" } },
        ]);
        const verif = r1.hasil.flatMap((h) => h.rows).filter((x) => x.bagian === "VERIFIKASI").map((x) => [x.cek, x.nilai]);
        assert.deepEqual(verif, [["audit_read tanpa audit_export", "0"], ["Manager audit_read+audit_export", "true"], ["pemegang api_wrapper.execute (tidak diubah berkas ini)", "Manager"]]);

        const sesudah = await keadaan(pool);
        const r2 = await jalan(pool, sql, true);
        assert.ok(r2.notice.some((n) => /izin_disisipkan=0 audit=0/.test(n)));
        assert.deepEqual(await keadaan(pool), sesudah, "idempoten");
    });
});

test("RBAC_S7_1B_PENSIUN.sql: daftar = KUNCI_PENSIUN; mode cek 0; terapkan menghapus persis kunci itu (S7-3: termasuk approve; kunci lain utuh) + audit removed; jalan kedua 0", { skip: pgSkip }, async () => {
    const sql = berkas("RBAC_S7_1B_PENSIUN.sql");
    const aktif = sql.replace(/--.*$/gm, "");
    const daftar = (potong: string) => [...potong.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]).sort();
    const cte = aktif.slice(aktif.indexOf("pensiun(kunci) AS (VALUES"), aktif.indexOf("hapus AS"));
    const verif = aktif.slice(aktif.indexOf("permission_key IN ("), aktif.indexOf("DO $$"));
    assert.deepEqual(daftar(cte), [...KUNCI_PENSIUN].sort(), "daftar hapus = KUNCI_PENSIUN (S7-3: approve aktif)");
    assert.deepEqual(daftar(verif), [...KUNCI_PENSIUN].sort(), "daftar VERIFIKASI = KUNCI_PENSIUN");
    await denganSkema(async (pool) => {
        const sebelum = await keadaan(pool);
        const cek = await jalan(pool, sql, false);
        assert.match(String(cek.galat), /S7-1b MODE CEK/);
        assert.deepEqual(await keadaan(pool), sebelum, "mode cek = 0 perubahan");

        const r1 = await jalan(pool, sql, true);
        assert.equal(r1.galat, null);
        const ringkas = r1.hasil.find((h) => h.fields?.some((f) => f.name === "izin_dihapus"))!.rows[0];
        assert.deepEqual([Number(ringkas.izin_dihapus), Number(ringkas.audit)], [7, 4]);
        const terhapus = sebelum.izin.filter((k) => !(KUNCI_PENSIUN.has(k.split(":")[1])));
        assert.deepEqual((await keadaan(pool)).izin, terhapus, "hanya KUNCI_PENSIUN yang hilang");
        assert.deepEqual(await kunciGrup(pool, "g-mgr"), ["api_wrapper.execute", "api_wrapper.view", "finance.update", "off_program_control.view"], "S7-3: approve ikut terhapus, kunci lain Manager utuh");
        const audit = (await pool.query(`SELECT target_group_id, detail->'removed' AS removed, detail->'added' AS added FROM permission_audit_log ORDER BY 1`)).rows;
        assert.deepEqual(audit, [
            { target_group_id: "g-claim", removed: ["off_program_control.create", "off_program_control.update"], added: [] },
            { target_group_id: "g-fin", removed: ["off_program_control.update"], added: [] },
            { target_group_id: "g-konsol", removed: ["users.create_user", "users.set_permission"], added: [] },
            { target_group_id: "g-mgr", removed: ["off_program_control.approve", "off_program_control.export"], added: [] },
        ]);
        const sesudah = await keadaan(pool);
        const r2 = await jalan(pool, sql, true);
        const ringkas2 = r2.hasil.find((h) => h.fields?.some((f) => f.name === "izin_dihapus"))!.rows[0];
        assert.deepEqual([Number(ringkas2.izin_dihapus), Number(ringkas2.audit)], [0, 0]);
        assert.deepEqual(await keadaan(pool), sesudah, "idempoten");
    });
});
