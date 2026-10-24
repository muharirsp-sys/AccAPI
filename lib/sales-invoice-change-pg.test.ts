/* Pencatat perubahan rincian faktur (spec docs/superpowers/specs/2026-10-23-perubahan-rincian-faktur-design.md §8, §10) di Postgres
 * EVALUASI (AM040_DATABASE_URL, bukan produksi): SKEMA SEKALI-PAKAI (sales_invoice/invoice_outbox/sales_profile disalin `LIKE public.*`
 * + db/migrations/0036 + 0037, search_path hanya skema itu, DROP di akhir). Accurate dipalsukan lewat globalThis.fetch; titik masuk ASLI
 * lib/sync.ts upsertSalesInvoiceById. Dibuktikan: koreksi tercatat sekali (pengiriman ulang tidak menambah), tabel perubahan hilang ->
 * cache tetap diperbarui, faktur tiada -> invoice_deleted + cache dibuang, dua panggilan serentak tidak ganda, 0037 = migrate-pg =
 * Drizzle dan idempoten. Data contoh generik. Tanpa env dilewati. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { getTableConfig } from "drizzle-orm/pg-core";
import { salesInvoiceLineChange } from "../db/schema.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";
const TABEL = ["sales_invoice", "invoice_outbox", "sales_profile"];
const skema = `uji_silc_${randomUUID().slice(0, 8)}`;
const skemaLain: string[] = [];
const DB_FAKTUR = "db-uji-silc";
const CREDS = { databaseId: DB_FAKTUR, sessionHost: "http://accurate.uji", sessionId: "s", apiKey: "k" };
let admin: Pool;
let pool: Pool;
const urlSkema = (s = skema) => { const u = new URL(PG_URL); u.searchParams.set("options", `-c search_path=${s}`); return u.toString(); };
const berkas = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

async function muat() {
    return { dbMod: await import("./db.ts"), sync: await import("./sync.ts") };
}
let m: Awaited<ReturnType<typeof muat>>;

const fetchAsli = globalThis.fetch;
/** Accurate palsu: setiap detail.do dijawab `jawaban`. */
function palsukan(jawaban: unknown) {
    globalThis.fetch = (async () => new Response(JSON.stringify(jawaban),
        { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
}
const brs = (id: number, no: string, qty: number) => ({ id, item: { no, name: `NAMA ${no}` }, quantity: qty, itemUnit: { name: "PCS" },
    unitRatio: 1, unitPrice: 4610, itemDiscPercent: "", itemCashDiscount: 0, totalPrice: qty * 4610, warehouse: { name: "GUDANG A" } });
const FAKTUR = (id: number, qtyA: number) => ({ id, number: `INV/2610/AA${id}`, transDate: "17/10/2026",
    customer: { customerNo: "C-A01-AA", name: "TOKO A" }, totalAmount: qtyA * 4610 + 13830, primeOwing: 0, statusName: "Belum Lunas",
    printedTimeView: "17 Oct 2026 15:23:23", printUserName: "FAKTURIS A", createDate: "17/10/2026 12:58:32",
    detailItem: [brs(id * 10 + 1, "BARANG A", qtyA), brs(id * 10 + 2, "BARANG B", 3)] });
const WEBHOOK = { source: "webhook" as const, appKey: "", savedAt: new Date("2026-10-22T06:49:06Z") };
async function simpan(f: ReturnType<typeof FAKTUR>) {
    palsukan({ s: true, d: f });
    try { await m.sync.upsertSalesInvoiceById(f.id, CREDS, WEBHOOK); } finally { globalThis.fetch = fetchAsli; }
}
const perubahan = async (id: number) => (await pool.query(`SELECT kind, item_no, (old_line->>'qty')::float AS lama,
    (new_line->>'qty')::float AS baru, base_qty_delta::float AS delta, app_key, source, after_print
    FROM sales_invoice_line_change WHERE invoice_id = $1 ORDER BY id`, [id])).rows;
const totalCache = async (id: number) => (await pool.query(`SELECT total_amount::float AS t FROM sales_invoice WHERE id = $1`, [id])).rows[0]?.t;

before(async () => {
    if (!PG_URL) return;
    admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${skema}`);
    for (const t of TABEL) await admin.query(`CREATE TABLE ${skema}."${t}" (LIKE public."${t}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    pool = new Pool({ connectionString: urlSkema(), max: 3 });
    // 0036 = kolom ringkas Supervisor Review yang ditulis upsert faktur (idempoten bila public sudah punya).
    await pool.query(await berkas("../db/migrations/0036_supervisor_review.sql"));
    await pool.query(await berkas("../db/migrations/0037_sales_invoice_line_change.sql"));
    process.env.DATABASE_URL = urlSkema();
    process.env.ACCURATE_INVOICE_DB_ID = DB_FAKTUR;
    m = await muat();
});

after(async () => {
    if (!PG_URL) return;
    globalThis.fetch = fetchAsli;
    await pool?.end();
    await m?.dbMod.pool.end();
    for (const s of [skema, ...skemaLain]) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await admin.end();
});

test("PG koreksi qty tercatat sekali; pengiriman ulang dengan isi sama tidak menambah baris", { skip: pgSkip }, async () => {
    await simpan(FAKTUR(101, 72)); // pertama kali terbaca: belum ada isi lama -> tidak ada baris
    assert.deepEqual(await perubahan(101), []);
    await simpan(FAKTUR(101, 6));
    await simpan(FAKTUR(101, 6));
    assert.deepEqual(await perubahan(101), [
        { kind: "changed", item_no: "BARANG A", lama: 72, baru: 6, delta: -66, app_key: "", source: "webhook", after_print: true },
    ]);
    assert.equal(await totalCache(101), 6 * 4610 + 13830);
});

test("PG tabel perubahan tidak ada -> cache tetap diperbarui dan tidak melempar", { skip: pgSkip }, async () => {
    await simpan(FAKTUR(102, 10));
    await pool.query(`ALTER TABLE sales_invoice_line_change RENAME TO silc_sementara`);
    try {
        await simpan(FAKTUR(102, 4));
        assert.equal(await totalCache(102), 4 * 4610 + 13830);
    } finally {
        await pool.query(`ALTER TABLE silc_sementara RENAME TO sales_invoice_line_change`);
    }
    assert.deepEqual(await perubahan(102), []);
});

test("PG faktur tiada di Accurate -> invoice_deleted dicatat dan cache dibuang", { skip: pgSkip }, async () => {
    await simpan(FAKTUR(103, 5));
    palsukan({ s: true }); // detail.do s:true tanpa d = faktur sudah dihapus (lib/sync.ts fakturSudahTiada)
    try {
        await assert.rejects(m.sync.upsertSalesInvoiceById(103, CREDS, WEBHOOK), { name: "AccurateInvoiceGoneError" });
    } finally { globalThis.fetch = fetchAsli; }
    assert.deepEqual((await perubahan(103)).map((r) => [r.kind, r.item_no, r.delta]),
        [["invoice_deleted", "BARANG A", -5], ["invoice_deleted", "BARANG B", -3]]);
    assert.equal(await totalCache(103), undefined);
});

test("PG dua webhook serentak untuk faktur yang sama tidak mencatat ganda", { skip: pgSkip }, async () => {
    await simpan(FAKTUR(104, 72));
    // Sesi lain memegang kunci advisory yang SAMA: kedua panggilan wajib antre di kunciFaktur. Tanpa kunci di kode keduanya lolos
    // (penunggu 0) -> uji gagal pasti, tidak bergantung pada untung-untungan balapan (tinjauan 24 Okt).
    const kunci = `hashtextextended('sales_invoice:104', 0)`;
    const penunggu = async () => (await pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)).rows[0].n as number;
    const pemegang = await admin.connect();
    await pemegang.query(`SELECT pg_advisory_lock(${kunci})`);
    palsukan({ s: true, d: FAKTUR(104, 6) });
    let antre = 0;
    try {
        const dua = Promise.allSettled([m.sync.upsertSalesInvoiceById(104, CREDS, WEBHOOK), m.sync.upsertSalesInvoiceById(104, CREDS, WEBHOOK)]);
        try {
            for (let i = 0; i < 100 && (antre = await penunggu()) < 2; i++) await new Promise((r) => setTimeout(r, 50)); // <= ~5 dtk
        } finally {
            await pemegang.query(`SELECT pg_advisory_unlock(${kunci})`);
            pemegang.release();
        }
        for (const h of await dua) if (h.status === "rejected") throw h.reason;
    } finally { globalThis.fetch = fetchAsli; }
    assert.equal(antre, 2, "kedua panggilan menunggu kunci advisory faktur yang sama");
    assert.deepEqual((await perubahan(104)).map(({ kind, lama, baru, delta }) => ({ kind, lama, baru, delta })),
        [{ kind: "changed", lama: 72, baru: 6, delta: -66 }]);
    assert.equal(await totalCache(104), 6 * 4610 + 13830);
});

test("PG 0037 = entri migrate-pg = Drizzle; idempoten; migrate-pg jalan lalu SKIP", { skip: pgSkip }, async () => {
    const { migrations } = await import(new URL("../scripts/migrate-pg.mjs", import.meta.url).href) as
        { migrations: { nama: string; sudahAda: string; sql: string }[] };
    const entri = migrations.find((x) => x.nama === "sales_invoice_line_change");
    assert.ok(entri, "entri migrate-pg");
    const kolom = async (p: Pool) => (await p.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'sales_invoice_line_change'`)).rows
        .map((r) => `${r.column_name}|${r.data_type}|${r.is_nullable}|${String(r.column_default).replace(/uji_silc_m?_?[0-9a-f]{8}\./g, "")}`).sort();
    const indeks = async (p: Pool) => (await p.query(`SELECT indexname, regexp_replace(indexdef, ' ON \\S+ ', ' ON t ') AS def FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'sales_invoice_line_change'`)).rows.map((r) => r.def).sort();
    const s2 = `uji_silc_m_${randomUUID().slice(0, 8)}`;
    skemaLain.push(s2);
    await admin.query(`CREATE SCHEMA ${s2}`);
    const p2 = new Pool({ connectionString: urlSkema(s2), max: 1 });
    try {
        assert.equal((await p2.query(entri.sudahAda)).rowCount, 0, "skema kosong -> migrate-pg menjalankan entri");
        await p2.query(entri.sql);
        assert.equal((await p2.query(entri.sudahAda)).rowCount, 1, "sesudahnya SKIP");
        await pool.query(await berkas("../db/migrations/0037_sales_invoice_line_change.sql")); // kali kedua di skema uji: idempoten
        assert.deepEqual(await kolom(p2), await kolom(pool), "kolom migrate-pg = berkas 0037");
        assert.deepEqual(await indeks(p2), await indeks(pool), "indeks migrate-pg = berkas 0037");
        const cfg = getTableConfig(salesInvoiceLineChange);
        assert.deepEqual(cfg.columns.map((c) => c.name).sort(), (await kolom(pool)).map((k) => k.split("|")[0]).sort(), "Drizzle = 0037 (kolom)");
        assert.deepEqual(cfg.indexes.map((i) => i.config.name).sort(), ["idx_silc_invoice_id", "idx_silc_item_no"]);
        assert.deepEqual(cfg.checks.map((c) => c.name).sort(), (await pool.query(`SELECT conname FROM pg_constraint
            WHERE conrelid = 'sales_invoice_line_change'::regclass AND contype = 'c'`)).rows.map((r) => r.conname).sort(), "Drizzle = 0037 (CHECK)");
    } finally {
        await p2.end();
    }
});
