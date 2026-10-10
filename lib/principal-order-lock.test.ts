/* BL-21 (S6d lanjutan): Hapus/Ganti batch Order Principal vs Antrekan yang BERSAMAAN — kunci baris principal_order_batch.
 * Postgres EVALUASI (AM-040, bukan produksi) lewat AM040_DATABASE_URL; tanpa env itu dilewati dengan sebabnya. Tanpa Accurate.
 * Urutan antar-transaksi dibuat pasti dengan klien "penahan" + pg_blocking_pids (bukan sleep):
 *   A. hapus memegang kunci batch duluan -> antrekan menunggu, lalu melihat batch sudah tidak ada: tidak ada baris antrean.
 *   B. antrekan memegang kunci batch duluan -> DELETE route menunggu, lalu melihat baris antreannya: 409, batch utuh.
 * Penjaga statik urutannya: lib/route-lock-order.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { invoiceKey } from "./principal-invoice.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";

/** Tunggu sampai ada backend yang tertahan (langsung atau lewat satu perantara) oleh `pid`; false = `selesai` duluan / 10 dtk. */
async function tertahanOleh(pool: Pool, pid: number, selesai: Promise<unknown>, lapis: 1 | 2) {
    let beres = false;
    void selesai.finally(() => { beres = true; });
    const sql = lapis === 1
        ? "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))"
        : `SELECT count(*)::int AS n FROM pg_stat_activity a, LATERAL unnest(pg_blocking_pids(a.pid)) AS b(pid)
           WHERE $1 = ANY(pg_blocking_pids(b.pid))`;
    for (let i = 0; i < 200 && !beres; i++) {
        if ((await pool.query(sql, [pid])).rows[0].n > 0) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    return false;
}

test("PG BL-21: hapus/ganti vs antrekan bersamaan — yang kedua menunggu; tak ada batch terhapus sementara SO-nya diantrekan", { skip: pgSkip }, async () => {
    Object.assign(process.env, { DATABASE_URL: PG_URL, NODE_ENV: "development", LOCAL_AUTH_BYPASS: "true" });
    const { pool: poolRoute } = await import("./db.ts");
    const { antrekan } = await import("./invoice-outbox-actions.ts");
    const { DELETE: hapus } = await import("../app/api/principal-order/route.ts");
    const { NextRequest } = await import("next/server");
    const pool = new Pool({ connectionString: PG_URL, max: 4 });
    const pg = drizzle(pool);
    const tag = randomUUID().slice(0, 8);
    const principal = `UJI-LOCK-${tag}`;
    const batchA = `bl21-a-${tag}`, batchB = `bl21-b-${tag}`;
    const keyA = invoiceKey(principal, `SO-A-${tag}`), keyB = invoiceKey(principal, `SO-B-${tag}`);
    const seed = async (batchId: string, soNo: string) => {
        await pool.query(`INSERT INTO principal_order_batch (id, principal, file_name, file_hash) VALUES ($1, $2, 'uji.xlsx', $1)`, [batchId, principal]);
        await pool.query(`INSERT INTO principal_order_line (batch_id, row_number, so_no) VALUES ($1, 1, $2)`, [batchId, soNo]);
    };
    const calon = (orderId: string) => ({ orderId, customerNo: "C-UJI-LOCK", orderDate: "2026-10-10", payload: { charField1: orderId, detailItem: [] } });
    const ada = async (sql: string, id: string) => (await pool.query(sql, [id])).rowCount ?? 0;
    const penahan: PoolClient = await pool.connect();
    const pidPenahan = (await penahan.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    try {
        await seed(batchA, `SO-A-${tag}`);
        await seed(batchB, `SO-B-${tag}`);

        // A. Hapus duluan: penahan = transaksi hapus yang sudah memegang FOR UPDATE.
        await penahan.query("BEGIN");
        await penahan.query("SELECT id FROM principal_order_batch WHERE id = $1 FOR UPDATE", [batchA]);
        const antreA = antrekan(pg, { entries: [calon(keyA)], actor: "uji-lock", targetDb: "", cari: null, batchId: batchA });
        const antreMenunggu = await tertahanOleh(pool, pidPenahan, antreA, 1);
        await penahan.query("DELETE FROM principal_order_batch WHERE id = $1", [batchA]);
        await penahan.query("COMMIT");
        const hasilA = await antreA;
        assert.deepEqual(hasilA.queued, [], "A: SO dari batch yang terhapus tetap diantrekan");
        assert.match(hasilA.blocked[0]?.reason ?? "", /sudah dihapus atau diganti/);
        assert.equal(await ada("SELECT 1 FROM invoice_outbox WHERE order_id = $1", keyA), 0, "A: baris antrean tertulis untuk batch terhapus");
        assert.ok(antreMenunggu, "A: antrekan tidak menunggu kunci batch hapus");

        // B. Antre duluan: penahan menyisipkan kunci antrean yang sama (belum commit) -> antrekan berhenti DI DALAM transaksinya,
        //    sesudah mengunci batch. DELETE route lalu harus menunggu, bukan memeriksa antrean kosong dan menghapus.
        await penahan.query("BEGIN");
        await penahan.query(`INSERT INTO invoice_outbox (order_id, customer_no, order_date, payload) VALUES ($1, 'C-UJI-LOCK', '2026-10-10', '{}'::jsonb)`, [keyB]);
        const antreB = antrekan(pg, { entries: [calon(keyB)], actor: "uji-lock", targetDb: "", cari: null, batchId: batchB });
        assert.ok(await tertahanOleh(pool, pidPenahan, antreB, 1), "B: antrekan tidak tertahan penahan");
        const hapusB = hapus(new NextRequest(`http://localhost/api/principal-order?id=${batchB}`, { method: "DELETE", headers: { host: "localhost" } }));
        const hapusMenunggu = await tertahanOleh(pool, pidPenahan, hapusB, 2);
        await penahan.query("ROLLBACK");
        const [hasilB, jawabB] = await Promise.all([antreB, hapusB]);
        assert.deepEqual(hasilB.queued, [keyB]);
        assert.equal(await ada("SELECT 1 FROM principal_order_batch WHERE id = $1", batchB), 1, "B: batch terhapus padahal SO-nya diantrekan");
        assert.equal(jawabB.status, 409, `B: DELETE menjawab ${jawabB.status} ${JSON.stringify(await jawabB.clone().json())}`);
        assert.match(String((await jawabB.json()).error), /sudah di Antrean Faktur/);
        assert.ok(hapusMenunggu, "B: DELETE tidak menunggu antrekan yang sedang berjalan");
    } finally {
        await penahan.query("ROLLBACK").catch(() => undefined);
        penahan.release();
        await pool.query("DELETE FROM invoice_outbox WHERE order_id = ANY($1)", [[keyA, keyB]]).catch(() => undefined);
        await pool.query("DELETE FROM principal_order_line WHERE batch_id = ANY($1)", [[batchA, batchB]]).catch(() => undefined);
        await pool.query("DELETE FROM principal_order_batch WHERE id = ANY($1)", [[batchA, batchB]]).catch(() => undefined);
        await pool.end();
        await poolRoute.end();
    }
});
