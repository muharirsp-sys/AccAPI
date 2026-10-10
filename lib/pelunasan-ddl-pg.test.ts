/* S6e-2: DDL manual docs/handover/DDL_S6E2.sql + entri migrate-pg `idempotency_s6e2` di Postgres EVALUASI (AM040_DATABASE_URL,
 * bukan produksi). Berkas dijalankan DUA kali (idempoten), VERIFIKASI semua ok, jejak Selesaikan tidak bisa diubah/dihapus,
 * CHECK menolak alasan pendek / terposting tanpa nomor. Baris uji dibuat di dalam transaksi yang di-ROLLBACK. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";

test("PG: DDL_S6E2.sql idempoten (dua kali) + entri migrate-pg; jejak append-only; CHECK", { skip: pgSkip }, async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 2 });
    try {
        const ddl = await readFile(new URL("../docs/handover/DDL_S6E2.sql", import.meta.url), "utf8");
        const jalankan = async () => {
            const hasil = await pool.query(ddl) as unknown as { rows: { cek: string; ok: boolean | null }[] }[];
            return hasil[hasil.length - 1].rows;
        };
        for (const v of [...await jalankan(), ...await jalankan()]) assert.notEqual(v.ok, false, `VERIFIKASI gagal: ${v.cek}`);
        const mod = await import(new URL("../scripts/migrate-pg.mjs", import.meta.url).href) as { migrations: { nama: string; sudahAda: string; sql: string }[] };
        const m = mod.migrations.find((x) => x.nama === "idempotency_s6e2");
        assert.ok(m, "entri migrate-pg idempotency_s6e2");
        assert.equal((await pool.query(m.sudahAda)).rowCount, 1, "sudahAda mengenali hasil DDL");
        await pool.query(m.sql); // sesudah DDL manual: tetap aman diulang

        const c = await pool.connect();
        try {
            await c.query("BEGIN");
            const ins = (decision: string, reason: string, nomor: string | null) => c.query(
                `INSERT INTO idempotency_resolution (id, key, previous_status, decision, accurate_number, database_id, checked_source, reason, actor)
                 VALUES (gen_random_uuid()::text, 'UJI-S6E2-DDL', 'UNKNOWN', $1, $2, 'DB-1', 'accurate:list.do', $3, 'uji')`, [decision, nomor, reason]);
            await ins("terposting", "Ditemukan PR.1 di Accurate saat dicek", "PR.1");
            for (const [sql, pola] of [
                ["UPDATE idempotency_resolution SET reason = reason || '!' WHERE key = 'UJI-S6E2-DDL'", /append-only/],
                ["DELETE FROM idempotency_resolution WHERE key = 'UJI-S6E2-DDL'", /append-only/],
            ] as const) {
                await c.query("SAVEPOINT s");
                await assert.rejects(c.query(sql), pola);
                await c.query("ROLLBACK TO SAVEPOINT s");
            }
            for (const [d, alasan, nomor] of [["terposting", "Ditemukan di Accurate saat dicek", null], ["tidak_ada", "pendek", null], ["salah", "Alasan yang cukup panjang sekali", null]] as const) {
                await c.query("SAVEPOINT s");
                await assert.rejects(ins(d, alasan, nomor), /violates check constraint/);
                await c.query("ROLLBACK TO SAVEPOINT s");
            }
        } finally {
            await c.query("ROLLBACK");
            c.release();
        }
    } finally {
        await pool.end();
    }
});
