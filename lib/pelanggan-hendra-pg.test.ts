/* Limit pelanggan "Hendra" (owner 17 Nov 2026) di Postgres EVALUASI (AM040_DATABASE_URL, bukan produksi): SKEMA SEKALI-PAKAI (customer
 * disalin `LIKE public.customer` + db/migrations/0044; search_path hanya skema itu; DROP di akhir). Membuktikan jalur yang tidak terjangkau uji
 * murni: webhook upsertMasterById -> upsertPage customer -> pengamat (limit_menit_simpan + limit_hendra_ubah), pemulih lewat adapter
 * Postgres (klaim/selesai/hitungMenit) dengan Accurate tiruan, simpanan pemulih sendiri = `sistem`, edit satuan dibiarkan, migrate-pg SKIP.
 * Tanpa env dilewati. Data contoh generik. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";
const skema = `uji_hendra_${randomUUID().slice(0, 8)}`;
let admin: Pool;
let pool: Pool;
const urlSkema = () => { const u = new URL(PG_URL); u.searchParams.set("options", `-c search_path=${skema}`); return u.toString(); };
const berkas = (p: string) => readFile(new URL(p, import.meta.url), "utf8");
let sync: typeof import("./sync.ts");
let hendra: typeof import("./pelanggan-hendra.ts");

const CREDS = { sessionHost: "https://accurate.uji", sessionId: "s", apiKey: "k", databaseId: "1" };
const TARGET = { sessionHost: CREDS.sessionHost, sessionId: "s", accessToken: "k" };
type Baris = Record<string, unknown>;
let detail: Record<number, Baris> = {};
const kiriman: { path: string; body: unknown }[] = [];
const fetchAsli = globalThis.fetch;

const pelanggan = (id: number, lastUpdate: string, nilai: number, notes = "", hari = 28) => ({
    id, customerNo: id === 22001 ? "C-PEL017-FR" : `C-UJI${id}`, name: `TOKO ${id}`, notes, lastUpdate,
    customerLimitAmount: true, customerLimitAmountValue: nilai, customerLimitAge: true, customerLimitAgeValue: hari,
});

before(async () => {
    if (!PG_URL) return;
    admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${skema}`);
    await admin.query(`CREATE TABLE ${skema}.customer (LIKE public.customer INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    pool = new Pool({ connectionString: urlSkema(), max: 2 });
    await pool.query(await berkas("../db/migrations/0044_limit_hendra.sql"));
    await pool.query(await berkas("../db/migrations/0044_limit_hendra.sql")); // jalan ulang = tanpa perubahan
    // Keadaan 10 Nov: C-PEL017-FR limit 445rb (Hendra) + 25 pelanggan lain.
    for (const p of [pelanggan(22001, "10/11/2026 09:00:00", 445000, "Hendra"), ...Array.from({ length: 25 }, (_, i) => pelanggan(i + 1, "10/11/2026 09:00:00", 1000))]) {
        await pool.query(`INSERT INTO customer (id, "customerNo", name, credit_limit_enabled, credit_limit_amount, credit_age_limit_enabled, credit_age_limit_days,
            raw_data, last_update) VALUES ($1, $2, $3, true, $4, true, 28, to_jsonb($5::text), $6)`, [p.id, p.customerNo, p.name, p.customerLimitAmountValue, JSON.stringify(p), p.lastUpdate]);
    }
    process.env.DATABASE_URL = urlSkema();
    sync = await import("./sync.ts");
    hendra = await import("./pelanggan-hendra.ts");
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const u = new URL(String(url));
        kiriman.push({ path: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (u.pathname.endsWith("/customer/detail.do")) return new Response(JSON.stringify({ s: true, d: detail[Number(u.searchParams.get("id"))] }), { status: 200 });
        if (u.pathname.endsWith("/customer/save.do")) return new Response(JSON.stringify({ s: true, d: ["berhasil disimpan"] }), { status: 200 });
        if (u.pathname.endsWith("/customer/list.do")) return new Response(JSON.stringify({ s: true, d: [], sp: { rowCount: 1 } }), { status: 200 });
        return new Response("{}", { status: 404 });
    }) as typeof fetch;
});

after(async () => {
    if (!PG_URL) return;
    globalThis.fetch = fetchAsli;
    await (await import("./db.ts")).pool.end().catch(() => undefined);
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${skema} CASCADE`);
    await admin.end();
});

const ubah = async () => (await pool.query(`SELECT customer_id, last_update, lama, baru, status FROM limit_hendra_ubah ORDER BY id`)).rows;
const menit = async (m: string) => Number((await pool.query(`SELECT jumlah FROM limit_menit_simpan WHERE menit = $1`, [m])).rows[0]?.jumlah ?? 0);

test("PG Hendra: impor (26 simpanan 10:22) teramati lewat webhook -> peristiwa; pemulih mengembalikan 445rb; simpanan sendiri = sistem; edit satuan dibiarkan", { skip: pgSkip }, async () => {
    // 1) Impor 13 Nov 10:22: semua pelanggan disimpan ulang; C-PEL017-FR turun ke 200rb.
    detail = { 22001: pelanggan(22001, "13/11/2026 10:22:36", 200000, "Hendra") };
    for (let i = 1; i <= 25; i++) detail[i] = pelanggan(i, `13/11/2026 10:22:${String(10 + i).padStart(2, "0")}`, 200000);
    for (const id of [22001, ...Array.from({ length: 25 }, (_, i) => i + 1)]) await sync.upsertMasterById("customer", id, CREDS);
    assert.equal(await menit("13/11/2026 10:22"), 26);
    for (const id of [22001, 3]) await sync.upsertMasterById("customer", id, CREDS); // webhook ulang = tidak dihitung dua kali
    assert.equal(await menit("13/11/2026 10:22"), 26);
    assert.deepEqual((await ubah()).map((r) => [Number(r.customer_id), r.status, r.lama.nilai, r.baru.nilai]), [[22001, "baru", 445000, 200000]]);

    // 2) Pemulih: menit ramai -> save.do berisi id + 4 kolom limit saja, peristiwa `dipulihkan`.
    kiriman.length = 0;
    const h = await hendra.jalankanPulihLimitHendra(TARGET);
    assert.ok(!("mati" in h));
    if (!("mati" in h)) assert.deepEqual(h.dipulihkan, ["C-PEL017-FR (13/11/2026 10:22:36)"]);
    const save = kiriman.filter((k) => k.path.endsWith("/customer/save.do"));
    assert.deepEqual(save.map((k) => k.body), [{ id: 22001, customerLimitAmount: true, customerLimitAmountValue: 445000, customerLimitAge: true, customerLimitAgeValue: 28 }]);
    assert.equal((await ubah())[0].status, "dipulihkan");

    // 3) Webhook atas simpanan pemulih sendiri: `sistem`, menit itu tidak dihitung, jalan berikut tidak menulis apa pun.
    detail[22001] = pelanggan(22001, "17/11/2026 13:30:00", 445000, "Hendra");
    await sync.upsertMasterById("customer", 22001, CREDS);
    assert.equal((await ubah())[1].status, "sistem");
    assert.equal(await menit("17/11/2026 13:30"), 0);
    kiriman.length = 0;
    await hendra.jalankanPulihLimitHendra(TARGET);
    assert.equal(kiriman.filter((k) => k.path.endsWith("/customer/save.do")).length, 0);

    // 4) Edit satuan (Hendra menaikkan ke 900rb sendirian): dibiarkan, tidak ditulis.
    detail[22001] = pelanggan(22001, "16/11/2026 08:00:10", 900000, "Hendra");
    await sync.upsertMasterById("customer", 22001, CREDS);
    kiriman.length = 0;
    const h2 = await hendra.jalankanPulihLimitHendra(TARGET);
    if (!("mati" in h2)) assert.deepEqual(h2.dibiarkan, ["C-PEL017-FR (16/11/2026 08:00:10)"]);
    assert.equal(kiriman.filter((k) => k.path.endsWith("/customer/save.do")).length, 0);
    assert.equal((await ubah()).at(-1)!.status, "dibiarkan");
});

test("PG Hendra: entri migrate-pg 'limit hendra' = SKIP sesudah 0044", { skip: pgSkip }, async () => {
    const { migrations } = await import("../scripts/migrate-pg.mjs") as { migrations: { nama: string; sudahAda: string }[] };
    const m = migrations.find((x) => x.nama === "limit hendra");
    assert.ok(m, "entri migrate-pg ada");
    assert.equal((await pool.query(m!.sudahAda)).rowCount, 1);
});
