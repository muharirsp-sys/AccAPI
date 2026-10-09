/* S6-0d (BL-17 + R6 + penyapu + E5): riwayat antrean faktur append-only.
 * Bagian murni tanpa DB. Bagian Postgres butuh DB EVALUASI (AM-040, bukan produksi) lewat
 * AM040_DATABASE_URL — tabel invoice_outbox dari drizzle push, invoice_outbox_event dibuat dari
 * entri scripts/migrate-pg.mjs yang SAMA PERSIS. Accurate = simulator HTTP lokal berlabel, bukan
 * provider asli. Tanpa env itu bagian Postgres dilewati dengan sebabnya. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { kodeGalat, potongJawaban } from "./invoice-outbox-event.ts";
import { aksiAntrean } from "./invoice-outbox-actions.ts";
import { sendQueuedInvoices } from "./invoice-sender.ts";

test("potongan jawaban ≤ 500 karakter dan kode galat jaringan terbaca", () => {
    assert.equal(potongJawaban("x".repeat(900)).length, 500);
    assert.equal(potongJawaban(null), "");
    assert.equal(kodeGalat(Object.assign(new Error("t"), { name: "TimeoutError" })), "TimeoutError");
    assert.equal(kodeGalat(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })), "TypeError:ECONNRESET");
});

// ---------------------------------------------------------------- Postgres evaluasi (AM-040)
const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";

type Migration = { nama: string; sudahAda: string; sql: string };
async function entriMigrasi(nama: string): Promise<Migration> {
    const mod = await import(new URL("../scripts/migrate-pg.mjs", import.meta.url).href) as { migrations: Migration[] };
    const entry = mod.migrations.find((m) => m.nama === nama);
    assert.ok(entry, `entri migrasi ${nama} tidak ada`);
    return entry;
}

const payload = (orderId: string) => ({
    customerNo: "C-TEST-KN", transDate: "08/10/2026", typeAutoNumber: 7, taxable: true, inclusiveTax: false,
    description: "uji", charField1: orderId, charField2: "",
    detailItem: [{ itemNo: "ITM-1", quantity: 1, unitPrice: 1000, itemUnitId: 100, itemDiscPercent: "", itemCashDiscount: 0,
        detailNotes: "order uji baris 1", charField1: orderId }],
});

async function seed(pool: Pool, orderId: string, state: string, extra: { lastError?: string; accurateId?: string; updatedAgoMin?: number; attempts?: number } = {}) {
    await pool.query(
        `INSERT INTO invoice_outbox (order_id, customer_no, order_date, state, payload, queued_by, accurate_id, last_error, updated_at, attempts)
         VALUES ($1, 'C-TEST-KN', '2026-10-08', $2, $3::jsonb, 'uji@contoh', $4, $5, now() - make_interval(mins => $6), $7)`,
        [orderId, state, JSON.stringify(payload(orderId)), extra.accurateId ?? "", extra.lastError ?? "", extra.updatedAgoMin ?? 0, extra.attempts ?? 0]);
}

const events = async (pool: Pool, orderId: string) =>
    (await pool.query(`SELECT jenis, state_from, state_to, actor, http_status, response_excerpt, error_code, reason, detail
                       FROM invoice_outbox_event WHERE order_id = $1 ORDER BY id`, [orderId])).rows;

type FakturSim = { id: number; number: string; charField1: string; customerId: number; lastUpdate: string };

/**
 * Simulator Accurate berlabel: save.do menghitung kiriman per charField1 dan menjawab sukses
 * beramplop; list.do/detail.do melayani `faktur` (pencarian AM-029); selain itu (pra-cek sesi) sah.
 */
async function simulatorAccurate(delayMs = 100, faktur: FakturSim[] = []) {
    const perOrder = new Map<string, number>();
    const urutan: string[] = [];
    let nextId = 900_000;
    const server: Server = createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
            const url = new URL(String(req.url), "http://sim");
            if (url.pathname.endsWith("/sales-invoice/list.do")) {
                const cust = Number(url.searchParams.get("filter.customerId.val"));
                const rows = faktur.filter((f) => f.customerId === cust)
                    .map((f) => ({ id: f.id, number: f.number, customer: { id: f.customerId }, lastUpdate: f.lastUpdate }));
                res.end(JSON.stringify({ s: true, d: rows, sp: { rowCount: rows.length, pageCount: 1 } }));
                return;
            }
            if (url.pathname.endsWith("/sales-invoice/detail.do")) {
                const f = faktur.find((x) => String(x.id) === url.searchParams.get("id"));
                res.end(JSON.stringify(f ? { s: true, d: { id: f.id, number: f.number, charField1: f.charField1 } } : { s: false, d: ["tidak ada"] }));
                return;
            }
            if (!url.pathname.endsWith("/sales-invoice/save.do")) {
                res.end(JSON.stringify({ s: true, d: [] })); // baca-saja (pra-cek sesi) selalu sah
                return;
            }
            const key = String(JSON.parse(raw || "{}").charField1 ?? "");
            perOrder.set(key, (perOrder.get(key) ?? 0) + 1);
            urutan.push(key);
            const id = nextId++;
            setTimeout(() => res.end(JSON.stringify({ s: true, r: { id, number: `INV/UJI/${id}` } })), delayMs);
        });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return {
        host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        kiriman: (key: string) => perOrder.get(key) ?? 0,
        urutan: () => [...urutan],
        close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
    };
}

test("PG: migrasi invoice_outbox_event idempoten (dijalankan dua kali) + CHECK jenis & potongan", { skip: pgSkip }, async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 2 });
    try {
        const entry = await entriMigrasi("invoice_outbox_event");
        await pool.query(entry.sql);
        await pool.query(entry.sql); // kedua kalinya tanpa galat, tanpa perubahan
        assert.equal((await pool.query(entry.sudahAda)).rowCount, 1);
        const id = `UJI-S6D:${randomUUID()}`;
        await assert.rejects(pool.query(`INSERT INTO invoice_outbox_event (order_id, jenis) VALUES ($1, 'ngarang')`, [id]), /invoice_outbox_event_jenis/);
        await assert.rejects(pool.query(`INSERT INTO invoice_outbox_event (order_id, jenis, response_excerpt) VALUES ($1, 'kirim', $2)`, [id, "x".repeat(501)]),
            /invoice_outbox_event_excerpt/);
    } finally {
        await pool.end();
    }
});

test("PG: Buang = DELETE baris + event `buang` berisi salinannya; kunci SO bebas diantre ulang", { skip: pgSkip }, async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 2 });
    const orderId = `UJI-S6D:${randomUUID()}`;
    try {
        await pool.query((await entriMigrasi("invoice_outbox_event")).sql);
        await seed(pool, orderId, "rejected", { lastError: '["Pelanggan melebihi batas piutang"]' });
        const hasil = await aksiAntrean(drizzle(pool), { orderId, action: "discard", actor: "petugas@contoh", reason: "SO dibatalkan principal" });
        assert.equal(hasil.status, 200);
        assert.equal((await pool.query(`SELECT 1 FROM invoice_outbox WHERE order_id = $1`, [orderId])).rowCount, 0);
        const [buang] = await events(pool, orderId);
        assert.equal(buang.jenis, "buang");
        assert.equal(buang.state_from, "rejected");
        assert.equal(buang.actor, "petugas@contoh");
        assert.equal(buang.reason, "SO dibatalkan principal");
        assert.equal(buang.detail.last_error, '["Pelanggan melebihi batas piutang"]');
        assert.equal(buang.detail.payload.charField1, orderId);
        assert.ok(buang.detail.queued_at, "waktu antre asli wajib disalin (jendela pencarian AM-029)");
        // PK bebas: SO yang sama boleh masuk antrean lagi.
        await seed(pool, orderId, "queued");
        assert.equal((await pool.query(`SELECT 1 FROM invoice_outbox WHERE order_id = $1`, [orderId])).rowCount, 1);
        // Status lain tidak bisa dibuang / diantre ulang; tanpa event.
        await pool.query(`UPDATE invoice_outbox SET state = 'unknown' WHERE order_id = $1`, [orderId]);
        assert.equal((await aksiAntrean(drizzle(pool), { orderId, action: "discard", actor: "x", reason: "" })).status, 409);
        assert.equal((await aksiAntrean(drizzle(pool), { orderId, action: "resend", actor: "x", reason: "" })).status, 409);
        assert.equal((await events(pool, orderId)).length, 1);
    } finally {
        await pool.query(`DELETE FROM invoice_outbox WHERE order_id = $1`, [orderId]);
        await pool.end();
    }
});

test("PG: penyapu + klaim bersamaan — hanya `sending` > 15 mnt jadi unknown (+event), klaim baru tidak tersapu", { skip: pgSkip }, async () => {
    const poolA = new Pool({ connectionString: PG_URL, max: 2 });
    const poolB = new Pool({ connectionString: PG_URL, max: 2 });
    const sim = await simulatorAccurate(300);
    const lama = `UJI-S6D:${randomUUID()}`;
    const baru = `UJI-S6D:${randomUUID()}`;
    const antre = `UJI-S6D:${randomUUID()}`;
    try {
        await poolA.query((await entriMigrasi("invoice_outbox_event")).sql);
        await seed(poolA, lama, "sending", { updatedAgoMin: 20 });
        await seed(poolA, baru, "sending", { updatedAgoMin: 1 });
        await seed(poolA, antre, "queued");
        const sesi = { sessionHost: sim.host, sessionId: "sesi-uji", accessToken: "token-uji" };
        // Kirim (klaim `antre`, fetch 300 ms) dan penyapu kedua berjalan bersamaan.
        const [kirim, sapuB] = await Promise.all([
            sendQueuedInvoices(sesi, { targetDb: "DB-UJI", limit: 50, orderIds: [antre], actor: "penekan@contoh" },
                { db: drizzle(poolA), refresh: async () => undefined }),
            (async () => {
                await new Promise((r) => setTimeout(r, 100)); // saat `antre` sedang `sending`
                const { sapuSending } = await import("./invoice-sender.ts");
                return sapuSending(drizzle(poolB), "cron:penyapu");
            })(),
        ]);
        assert.equal(kirim.sent, 1);
        assert.equal(sim.kiriman(antre), 1);
        assert.ok(!sapuB.includes(antre), "klaim yang sedang berjalan ikut tersapu");
        assert.ok(!sapuB.includes(baru));
        const state = async (id: string) => (await poolA.query(`SELECT state FROM invoice_outbox WHERE order_id = $1`, [id])).rows[0].state;
        assert.equal(await state(lama), "unknown");
        assert.equal(await state(baru), "sending");
        assert.equal(await state(antre), "posted");
        const ev = await events(poolA, lama);
        assert.equal(ev.filter((e) => e.jenis === "sapu").length, 1, "satu baris tersapu = tepat satu event sapu");
        assert.deepEqual([ev[0].state_from, ev[0].state_to], ["sending", "unknown"]);
        // Penyapu idempoten: putaran berikutnya tidak menyapu ulang / tidak menambah event.
        await (await import("./invoice-sender.ts")).sapuSending(drizzle(poolA), "cron:penyapu");
        assert.equal((await events(poolA, lama)).length, 1);
        assert.equal((await events(poolA, baru)).length, 0);
    } finally {
        await sim.close();
        await poolA.query(`DELETE FROM invoice_outbox WHERE order_id = ANY($1)`, [[lama, baru, antre]]);
        await poolA.end();
        await poolB.end();
    }
});

test("PG: DDL manual (E5 + append-only) — dijalankan DUA kali: data lama dikunci tidak pasti sekali, riwayat tak bisa diubah", { skip: pgSkip }, async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 2 });
    const id = (nama: string) => `UJI-S6D-E5:${nama}:${randomUUID()}`;
    const kasus = {
        gateway: id("rejected-gateway"), amplop: id("rejected-amplop"), tanpaId: id("posted-tanpa-id"), denganId: id("posted-id"),
        macet: id("sending-20m"), hidup: id("sending-1m"), antre: id("queued"),
        antreUlangLama: id("queued-attempts-tanpa-cari"), antreUlangDicari: id("queued-attempts-dicari"),
    };
    try {
        await pool.query((await entriMigrasi("invoice_outbox_event")).sql);
        await seed(pool, kasus.gateway, "rejected", { lastError: '{"message":"Bad Gateway"}' });
        await seed(pool, kasus.amplop, "rejected", { lastError: '["Pelanggan melebihi batas piutang"]' });
        await seed(pool, kasus.tanpaId, "posted");
        await seed(pool, kasus.denganId, "posted", { accurateId: "331710" });
        await seed(pool, kasus.macet, "sending", { updatedAgoMin: 20 });
        await seed(pool, kasus.hidup, "sending", { updatedAgoMin: 1 });
        await seed(pool, kasus.antre, "queued");
        // Antre ulang VERSI LAMA: rejected -> queued tanpa pencarian, attempts & last_error tertinggal.
        await seed(pool, kasus.antreUlangLama, "queued", { attempts: 2, lastError: '["Pelanggan melebihi batas piutang"]' });
        // Antre ulang VERSI BARU (sudah dicari, event antre_ulang membawa pencarian) -> tidak disentuh.
        await seed(pool, kasus.antreUlangDicari, "queued", { attempts: 1, lastError: '["stok kurang"]' });
        await pool.query(`INSERT INTO invoice_outbox_event (order_id, jenis, state_from, state_to, actor, detail)
                          VALUES ($1, 'antre_ulang', 'rejected', 'queued', 'uji', '{"pencarian":{"hasil":"tidak_ketemu_dicek"}}'::jsonb)`, [kasus.antreUlangDicari]);
        const { readFile } = await import("node:fs/promises");
        const ddl = await readFile(new URL("../docs/handover/DDL_OUTBOX_EVENT.sql", import.meta.url), "utf8");
        const jalankan = async () => {
            const client = await pool.connect();
            try {
                const hasil = await client.query(ddl) as unknown as { rows: { cek: string; ok: boolean | null }[] }[];
                return hasil[hasil.length - 1].rows;
            } finally {
                client.release();
            }
        };
        const verifikasi1 = await jalankan();
        const verifikasi2 = await jalankan(); // kedua kalinya: tanpa perubahan
        for (const v of [...verifikasi1, ...verifikasi2]) assert.notEqual(v.ok, false, `VERIFIKASI gagal: ${v.cek}`);

        const state = async (orderId: string) => (await pool.query(`SELECT state, last_error FROM invoice_outbox WHERE order_id = $1`, [orderId])).rows[0];
        for (const k of [kasus.gateway, kasus.tanpaId, kasus.macet]) {
            assert.equal((await state(k)).state, "unknown", k);
            const ev = await events(pool, k);
            assert.equal(ev.length, 1, `${k}: dua kali jalan = tetap SATU event`);
            assert.deepEqual([ev[0].jenis, ev[0].state_to, ev[0].actor], ["unknown", "unknown", "ddl:E5"]);
        }
        assert.match((await state(kasus.gateway)).last_error, /Bad Gateway/, "last_error lama dipertahankan di pesan");
        assert.equal((await events(pool, kasus.gateway))[0].detail.last_error, '{"message":"Bad Gateway"}');
        assert.equal((await state(kasus.amplop)).state, "rejected");
        assert.equal((await state(kasus.denganId)).state, "posted");
        assert.equal((await state(kasus.hidup)).state, "sending", "kiriman yang sedang berjalan tidak boleh disentuh E5");
        assert.equal((await state(kasus.antre)).state, "queued");
        for (const k of [kasus.amplop, kasus.denganId, kasus.hidup, kasus.antre]) assert.equal((await events(pool, k)).length, 0, k);
        // A-SEDANG: antre ulang versi lama kembali ke Ditolak (antre ulang berikutnya lewat pencarian), SEKALI.
        assert.equal((await state(kasus.antreUlangLama)).state, "rejected");
        assert.match((await state(kasus.antreUlangLama)).last_error, /^\["E5: /, "amplop [..] agar E5 tidak menguncinya lagi");
        const evLama = await events(pool, kasus.antreUlangLama);
        assert.deepEqual(evLama.map((e) => [e.jenis, e.state_from, e.state_to, e.actor]), [["rejected", "queued", "rejected", "ddl:E5"]]);
        assert.equal(evLama[0].detail.attempts, 2);
        assert.equal((await state(kasus.antreUlangDicari)).state, "queued");
        assert.equal((await events(pool, kasus.antreUlangDicari)).length, 1, "yang sudah dicari tidak mendapat event E5");

        // Append-only di tingkat DB.
        await assert.rejects(pool.query(`UPDATE invoice_outbox_event SET reason = 'ubah' WHERE order_id = $1`, [kasus.gateway]), /append-only/);
        await assert.rejects(pool.query(`DELETE FROM invoice_outbox_event WHERE order_id = $1`, [kasus.gateway]), /append-only/);
    } finally {
        await pool.query(`DELETE FROM invoice_outbox WHERE order_id = ANY($1)`, [Object.values(kasus)]);
        await pool.end();
    }
});

// B-SEDANG: tanpa role accapi_app di DB uji, baris VERIFIKASI hak bernilai NULL dan REVOKE/GRANT tidak pernah teruji.
test("PG: DDL manual — hak accapi_app: INSERT event boleh, UPDATE/DELETE/TRUNCATE ditolak oleh HAK (REVOKE), bukan hanya trigger", { skip: pgSkip }, async (t) => {
    const pool = new Pool({ connectionString: PG_URL, max: 2 });
    let dibuat = false;
    try {
        await pool.query((await entriMigrasi("invoice_outbox_event")).sql);
        if (!(await pool.query(`SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app'`)).rowCount) {
            try {
                await pool.query(`CREATE ROLE accapi_app NOLOGIN`);
                dibuat = true;
            } catch (error) {
                t.skip(`role accapi_app tidak ada dan tidak bisa dibuat (${error instanceof Error ? error.message : error}) — REVOKE/GRANT TIDAK teruji`);
                return;
            }
        }
        // Tiru default privileges produksi (runbook L1g: role aplikasi mendapat hak penuh pada tabel baru) —
        // tanpa ini role baru memang tak berhak apa pun dan REVOKE tidak pernah diuji.
        await pool.query(`GRANT ALL ON invoice_outbox_event TO accapi_app`);
        const { readFile } = await import("node:fs/promises");
        const ddl = await readFile(new URL("../docs/handover/DDL_OUTBOX_EVENT.sql", import.meta.url), "utf8");
        const client = await pool.connect();
        try {
            const hasil = await client.query(ddl) as unknown as { rows: { cek: string; ok: boolean | null }[] }[];
            const verifikasi = new Map(hasil[hasil.length - 1].rows.map((r) => [r.cek, r.ok]));
            // Dengan role ada, baris hak WAJIB true — NULL berarti tidak teruji.
            assert.equal(verifikasi.get("accapi_app tanpa UPDATE/DELETE/TRUNCATE event"), true);
            assert.equal(verifikasi.get("accapi_app boleh SELECT/INSERT event"), true);

            const orderId = `UJI-S6D-ROLE:${randomUUID()}`;
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE accapi_app");
            await client.query(`INSERT INTO invoice_outbox_event (order_id, jenis, actor) VALUES ($1, 'antre', 'uji-role')`, [orderId]);
            for (const perintah of [
                `UPDATE invoice_outbox_event SET reason = 'ubah' WHERE order_id = '${orderId}'`,
                `DELETE FROM invoice_outbox_event WHERE order_id = '${orderId}'`,
                `TRUNCATE invoice_outbox_event`,
            ]) {
                await client.query("SAVEPOINT coba");
                // "permission denied" = REVOKE; pesan trigger "append-only" berarti hanya lapis kedua yang menahan.
                await assert.rejects(client.query(perintah), /permission denied/, perintah);
                await client.query("ROLLBACK TO SAVEPOINT coba");
            }
            await client.query("ROLLBACK");
        } finally {
            client.release();
        }
    } finally {
        if (dibuat) {
            await pool.query(`DROP OWNED BY accapi_app`);
            await pool.query(`DROP ROLE accapi_app`);
        }
        await pool.end();
    }
});

test("PG: cariFaktur cache — per customer_no + jendela waktu, raw_data string, EQUAL; kosong -> ke Accurate (tanpa sesi = gagal_cek)", { skip: pgSkip }, async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 2 });
    const { cariFaktur } = await import("./invoice-search.ts");
    const pelanggan = `C-UJI-${randomUUID().slice(0, 8)}`;
    const key = `UJI-S6D:${randomUUID()}`;
    const base = 9_000_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
    const antre = new Date(Date.now() - 2 * 3_600_000);
    try {
        const tambah = (id: number, raw: unknown, createdAgoJam: number | null, lastAgoJam: number, cust = pelanggan) => pool.query(
            `INSERT INTO sales_invoice (id, number, customer_no, raw_data, created_at, last_update_at)
             VALUES ($1, $2, $3, $4::jsonb, CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(hours => $5::int) END,
                     now() - make_interval(hours => $6::int))`,
            [id, `INV/UJI/${id}`, cust, JSON.stringify(JSON.stringify(raw)), createdAgoJam, lastAgoJam]);
        await tambah(base + 1, { charField1: key }, 72, 72);                 // terlalu lama (sebelum jendela −1 hari)
        await tambah(base + 2, { charField1: `${key}X` }, 1, 1);              // bukan EQUAL
        await tambah(base + 3, { charField1: key }, 1, 1, `${pelanggan}-LAIN`); // pelanggan lain
        const db = drizzle(pool);
        const kosong = await cariFaktur({ db, key, customerNo: pelanggan, queuedAt: antre, session: null });
        assert.equal(kosong.hasil, "gagal_cek", "cache tidak ketemu + tanpa sesi = gagal_cek, BUKAN tidak_ketemu");
        await tambah(base + 4, { charField1: "", detailItem: [{ charField1: key }] }, null, 1); // created_at NULL (list.do) -> last_update_at
        const ketemu = await cariFaktur({ db, key, customerNo: pelanggan, queuedAt: antre, session: null });
        assert.deepEqual(ketemu, { hasil: "ketemu", id: String(base + 4), number: `INV/UJI/${base + 4}`, sumber: "cache", cocok: "baris",
            semua: [{ id: String(base + 4), number: `INV/UJI/${base + 4}` }] });
    } finally {
        await pool.query(`DELETE FROM sales_invoice WHERE id BETWEEN $1 AND $2`, [base, base + 9]);
        await pool.end();
    }
});

test("PG E2: Antre ulang didahului pencarian — ketemu di cache = terposting, Kirim TIDAK memanggil save.do", { skip: pgSkip }, async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 2 });
    const sim = await simulatorAccurate(50);
    const { pencariFaktur } = await import("./invoice-outbox-actions.ts");
    const orderId = `UJI-S6D:${randomUUID()}`;
    const invoiceId = 9_100_000_000 + Math.floor(Math.random() * 1_000_000);
    try {
        await pool.query((await entriMigrasi("invoice_outbox_event")).sql);
        await seed(pool, orderId, "rejected", { lastError: '["Pelanggan melebihi batas piutang"]' });
        await pool.query(`INSERT INTO sales_invoice (id, number, customer_no, raw_data, created_at, last_update_at)
                          VALUES ($1, 'INV/UJI/CACHE', 'C-TEST-KN', $2::jsonb, now(), now())`, [invoiceId, JSON.stringify({ charField1: orderId })]);
        const db = drizzle(pool);
        const sesi = { sessionHost: sim.host, sessionId: "sesi-uji", accessToken: "token-uji" };
        const hasil = await aksiAntrean(db, { orderId, action: "resend", actor: "petugas@contoh", reason: "", cari: pencariFaktur(db, sesi), targetDb: "DB-UJI" });
        assert.equal(hasil.status, 200);
        assert.equal(hasil.body.state, "posted");
        const [row] = (await pool.query(`SELECT state, accurate_id, accurate_number, accurate_db_id FROM invoice_outbox WHERE order_id = $1`, [orderId])).rows;
        assert.deepEqual(row, { state: "posted", accurate_id: String(invoiceId), accurate_number: "INV/UJI/CACHE", accurate_db_id: "DB-UJI" });
        const kirim = await sendQueuedInvoices(sesi, { targetDb: "DB-UJI", limit: 50, orderIds: [orderId], actor: "petugas@contoh" },
            { db, refresh: async () => undefined });
        assert.equal(kirim.sent + kirim.unknown + kirim.rejected, 0);
        assert.equal(sim.kiriman(orderId), 0, "faktur yang ditemukan tidak boleh dikirim lagi");
        const ev = await events(pool, orderId);
        assert.deepEqual(ev.map((e) => e.jenis), ["posted"]);
        assert.equal(ev[0].detail.pencarian.sumber, "cache");
    } finally {
        await sim.close();
        await pool.query(`DELETE FROM invoice_outbox WHERE order_id = $1`, [orderId]);
        await pool.query(`DELETE FROM sales_invoice WHERE id = $1`, [invoiceId]);
        await pool.end();
    }
});

test("PG E2: Buang -> antre ulang SO yang sama: pencarian list.do+detail.do (simulator) — ketemu = terposting tanpa save.do; tidak ketemu = queued", { skip: pgSkip }, async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 2 });
    const { antrekan, pencariFaktur } = await import("./invoice-outbox-actions.ts");
    const customerId = 9_200_000_000 + Math.floor(Math.random() * 1_000_000);
    const customerNo = `C-UJI-${customerId}`;
    const sudah = `UJI-S6D:${randomUUID()}`;
    const belum = `UJI-S6D:${randomUUID()}`;
    const nanti = new Date(Date.now() + 3_600_000 + 7 * 3_600_000).toISOString(); // lastUpdate UTC+7, sesudah antre
    const lastUpdate = `${nanti.slice(8, 10)}/${nanti.slice(5, 7)}/${nanti.slice(0, 4)} ${nanti.slice(11, 19)}`;
    const sim = await simulatorAccurate(20, [
        { id: 77001, number: "INV/UJI/77001", charField1: sudah, customerId, lastUpdate },
        { id: 77002, number: "INV/UJI/77002", charField1: "KINO:LAIN", customerId, lastUpdate },
    ]);
    try {
        await pool.query((await entriMigrasi("invoice_outbox_event")).sql);
        await pool.query(`INSERT INTO customer (id, "customerNo", name) VALUES ($1, $2, 'UJI S6-0d')`, [customerId, customerNo]);
        const db = drizzle(pool);
        for (const id of [sudah, belum]) {
            await pool.query(
                `INSERT INTO invoice_outbox (order_id, customer_no, order_date, state, payload, queued_by, last_error)
                 VALUES ($1, $2, '2026-10-08', 'rejected', $3::jsonb, 'uji@contoh', '["stok gudang kurang"]')`,
                [id, customerNo, JSON.stringify({ ...payload(id), customerNo })]);
            assert.equal((await aksiAntrean(db, { orderId: id, action: "discard", actor: "petugas@contoh", reason: "uji" })).status, 200);
        }
        const sesi = { sessionHost: sim.host, sessionId: "sesi-uji", accessToken: "token-uji" };
        const hasil = await antrekan(db, {
            entries: [sudah, belum].map((id) => ({ orderId: id, customerNo, orderDate: "2026-10-08", payload: { ...payload(id), customerNo } })),
            actor: "petugas@contoh", targetDb: "DB-UJI", cari: pencariFaktur(db, sesi),
        });
        assert.deepEqual(hasil.posted, [{ orderId: sudah, accurateId: "77001", number: "INV/UJI/77001" }]);
        assert.deepEqual(hasil.queued, [belum]);
        assert.deepEqual(hasil.blocked, []);
        const kirim = await sendQueuedInvoices(sesi, { targetDb: "DB-UJI", limit: 50, orderIds: [sudah, belum], actor: "petugas@contoh" },
            { db, refresh: async () => undefined });
        assert.equal(sim.kiriman(sudah), 0, "SO yang fakturnya ditemukan tidak boleh dikirim");
        assert.equal(sim.kiriman(belum), 1);
        assert.equal(kirim.sent, 1);
        assert.deepEqual((await events(pool, sudah)).map((e) => e.jenis), ["buang", "posted"]);
        assert.deepEqual((await events(pool, belum)).map((e) => e.jenis), ["buang", "antre", "kirim", "posted"]);
        assert.equal((await events(pool, belum))[1].detail.pencarian.hasil, "tidak_ketemu_dicek");
    } finally {
        await sim.close();
        await pool.query(`DELETE FROM invoice_outbox WHERE order_id = ANY($1)`, [[sudah, belum]]);
        await pool.query(`DELETE FROM customer WHERE id = $1`, [customerId]);
        await pool.end();
    }
});

test("PG AM-047: Selesaikan tidak pasti — terposting (cache ketemu) & tidak terposting (list.do+detail.do tidak ketemu) -> antre ulang mencari lagi", { skip: pgSkip }, async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 2 });
    const { pencariFaktur, selesaikanTidakPasti } = await import("./invoice-outbox-actions.ts");
    const customerId = 9_300_000_000 + Math.floor(Math.random() * 1_000_000);
    const customerNo = `C-UJI-${customerId}`;
    const ada = `UJI-S6D:${randomUUID()}`;
    const tiada = `UJI-S6D:${randomUUID()}`;
    const baru = `UJI-S6D:${randomUUID()}`;
    const invoiceId = customerId; // id faktur cache unik
    const sim = await simulatorAccurate(20, []);
    const alasan = "Diperiksa lewat pencarian charField1 di Accurate";
    try {
        await pool.query((await entriMigrasi("invoice_outbox_event")).sql);
        await pool.query(`INSERT INTO customer (id, "customerNo", name) VALUES ($1, $2, 'UJI S6-0d')`, [customerId, customerNo]);
        for (const id of [ada, tiada, baru]) {
            await pool.query(`INSERT INTO invoice_outbox (order_id, customer_no, order_date, state, payload, queued_by, last_error)
                              VALUES ($1, $2, '2026-10-08', 'unknown', $3::jsonb, 'uji@contoh', 'timeout')`, [id, customerNo, JSON.stringify(payload(id))]);
        }
        const baris = async (id: string) => (await pool.query(`SELECT state, accurate_id, last_error FROM invoice_outbox WHERE order_id = $1`, [id])).rows[0];
        await pool.query(`INSERT INTO sales_invoice (id, number, customer_no, raw_data, created_at, last_update_at)
                          VALUES ($1, 'INV/UJI/AM047', $2, $3::jsonb, now(), now())`, [invoiceId, customerNo, JSON.stringify({ charField1: ada })]);
        const db = drizzle(pool);
        const cari = pencariFaktur(db, { sessionHost: sim.host, sessionId: "sesi-uji", accessToken: "token-uji" });

        // Keputusan yang bertentangan dengan pencarian ditolak.
        assert.equal((await selesaikanTidakPasti(db, { orderId: ada, keputusan: "tidak_terposting", alasan, actor: "admin@contoh", cari, targetDb: "DB-UJI" })).status, 409);
        assert.equal((await selesaikanTidakPasti(db, { orderId: tiada, keputusan: "terposting", alasan, actor: "admin@contoh", cari, targetDb: "DB-UJI" })).status, 409);

        const r1 = await selesaikanTidakPasti(db, { orderId: ada, keputusan: "terposting", alasan, actor: "admin@contoh", cari, targetDb: "DB-UJI" });
        assert.equal(r1.status, 200);
        // A-SEDANG: kirim terakhir 3 menit lalu (jam DB) -> masa tunggu, sisa 12 menit; 16 menit lalu -> boleh.
        await pool.query(`INSERT INTO invoice_outbox_event (order_id, jenis, actor, created_at) VALUES ($1, 'kirim', 'uji', now() - interval '3 minutes')`, [baru]);
        const tunggu = await selesaikanTidakPasti(db, { orderId: baru, keputusan: "tidak_terposting", alasan, actor: "admin@contoh", cari, targetDb: "DB-UJI" });
        assert.equal(tunggu.status, 409);
        assert.equal(tunggu.body.sisaMenit, 12);
        assert.equal((await baris(baru)).state, "unknown");
        await pool.query(`INSERT INTO invoice_outbox_event (order_id, jenis, actor, created_at) VALUES ($1, 'kirim', 'uji', now() - interval '16 minutes')`, [tiada]);
        const r2 = await selesaikanTidakPasti(db, { orderId: tiada, keputusan: "tidak_terposting", alasan, actor: "admin@contoh", cari, targetDb: "DB-UJI" });
        assert.equal(r2.status, 200);
        assert.deepEqual([(await baris(ada)).state, (await baris(ada)).accurate_id], ["posted", String(invoiceId)]);
        assert.equal((await baris(tiada)).state, "rejected");
        const evAda = await events(pool, ada);
        assert.deepEqual(evAda.map((e) => [e.jenis, e.state_from, e.state_to, e.actor, e.reason]), [["selesaikan", "unknown", "posted", "admin@contoh", alasan]]);
        assert.equal(evAda[0].detail.keputusan, "terposting");
        // Diselesaikan dua kali = ditolak (bukan lagi tidak pasti).
        assert.equal((await selesaikanTidakPasti(db, { orderId: ada, keputusan: "terposting", alasan, actor: "x", cari, targetDb: "DB-UJI" })).status, 409);

        // "Tidak terposting" membuka jalur antre ulang, yang MENCARI LAGI sebelum mengantrekan.
        const ulang = await aksiAntrean(db, { orderId: tiada, action: "resend", actor: "petugas@contoh", reason: "", cari, targetDb: "DB-UJI" });
        assert.equal(ulang.status, 200);
        assert.equal(ulang.body.state, "queued");
        assert.deepEqual((await events(pool, tiada)).map((e) => e.jenis), ["kirim", "selesaikan", "antre_ulang"]);
    } finally {
        await sim.close();
        await pool.query(`DELETE FROM invoice_outbox WHERE order_id = ANY($1)`, [[ada, tiada, baru]]);
        await pool.query(`DELETE FROM sales_invoice WHERE id = $1`, [invoiceId]);
        await pool.query(`DELETE FROM customer WHERE id = $1`, [customerId]);
        await pool.end();
    }
});

test("PG BL-39: pratinjau = urutan kirim nyata, termasuk baris ber-created_at SAMA (satu batch)", { skip: pgSkip }, async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 2 });
    const sim = await simulatorAccurate(10);
    const { pratinjauKirim } = await import("./invoice-sender.ts");
    const prefix = `UJI-S6D-B39:${randomUUID().slice(0, 8)}`;
    const ids = ["C", "A", "D", "B"].map((x) => `${prefix}:${x}`);
    try {
        await pool.query((await entriMigrasi("invoice_outbox_event")).sql);
        // Satu INSERT = satu now() = created_at kembar, seperti antre satu batch principal.
        await pool.query(
            `INSERT INTO invoice_outbox (order_id, customer_no, order_date, state, payload, queued_by)
             SELECT id, 'C-TEST-KN', '2026-10-08', 'queued', jsonb_build_object('customerNo', 'C-TEST-KN', 'transDate', '08/10/2026',
                    'taxable', true, 'inclusiveTax', false, 'charField1', id, 'detailItem',
                    jsonb_build_array(jsonb_build_object('itemNo', 'ITM-1', 'quantity', 2, 'unitPrice', 1000, 'itemUnitId', 100,
                        'itemDiscPercent', '', 'itemCashDiscount', 0, 'detailNotes', 'b1', 'charField1', id))), 'uji@contoh'
             FROM unnest($1::text[]) AS id`, [ids]);
        const db = drizzle(pool);
        const lihat = await pratinjauKirim(db, { limit: 50, orderIds: ids });
        const sesi = { sessionHost: sim.host, sessionId: "sesi-uji", accessToken: "token-uji" };
        await sendQueuedInvoices(sesi, { targetDb: "DB-UJI", limit: 50, orderIds: ids, actor: "p" }, { db, refresh: async () => undefined });
        assert.deepEqual(lihat.orders.map((o) => o.orderId), sim.urutan(), "urutan pratinjau ≠ urutan kirim");
        assert.deepEqual(sim.urutan(), [...ids].sort());
        assert.deepEqual(lihat.total, { dpp: 8000, ppn: 880, total: 8880 });
    } finally {
        await sim.close();
        await pool.query(`DELETE FROM invoice_outbox WHERE order_id = ANY($1)`, [ids]);
        await pool.end();
    }
});

test("PG: dua Kirim bersamaan pada antrean yang sama -> SATU kiriman per order, satu event kirim + satu hasil", { skip: pgSkip }, async () => {
    const poolA = new Pool({ connectionString: PG_URL, max: 2 });
    const poolB = new Pool({ connectionString: PG_URL, max: 2 });
    const sim = await simulatorAccurate(150);
    const ids = [`UJI-S6D:${randomUUID()}`, `UJI-S6D:${randomUUID()}`, `UJI-S6D:${randomUUID()}`];
    try {
        await poolA.query((await entriMigrasi("invoice_outbox_event")).sql);
        for (const id of ids) await seed(poolA, id, "queued");
        const sesi = { sessionHost: sim.host, sessionId: "sesi-uji", accessToken: "token-uji" };
        const opsi = { targetDb: "DB-UJI", limit: 50, orderIds: ids };
        const deps = { refresh: async () => undefined } as const;
        const [a, b] = await Promise.all([
            sendQueuedInvoices(sesi, { ...opsi, actor: "penekan-a@contoh" }, { ...deps, db: drizzle(poolA) }),
            sendQueuedInvoices(sesi, { ...opsi, actor: "penekan-b@contoh" }, { ...deps, db: drizzle(poolB) }),
        ]);
        for (const id of ids) {
            assert.equal(sim.kiriman(id), 1, `order ${id} terkirim ${sim.kiriman(id)} kali`);
            const ev = await events(poolA, id);
            assert.deepEqual(ev.map((e) => e.jenis), ["kirim", "posted"]);
            assert.equal(ev[1].http_status, 200);
            assert.match(ev[1].response_excerpt, /INV\/UJI\//);
            assert.equal(ev[0].actor, ev[1].actor, "pengirim klaim dan hasil harus sama");
            const [row] = (await poolA.query(`SELECT state, attempts, accurate_id, accurate_db_id FROM invoice_outbox WHERE order_id = $1`, [id])).rows;
            assert.deepEqual([row.state, row.attempts, row.accurate_db_id], ["posted", 1, "DB-UJI"]);
            assert.ok(row.accurate_id);
        }
        assert.equal(a.sent + b.sent, ids.length);
    } finally {
        await sim.close();
        await poolA.query(`DELETE FROM invoice_outbox WHERE order_id = ANY($1)`, [ids]);
        await poolA.end();
        await poolB.end();
    }
});
