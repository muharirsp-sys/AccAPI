/* BL-21 (S6d lanjutan): Hapus/Ganti batch Order Principal vs Antrekan / Validasi yang BERSAMAAN — kunci baris principal_order_batch.
 * Postgres EVALUASI (AM-040, bukan produksi) lewat AM040_DATABASE_URL; tanpa env itu dilewati dengan sebabnya. Tanpa Accurate.
 * principal_order_batch/line dibuat di SKEMA SEKALI-PAKAI (search_path skema itu lalu public, di-DROP di akhir) persis seperti
 * migrasi 0008 produksi: FK line -> batch ON DELETE CASCADE + indeks unik (principal, file_hash). DB am040_s6 (drizzle push) tidak
 * punya keduanya, padahal CASCADE itulah yang membuat Hapus mengunci baris line — tanpa FK, deadlock Validasi tidak terlihat.
 * Urutan antar-transaksi dibuat pasti dengan klien "penahan" + pg_blocking_pids (bukan sleep):
 *   A. hapus memegang kunci batch duluan -> antrekan menunggu, lalu melihat batch sudah tidak ada: tidak ada baris antrean.
 *   B. antrekan memegang kunci batch duluan -> DELETE route menunggu, lalu melihat baris antreannya: 409, batch utuh.
 *   V1. hapus memegang kunci batch duluan -> Validasi menunggu SEBELUM menyentuh baris line; hapus (CASCADE) lolos, Validasi 409.
 *       Kode lama (line dulu, batch belakangan) = siklus: 40P01.
 *   V2. Validasi memegang kunci batch duluan -> DELETE route menunggu, lalu menghapus sesudah Validasi commit; keduanya 200.
 * Penjaga statik urutannya: lib/route-lock-order.test.ts. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { invoiceKey } from "./principal-invoice.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";
const SKEMA = `uji_bl21_${randomUUID().slice(0, 8)}`;
/** Koneksi uji DAN route: nama tabel tanpa skema -> skema sekali-pakai dulu (batch/line), sisanya public. */
const URL_UJI = PG_URL ? (() => {
    const url = new URL(PG_URL);
    url.searchParams.set("options", `-c search_path=${SKEMA},public`);
    return url.toString();
})() : "";
if (PG_URL) Object.assign(process.env, { DATABASE_URL: URL_UJI, NODE_ENV: "development", LOCAL_AUTH_BYPASS: "true" });

const pool = new Pool({ connectionString: URL_UJI || undefined, max: 4 });
const pg = drizzle(pool);
const tag = randomUUID().slice(0, 8);
const principal = `UJI-LOCK-${tag}`;
const kunciDibuat: string[] = [];

before(async () => {
    if (!PG_URL) return;
    await pool.query(`CREATE SCHEMA ${SKEMA}`);
    await pool.query(`CREATE TABLE ${SKEMA}.principal_order_batch (LIKE public.principal_order_batch INCLUDING ALL)`);
    await pool.query(`CREATE UNIQUE INDEX ON ${SKEMA}.principal_order_batch (principal, file_hash)`);
    await pool.query(`CREATE TABLE ${SKEMA}.principal_order_line (LIKE public.principal_order_line INCLUDING ALL)`);
    await pool.query(`ALTER TABLE ${SKEMA}.principal_order_line ADD FOREIGN KEY (batch_id)
        REFERENCES ${SKEMA}.principal_order_batch (id) ON DELETE CASCADE`);
});

after(async () => {
    if (PG_URL) {
        await pool.query("DELETE FROM invoice_outbox_event WHERE order_id = ANY($1)", [kunciDibuat]).catch(() => undefined);
        await pool.query("DELETE FROM invoice_outbox WHERE order_id = ANY($1)", [kunciDibuat]).catch(() => undefined);
        await pool.query(`DROP SCHEMA IF EXISTS ${SKEMA} CASCADE`);
        const { pool: poolRoute } = await import("./db.ts");
        await poolRoute.end();
    }
    await pool.end();
});

/** Tunggu sampai ada backend yang tertahan (langsung atau lewat satu perantara) oleh `pid`; false = `selesai` duluan / 10 dtk. */
async function tertahanOleh(pid: number, selesai: Promise<unknown>, lapis: 1 | 2) {
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

const seed = async (batchId: string, soNo: string, baris = 1) => {
    await pool.query(`INSERT INTO principal_order_batch (id, principal, file_name, file_hash) VALUES ($1, $2, 'uji.xlsx', $1)`, [batchId, principal]);
    for (let row = 1; row <= baris; row++) {
        await pool.query(`INSERT INTO principal_order_line (batch_id, row_number, so_no) VALUES ($1, $2, $3)`, [batchId, row, soNo]);
    }
};
const calon = (orderId: string) => {
    kunciDibuat.push(orderId);
    return { orderId, customerNo: "C-UJI-LOCK", orderDate: "2026-10-10", payload: { charField1: orderId, detailItem: [] } };
};
const ada = async (sql: string, id: string) => (await pool.query(sql, [id])).rowCount ?? 0;
/** Kode SQLSTATE dari galat pg / pembungkus drizzle; undefined bila bukan galat. */
const kodePg = (hasil: unknown) => hasil instanceof Error
    ? String((hasil as { code?: string }).code ?? (hasil as { cause?: { code?: string } }).cause?.code ?? hasil.message)
    : undefined;
const tanpaLempar = <T,>(p: Promise<T>) => p.then((r) => r, (e: unknown) => (e instanceof Error ? e : new Error(String(e))));

async function penahanBaru() {
    const client: PoolClient = await pool.connect();
    const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    return { client, pid };
}

async function route() {
    const { antrekan } = await import("./invoice-outbox-actions.ts");
    const { DELETE: hapus } = await import("../app/api/principal-order/route.ts");
    const { POST: validasi } = await import("../app/api/principal-order/validate/route.ts");
    const { NextRequest } = await import("next/server");
    const req = (path: string, method: string) => new NextRequest(`http://localhost${path}`, { method, headers: { host: "localhost" } });
    return {
        antrekan,
        hapus: (id: string) => hapus(req(`/api/principal-order?id=${id}`, "DELETE")),
        validasi: (id: string) => validasi(req(`/api/principal-order/validate?id=${id}`, "POST")),
    };
}

test("PG BL-21: hapus/ganti vs antrekan bersamaan — yang kedua menunggu; tak ada batch terhapus sementara SO-nya diantrekan", { skip: pgSkip }, async () => {
    const { antrekan, hapus } = await route();
    const batchA = `bl21-a-${tag}`, batchB = `bl21-b-${tag}`;
    const keyA = invoiceKey(principal, `SO-A-${tag}`), keyB = invoiceKey(principal, `SO-B-${tag}`);
    const { client: penahan, pid: pidPenahan } = await penahanBaru();
    try {
        await seed(batchA, `SO-A-${tag}`);
        await seed(batchB, `SO-B-${tag}`);

        // A. Hapus duluan: penahan = transaksi hapus yang sudah memegang FOR UPDATE.
        await penahan.query("BEGIN");
        await penahan.query("SELECT id FROM principal_order_batch WHERE id = $1 FOR UPDATE", [batchA]);
        const antreA = antrekan(pg, { entries: [calon(keyA)], actor: "uji-lock", targetDb: "", cari: null, batchId: batchA });
        const antreMenunggu = await tertahanOleh(pidPenahan, antreA, 1);
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
        assert.ok(await tertahanOleh(pidPenahan, antreB, 1), "B: antrekan tidak tertahan penahan");
        const hapusB = hapus(batchB);
        const hapusMenunggu = await tertahanOleh(pidPenahan, hapusB, 2);
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
    }
});

test("PG BL-21: Validasi vs Hapus bersamaan — tanpa deadlock 40P01 (FK CASCADE line -> batch seperti migrasi 0008)", { skip: pgSkip }, async () => {
    const { hapus, validasi } = await route();
    const batchV1 = `bl21-v1-${tag}`, batchV2 = `bl21-v2-${tag}`;
    const { client: penahan, pid: pidPenahan } = await penahanBaru();
    try {
        await seed(batchV1, `SO-V1-${tag}`, 3);
        await seed(batchV2, `SO-V2-${tag}`, 3);

        // V1. Hapus duluan (penahan = transaksi DELETE route sesudah kunciBatch "update"): Validasi harus menunggu SEBELUM
        //     mengubah baris line. Kode lama mengubah line dulu lalu menunggu di UPDATE batch; DELETE ... CASCADE lalu menunggu
        //     line milik Validasi = siklus -> 40P01 (deadlock_timeout) di salah satunya.
        await penahan.query("BEGIN");
        await penahan.query("SELECT id FROM principal_order_batch WHERE id = $1 FOR UPDATE", [batchV1]);
        const v1 = tanpaLempar(validasi(batchV1));
        const v1Menunggu = await tertahanOleh(pidPenahan, v1, 1);
        const hapusV1 = await tanpaLempar(penahan.query("DELETE FROM principal_order_batch WHERE id = $1", [batchV1]));
        await penahan.query(hapusV1 instanceof Error ? "ROLLBACK" : "COMMIT");
        const jawabV1 = await v1;
        assert.equal(kodePg(hapusV1), undefined, `V1: DELETE batch (CASCADE line) gagal: ${kodePg(hapusV1)}`);
        assert.ok(!(jawabV1 instanceof Error), `V1: Validasi gagal: ${kodePg(jawabV1)}`);
        assert.ok(v1Menunggu, "V1: Validasi tidak menunggu kunci batch hapus");
        assert.equal(jawabV1.status, 409, `V1: Validasi menjawab ${jawabV1.status}`);
        assert.match(String((await jawabV1.json()).error), /dihapus atau diganti/);
        assert.equal(await ada("SELECT 1 FROM principal_order_line WHERE batch_id = $1", batchV1), 0, "V1: CASCADE tidak menghapus baris line");

        // V2. Validasi duluan: penahan mengunci baris line #1 sehingga Validasi berhenti DI DALAM transaksinya (sesudah kunci
        //     batch). DELETE route harus menunggu Validasi (lapis 2), lalu menghapus sesudah Validasi commit — bukan deadlock.
        await penahan.query("BEGIN");
        await penahan.query("SELECT 1 FROM principal_order_line WHERE batch_id = $1 AND row_number = 1 FOR UPDATE", [batchV2]);
        const v2 = tanpaLempar(validasi(batchV2));
        assert.ok(await tertahanOleh(pidPenahan, v2, 1), "V2: Validasi tidak tertahan penahan");
        const hapusV2 = tanpaLempar(hapus(batchV2));
        const hapusMenunggu = await tertahanOleh(pidPenahan, hapusV2, 2);
        await penahan.query("ROLLBACK");
        const [jawabV2, jawabHapus] = await Promise.all([v2, hapusV2]);
        assert.ok(!(jawabV2 instanceof Error), `V2: Validasi gagal: ${kodePg(jawabV2)}`);
        assert.ok(!(jawabHapus instanceof Error), `V2: DELETE gagal: ${kodePg(jawabHapus)}`);
        assert.equal(jawabV2.status, 200, `V2: Validasi menjawab ${jawabV2.status}`);
        assert.deepEqual(await jawabHapus.json(), { ok: true, removed: 1 });
        assert.ok(hapusMenunggu, "V2: DELETE tidak menunggu Validasi yang sedang menulis");
        assert.equal(await ada("SELECT 1 FROM principal_order_line WHERE batch_id = $1", batchV2), 0, "V2: baris line tersisa");
    } finally {
        await penahan.query("ROLLBACK").catch(() => undefined);
        penahan.release();
    }
});
