/* Jejak pencabutan (audit desain 001 No 6 dan 18, owner 27 Okt 2026): route ASLI DELETE /api/invoice-verify dan DELETE
 * /api/principal-order/dupe-ack. Tanpa DB: alasan < 10 karakter / note sales kosong ditolak 400 SEBELUM menulis. Dengan Postgres
 * EVALUASI (AM040_DATABASE_URL, bukan produksi): SKEMA SEKALI-PAKAI berisi 0017 (order_dupe_ack), 0024 (invoice_verify_note), dan
 * entri migrate-pg `pencabutan_log` (dua kali = idempoten, sama dengan 0038). Diuji: baris dicabut + log (baris lama, alasan, oleh)
 * dalam satu transaksi, dan log gagal = DELETE ikut batal. Route memakai `headers()` -> lingkup permintaan tiruan (pola
 * lib/principal-pemakai-pg.test.ts). Sesi & grup izin dipalsukan. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { getTableConfig } from "drizzle-orm/pg-core";
import { pencabutanLog, userGroup } from "../db/schema.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";
const skema = `uji_cabut_${randomUUID().slice(0, 8)}`;
const IZIN = ["order.view", "order.edit", "order.create"];
const EMAIL = "k3@uji.test";
let admin: Pool;
let pool: Pool;
const urlSkema = (s: string) => { const u = new URL(PG_URL); u.searchParams.set("options", `-c search_path=${s}`); return u.toString(); };
const berkas = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");
type Migrasi = { nama: string; sudahAda: string; sql: string };
const entri = async (nama: string) => {
    const mod = await import(new URL("../scripts/migrate-pg.mjs", import.meta.url).href) as { migrations: Migrasi[] };
    const e = mod.migrations.find((x) => x.nama === nama);
    assert.ok(e, `entri migrasi ${nama} tidak ada`);
    return e;
};

type Route = (req: Request) => Promise<Response>;
async function muat() {
    (globalThis as Record<string, unknown>).AsyncLocalStorage ??= AsyncLocalStorage;
    return {
        ...await import("next/dist/server/app-render/work-async-storage.external.js"),
        ...await import("next/dist/server/app-render/work-unit-async-storage.external.js"),
        NextRequest: (await import("next/server")).NextRequest,
        auth: (await import("./auth.ts")).auth,
        db: (await import("./db.ts")).db,
        verify: await import("../app/api/invoice-verify/route.ts") as unknown as Record<string, Route>,
        ack: await import("../app/api/principal-order/dupe-ack/route.ts") as unknown as Record<string, Route>,
    };
}
let m: Awaited<ReturnType<typeof muat>>;

function lingkup<T>(fn: () => Promise<T>): Promise<T> {
    const store = { route: "/uji", forceStatic: false, dynamicShouldError: false };
    const unit = { type: "private-cache", phase: "render", headers: new Headers({ host: "app.test" }) };
    return m.workAsyncStorage.run(store as never, () => m.workUnitAsyncStorage.run(unit as never, fn));
}
const minta = (method: string, url: string, body?: unknown) => new m.NextRequest(`http://app.test${url}`, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});
async function jawab(fn: () => Promise<Response>) {
    const r = await lingkup(fn);
    return { status: r.status, body: await r.json() as Record<string, unknown> };
}
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const URL_ACK = "/api/principal-order/dupe-ack?principal=PRINCIPLE%20A&soNo=SO-A-001";

before(async () => {
    if (PG_URL) {
        admin = new Pool({ connectionString: PG_URL, max: 1 });
        await admin.query(`CREATE SCHEMA ${skema}`);
        pool = new Pool({ connectionString: urlSkema(skema), max: 2 });
        for (const f of ["../db/migrations/0017_order_dupe_ack.sql", "../db/migrations/0024_invoice_verify_note.sql"]) await pool.query(await berkas(f));
        process.env.DATABASE_URL = urlSkema(skema);
    }
    delete process.env.LOCAL_AUTH_BYPASS;
    m = await muat();
    Object.defineProperty(m.auth.api, "getSession", { configurable: true, value: async () => ({ user: { id: "u-k3", email: EMAIL, role: "staff" }, session: { id: "s1" } }) });
    const realSelect = m.db.select.bind(m.db);
    Object.defineProperty(m.db, "select", { configurable: true, value: (...a: unknown[]) => {
        const b = (realSelect as (...x: unknown[]) => { from: (t: unknown) => unknown })(...a);
        const realFrom = b.from.bind(b);
        b.from = (t: unknown) => (t === userGroup ? { leftJoin: () => ({ where: async () => IZIN.map((key) => ({ groupId: "g", key })) }) } : realFrom(t));
        return b;
    } });
});

after(async () => {
    if (!PG_URL) return;
    await pool?.end();
    await (await import("./db.ts")).pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${skema} CASCADE`);
    await admin.end();
});

test("tanpa DB: alasan cabut < 10 karakter dan note Terima sales kosong ditolak 400 sebelum menulis", async () => {
    const realTx = Object.getOwnPropertyDescriptor(m.db, "transaction");
    Object.defineProperty(m.db, "transaction", { configurable: true, value: () => { throw new Error("TIDAK BOLEH menulis DB"); } });
    try {
        for (const alasan of [undefined, "", "  pendek  "]) {
            const v = await jawab(() => m.verify.DELETE(minta("DELETE", "/api/invoice-verify", { orderId: "PRINCIPLE-A:SO-A-001", jenis: "sales", alasan })));
            assert.equal(v.status, 400, JSON.stringify(v.body));
            assert.match(String(v.body.error), /minimal 10 karakter/);
            const a = await jawab(() => m.ack.DELETE(minta("DELETE", URL_ACK, alasan === undefined ? undefined : { alasan })));
            assert.equal(a.status, 400, JSON.stringify(a.body));
        }
        const sales = await jawab(() => m.verify.POST(minta("POST", "/api/invoice-verify", { orderId: "PRINCIPLE-A:SO-A-001", jenis: "sales", sidik: "[\"s\"]", note: "  " })));
        assert.equal(sales.status, 400);
        assert.match(String(sales.body.error), /Alasan menerima sales/);
    } finally {
        if (realTx) Object.defineProperty(m.db, "transaction", realTx);
        else delete (m.db as unknown as Record<string, unknown>).transaction; // metode prototipe: hapus tambalan milik objek
    }
});

test("PG: entri migrate-pg pencabutan_log idempoten, = berkas 0038, = Drizzle", { skip: pgSkip }, async () => {
    const e = await entri("pencabutan_log");
    assert.equal((await pool.query(e.sudahAda)).rowCount, 0);
    await pool.query(e.sql);
    await pool.query(e.sql);
    assert.equal((await pool.query(e.sudahAda)).rowCount, 1);
    const kolom = async (p: Pool) => (await p.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'pencabutan_log' ORDER BY column_name`)).rows;
    const lain = `uji_cabut_${randomUUID().slice(0, 8)}`;
    await admin.query(`CREATE SCHEMA ${lain}`);
    const p2 = new Pool({ connectionString: urlSkema(lain), max: 1 });
    try {
        await p2.query(await berkas("../db/migrations/0038_pencabutan_log.sql"));
        assert.deepEqual(await kolom(p2), await kolom(pool), "db/migrations/0038 = entri migrate-pg");
    } finally {
        await p2.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${lain} CASCADE`);
    }
    const cfg = getTableConfig(pencabutanLog);
    assert.deepEqual(cfg.columns.map((k) => [k.name, k.notNull ? "NO" : "YES"].join("|")).sort(),
        (await kolom(pool)).map((k) => [k.column_name, k.is_nullable].join("|")).sort(), "kolom Drizzle = DB");
});

test("PG: Cabut penjelasan Verifikasi balik = DELETE + log (baris lama, alasan, oleh) dalam satu transaksi", { skip: pgSkip }, async () => {
    await pool.query(`INSERT INTO invoice_verify_note (order_id, jenis, sidik, note, decided_by)
        VALUES ('PRINCIPLE-A:SO-A-009', 'sales', '["s"]', 'Sales diganti', 'admin@contoh')`);
    const r = await jawab(() => m.verify.DELETE(minta("DELETE", "/api/invoice-verify",
        { orderId: "PRINCIPLE-A:SO-A-009", jenis: "sales", alasan: "  Penjelasan keliru, sales belum diganti  " })));
    assert.deepEqual([r.status, r.body.dicabut], [200, 1], JSON.stringify(r.body));
    assert.equal((await q(`SELECT 1 FROM invoice_verify_note WHERE order_id = 'PRINCIPLE-A:SO-A-009'`)).length, 0);
    const [log] = await q(`SELECT jenis, kunci, baris_lama, alasan, oleh FROM pencabutan_log WHERE jenis = 'invoice_verify_note'`);
    assert.equal(log.kunci, "PRINCIPLE-A:SO-A-009|sales");
    assert.equal(log.alasan, "Penjelasan keliru, sales belum diganti");
    assert.equal(log.oleh, EMAIL);
    assert.deepEqual([log.baris_lama.note, log.baris_lama.decidedBy, log.baris_lama.sidik], ["Sales diganti", "admin@contoh", "[\"s\"]"]);
    // Tidak ada baris = tidak ada jejak palsu.
    const lagi = await jawab(() => m.verify.DELETE(minta("DELETE", "/api/invoice-verify", { orderId: "PRINCIPLE-A:SO-A-009", jenis: "sales", alasan: "Dicabut lagi tanpa baris" })));
    assert.deepEqual([lagi.status, lagi.body.dicabut], [200, 0]);
    assert.equal((await q(`SELECT 1 FROM pencabutan_log WHERE jenis = 'invoice_verify_note'`)).length, 1);
});

test("PG: Cabut konfirmasi order ganda = DELETE + log; log gagal -> konfirmasi TIDAK terhapus", { skip: pgSkip }, async () => {
    const isi = () => pool.query(`INSERT INTO order_dupe_ack (principal, so_no, reason, note, confirmed_by)
        VALUES ('PRINCIPLE A', 'SO-A-001', 'Mirip SO-A-000', 'Sudah dicek ke SALES A', 'spv@contoh') ON CONFLICT DO NOTHING`);
    await isi();
    // Log yang gagal ditulis membatalkan DELETE-nya (satu transaksi), bukan pencabutan tanpa jejak.
    await pool.query(`ALTER TABLE pencabutan_log ADD CONSTRAINT uji_tolak CHECK (false) NOT VALID`);
    try {
        await assert.rejects(lingkup(() => m.ack.DELETE(minta("DELETE", URL_ACK, { alasan: "SO ini kiriman ulang order lama" }))));
    } finally {
        await pool.query(`ALTER TABLE pencabutan_log DROP CONSTRAINT uji_tolak`);
    }
    assert.equal((await q(`SELECT 1 FROM order_dupe_ack WHERE so_no = 'SO-A-001'`)).length, 1, "konfirmasi tetap ada");

    const r = await jawab(() => m.ack.DELETE(minta("DELETE", URL_ACK, { alasan: "SO ini kiriman ulang order lama" })));
    assert.deepEqual([r.status, r.body.dicabut], [200, 1], JSON.stringify(r.body));
    assert.equal((await q(`SELECT 1 FROM order_dupe_ack WHERE so_no = 'SO-A-001'`)).length, 0);
    const [log] = await q(`SELECT kunci, baris_lama, alasan, oleh FROM pencabutan_log WHERE jenis = 'order_dupe_ack'`);
    assert.deepEqual([log.kunci, log.alasan, log.oleh], ["PRINCIPLE A|SO-A-001", "SO ini kiriman ulang order lama", EMAIL]);
    assert.deepEqual([log.baris_lama.reason, log.baris_lama.note, log.baris_lama.confirmedBy], ["Mirip SO-A-000", "Sudah dicek ke SALES A", "spv@contoh"]);
});
