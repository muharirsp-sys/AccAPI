/* S7-1c dengan Postgres EVALUASI (AM040_DATABASE_URL, BUKAN produksi): RBAC_S7_1C_KUNCI.sql dijalankan apa adanya lewat klien pg di
 * SKEMA sekali-pakai (pola s7-1b-pg.test.ts) — data DB bersama tidak tersentuh. PK-2 (owner 12 Okt): tegakkan = kunci lama ∧ kunci baru,
 * maka SQL memberi kunci baru ke SETIAP grup pemegang kunci lamanya. Mode cek = 0 perubahan; terapkan = hanya pemegang kunci lama
 * bertambah, satu audit per grup berubah, VERIFIKASI 0; jalan kedua 0. Tanpa env dilewati dengan sebabnya. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { isValidPermissionKey } from "./registry.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";
const SQL = readFileSync(new URL("../../docs/handover/RBAC_S7_1C_KUNCI.sql", import.meta.url), "utf8");

/** Kunci lama -> kunci baru (brief S7-1c; summary.export: gerbang lama require_user = summary.view). */
const PASANGAN: Array<[string, string[]]> = [
    ["finance.update", ["finance.post_accurate", "finance.upload_proof", "finance.transfer"]],
    ["finance.view", ["finance.export"]],
    ["payments.edit", ["payments.create", "payments.upload", "payments.submit", "sppd.generate"]],
    ["payments.view", ["payments.export"]],
    ["summary.edit", ["summary.upload", "summary.generate", "summary.email"]],
    ["summary.view", ["summary.export"]],
];

const SKEMA = `
    CREATE TABLE access_group (id text PRIMARY KEY, name text NOT NULL UNIQUE, description text, is_preset boolean NOT NULL DEFAULT false,
        created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
    CREATE TABLE group_permission (group_id text NOT NULL REFERENCES access_group(id), permission_key text NOT NULL, PRIMARY KEY (group_id, permission_key));
    CREATE TABLE permission_audit_log (id text PRIMARY KEY, actor_user_id text, actor_name text, action text NOT NULL, target_user_id text,
        target_group_id text, detail jsonb, created_at timestamp NOT NULL);`;

const SEMUA_BARU = PASANGAN.flatMap(([, b]) => b);
const DATA = `
    INSERT INTO access_group (id, name, is_preset) VALUES ('g-mgr', 'Manager', true), ('g-staff', 'Staff', true), ('g-fin', 'Finance', true),
        ('g-lihat', 'Lihat Summary', false), ('g-kosong', 'Tanpa Kunci', false), ('g-adm', 'Admin', true);
    INSERT INTO group_permission VALUES
        ('g-mgr', 'finance.update'), ('g-mgr', 'finance.view'), ('g-mgr', 'payments.edit'), ('g-mgr', 'payments.view'), ('g-mgr', 'summary.view'),
        ('g-mgr', 'finance.post_accurate'),
        ('g-staff', 'payments.edit'), ('g-staff', 'payments.view'), ('g-staff', 'summary.edit'), ('g-staff', 'summary.view'), ('g-staff', 'payments.create'),
        ('g-fin', 'finance.view'), ('g-fin', 'finance.update'), ('g-fin', 'finance.export'), ('g-fin', 'finance.resolve_unknown'),
        ('g-lihat', 'summary.view'),
        ('g-kosong', 'dashboard.view'), ('g-kosong', 'payments.update'), ('g-kosong', 'payments.delete'),
        ${PASANGAN.flatMap(([l, b]) => [l, ...b]).map((k) => `('g-adm', '${k}')`).join(", ")};`;

type Hasil = { rows: Record<string, unknown>[] };

async function denganSkema(fn: (pool: pg.Pool) => Promise<void>) {
    const skema = `uji_s71c_${randomUUID().slice(0, 8)}`;
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

/** Jalankan berkas apa adanya. Mode cek: galat "MODE CEK" ditangkap, koneksi di-ROLLBACK. */
async function jalan(pool: pg.Pool, terapkan: boolean, sql = SQL) {
    const c = await pool.connect();
    const notice: string[] = [];
    c.on("notice", (n) => notice.push(String(n.message)));
    try {
        if (terapkan) await c.query("SET rbac.terapkan = '1'");
        try {
            return { hasil: await c.query(sql) as unknown as Hasil[], notice, galat: null as string | null };
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

test("RBAC_S7_1C_KUNCI.sql statik: pasangan = brief, semua kunci terdaftar, hanya INSERT, tanpa api_wrapper", () => {
    for (const [l, b] of PASANGAN) for (const k of [l, ...b]) assert.ok(isValidPermissionKey(k), k);
    const aktif = SQL.replace(/--.*$/gm, "");
    const pasanganSql = (potong: string) => [...potong.matchAll(/\('([a-z_]+\.[a-z_]+)',\s*'([a-z_]+\.[a-z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
    const harap = PASANGAN.flatMap(([l, b]) => b.map((k) => `${l}>${k}`)).sort();
    const verif = aktif.indexOf("SELECT 'VERIFIKASI'");
    assert.ok(verif > 0, "bagian VERIFIKASI ada");
    assert.deepEqual(pasanganSql(aktif.slice(0, verif)), harap, "pasangan bagian tulis = brief");
    const jaga = aktif.indexOf("DO $$", verif);
    const modeCek = aktif.indexOf("DO $$", jaga + 1);
    assert.ok(jaga > verif && modeCek > jaga, "penjaga VERIFIKASI (DO) ada sebelum penjaga mode cek");
    assert.deepEqual(pasanganSql(aktif.slice(verif, jaga)), harap, "pasangan VERIFIKASI = brief");
    assert.deepEqual(pasanganSql(aktif.slice(jaga, modeCek)), harap, "pasangan penjaga VERIFIKASI = brief");
    assert.match(aktif.slice(jaga, modeCek), /RAISE EXCEPTION 'S7-1c VERIFIKASI GAGAL/);
    assert.doesNotMatch(aktif, /api_wrapper/);
    assert.doesNotMatch(aktif, /\b(DELETE\s+FROM|UPDATE\s+"?\w+"?\s+SET)\b|(^|;)\s*(TRUNCATE|ALTER|DROP|CREATE)\b/im, "data saja, hanya INSERT");
});

test("RBAC_S7_1C_KUNCI.sql: VERIFIKASI ≠ 0 = RAISE (ROLLBACK) walau mode terapkan — tidak ada COMMIT setengah benar", { skip: pgSkip }, async () => {
    await denganSkema(async (pool) => {
        const sebelum = await keadaan(pool);
        // Bagian tulis (DO pertama) dibuang -> pemegang kunci lama tetap tanpa kunci baru -> penjaga harus menggagalkan.
        const tanpaTulis = SQL.replace(/DO \$\$[\s\S]*?END \$\$;/, "");
        assert.notEqual(tanpaTulis, SQL);
        const r = await jalan(pool, true, tanpaTulis);
        assert.match(String(r.galat), /S7-1c VERIFIKASI GAGAL: 21 /);
        assert.deepEqual(await keadaan(pool), sebelum, "tidak ada yang tersimpan");
    });
});

test("RBAC_S7_1C_KUNCI.sql: mode cek 0 perubahan; terapkan = hanya pemegang kunci lama; audit per grup; VERIFIKASI 0; jalan kedua 0", { skip: pgSkip }, async () => {
    await denganSkema(async (pool) => {
        const sebelum = await keadaan(pool);
        const cek = await jalan(pool, false);
        assert.match(String(cek.galat), /S7-1c MODE CEK/);
        assert.ok(cek.notice.some((n) => /izin_disisipkan=21 audit=4$/.test(n)), `ringkasan tercetak: ${cek.notice.join(" | ")}`);
        assert.deepEqual(await keadaan(pool), sebelum, "mode cek = 0 perubahan");

        const r1 = await jalan(pool, true);
        assert.equal(r1.galat, null);
        assert.ok(r1.notice.some((n) => /izin_disisipkan=21 audit=4$/.test(n)), r1.notice.join(" | "));
        const lama = (g: string) => sebelum.izin.filter((k) => k.startsWith(`${g}:`)).map((k) => k.slice(g.length + 1));
        const tambah: Record<string, string[]> = {
            "g-mgr": ["finance.upload_proof", "finance.transfer", "finance.export", "payments.create", "payments.upload", "payments.submit", "sppd.generate", "payments.export", "summary.export"],
            "g-staff": ["payments.upload", "payments.submit", "sppd.generate", "payments.export", "summary.upload", "summary.generate", "summary.email", "summary.export"],
            "g-fin": ["finance.post_accurate", "finance.upload_proof", "finance.transfer"],
            "g-lihat": ["summary.export"],
        };
        for (const g of ["g-mgr", "g-staff", "g-fin", "g-lihat", "g-kosong", "g-adm"]) {
            assert.deepEqual(await kunciGrup(pool, g), [...lama(g), ...(tambah[g] ?? [])].sort(), g);
        }
        const audit = (await pool.query(`SELECT action, actor_name, target_group_id, detail FROM permission_audit_log ORDER BY target_group_id`)).rows;
        assert.deepEqual(audit, Object.keys(tambah).sort().map((g) => ({
            action: "group_permission.sync", actor_name: "SQL RBAC_S7_1C_KUNCI", target_group_id: g,
            detail: { added: [...tambah[g]].sort(), removed: [], sumber: "docs/handover/RBAC_S7_1C_KUNCI.sql" },
        })));
        const verif = r1.hasil.flatMap((h) => h.rows).filter((x) => x.bagian === "VERIFIKASI");
        assert.equal(verif.length, SEMUA_BARU.length);
        assert.deepEqual(verif.filter((x) => x.nilai !== "0"), [], "setiap pemegang kunci lama memegang kunci barunya");

        const sesudah = await keadaan(pool);
        const r2 = await jalan(pool, true);
        assert.ok(r2.notice.some((n) => /izin_disisipkan=0 audit=0$/.test(n)), r2.notice.join(" | "));
        assert.deepEqual(await keadaan(pool), sesudah, "idempoten");
    });
});
