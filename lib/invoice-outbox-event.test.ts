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

async function seed(pool: Pool, orderId: string, state: string, extra: { lastError?: string; accurateId?: string; updatedAgoMin?: number } = {}) {
    await pool.query(
        `INSERT INTO invoice_outbox (order_id, customer_no, order_date, state, payload, queued_by, accurate_id, last_error, updated_at)
         VALUES ($1, 'C-TEST-KN', '2026-10-08', $2, $3::jsonb, 'uji@contoh', $4, $5, now() - make_interval(mins => $6))`,
        [orderId, state, JSON.stringify(payload(orderId)), extra.accurateId ?? "", extra.lastError ?? "", extra.updatedAgoMin ?? 0]);
}

const events = async (pool: Pool, orderId: string) =>
    (await pool.query(`SELECT jenis, state_from, state_to, actor, http_status, response_excerpt, error_code, reason, detail
                       FROM invoice_outbox_event WHERE order_id = $1 ORDER BY id`, [orderId])).rows;

/** Simulator save.do berlabel: menghitung kiriman per charField1 dan menjawab sukses beramplop. */
async function simulatorAccurate(delayMs = 100) {
    const perOrder = new Map<string, number>();
    let nextId = 900_000;
    const server: Server = createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
            if (!String(req.url).includes("/sales-invoice/save.do")) {
                res.end(JSON.stringify({ s: true, d: [] })); // baca-saja (pra-cek sesi) selalu sah
                return;
            }
            const key = String(JSON.parse(raw || "{}").charField1 ?? "");
            perOrder.set(key, (perOrder.get(key) ?? 0) + 1);
            const id = nextId++;
            setTimeout(() => res.end(JSON.stringify({ s: true, r: { id, number: `INV/UJI/${id}` } })), delayMs);
        });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return {
        host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        kiriman: (key: string) => perOrder.get(key) ?? 0,
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
