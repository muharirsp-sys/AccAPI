/* K1b (BL-59) status baca + cache pelunasan di Postgres EVALUASI (AM040_DATABASE_URL, bukan produksi). Tiap uji memakai SKEMA SEKALI-PAKAI
 * (search_path hanya skema itu, DROP di akhir). Diuji: entri migrate-pg dua kali (OK lalu SKIP), DDL_K1B.sql dua kali + VERIFIKASI, bentuk
 * DDL = migrate-pg = db/migrations/0031 = Drizzle, CHECK status, hak accapi_app (role sementara di transaksi yang di-ROLLBACK), tokoPg:
 * dua pengklaim -> satu menang, upsert idempoten + ganti baris faktur, token basi tak menimpa, pelaksana dengan simulator Accurate:
 * hapus CASCADE hanya saat daftar lengkap, galat tidak memundurkan lengkap_pada, muatPelunasanHari (sen), databaseIdSinkron.
 * Tanpa env dilewati dengan sebabnya. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { kasirPelunasanBaca } from "../../db/schema.ts";
import { bacaPelunasanHari, belumDibaca, databaseIdSinkron, muatPelunasanHari, tokoPg, type DepsBaca } from "./baca-pelunasan.ts";
import { KELAS_GALAT } from "./pembaca.ts";
import type { Pelunasan } from "./rekonsiliasi.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";

type Migration = { nama: string; sudahAda: string; sql: string };
const NAMA_K1A = "kasir (setoran, catatan, hari, cache pelunasan)";
const NAMA_K1B = "kasir_pelunasan_baca (status baca K1b)";
const D = "2026-10-05";
const DB = "DB-UJI";

async function entri(nama: string): Promise<Migration> {
    const mod = await import(new URL("../../scripts/migrate-pg.mjs", import.meta.url).href) as { migrations: Migration[] };
    const m = mod.migrations.find((x) => x.nama === nama);
    assert.ok(m, `entri migrate-pg ${nama}`);
    return m;
}
const berkas = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

async function denganSkema(fn: (pool: Pool, skema: string) => Promise<void>) {
    const skema = `uji_k1b_${randomUUID().slice(0, 8)}`;
    const admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${skema}`);
    const url = new URL(PG_URL);
    url.searchParams.set("options", `-c search_path=${skema}`);
    const pool = new Pool({ connectionString: url.toString(), max: 6 });
    try {
        await fn(pool, skema);
    } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${skema} CASCADE`);
        await admin.end();
    }
}
async function migrasi(pool: Pool, m: Migration) {
    if ((await pool.query(m.sudahAda)).rowCount) return `SKIP ${m.nama}`;
    await pool.query(m.sql);
    return `OK ${m.nama}`;
}
type Hasil = { rows: { cek: string; ok: boolean | null }[] };
const verifikasi = async (c: Pool | PoolClient, sql: string) => {
    const hasil = await c.query(sql) as unknown as Hasil | Hasil[];
    return Array.isArray(hasil) ? hasil[hasil.length - 1].rows : hasil.rows;
};
async function katalog(pool: Pool) {
    const kolom = await pool.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'kasir_pelunasan_baca' ORDER BY 1`);
    const constraint = await pool.query(`SELECT conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE connamespace = current_schema()::regnamespace AND conrelid::regclass::text = 'kasir_pelunasan_baca' ORDER BY 1`);
    const indeks = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'kasir_pelunasan_baca' ORDER BY 1`);
    return { kolom: kolom.rows, constraint: constraint.rows, indeks: indeks.rows };
}
const dialek = new PgDialect();
const teksSql = (v: unknown) => v === undefined || v === null ? "" : is(v, SQL) ? dialek.sqlToQuery(v).sql : String(v);
const normDefault = (s: string | null | undefined) => (s ?? "").replace(/[()\s'"]/g, "");
const kodeGalat = (kode: string) => (e: unknown) => (e as { code?: string }).code === kode;

/** Skema K1a (cache) + K1b (status) lewat entri migrate-pg. */
async function siapSkema(pool: Pool) {
    await migrasi(pool, await entri(NAMA_K1A));
    await migrasi(pool, await entri(NAMA_K1B));
}

test("PG K1b: migrate-pg dua kali OK lalu SKIP; DDL_K1B.sql dua kali + VERIFIKASI; bentuk DDL = migrate-pg = 0031 = Drizzle", { skip: pgSkip }, async () => {
    const m = await entri(NAMA_K1B);
    let bentuk: Awaited<ReturnType<typeof katalog>> | undefined;
    await denganSkema(async (pool) => {
        await migrasi(pool, await entri(NAMA_K1A));
        assert.equal(await migrasi(pool, m), `OK ${NAMA_K1B}`);
        assert.equal(await migrasi(pool, m), `SKIP ${NAMA_K1B}`);
        bentuk = await katalog(pool);
        await pool.query(m.sql);
        assert.deepEqual(await katalog(pool), bentuk, "SQL entri diulang tanpa perubahan");
        assert.deepEqual(bentuk.indeks.map((r) => r.indexname), ["kasir_pelunasan_baca_pkey"]);
    });
    await denganSkema(async (pool) => {
        await migrasi(pool, await entri(NAMA_K1A));
        const ddl = await berkas("../../docs/handover/DDL_K1B.sql");
        for (let i = 0; i < 2; i++) for (const v of await verifikasi(pool, ddl)) assert.notEqual(v.ok, false, `VERIFIKASI gagal: ${v.cek}`);
        assert.equal(await migrasi(pool, m), `SKIP ${NAMA_K1B}`, "migrate-pg melewati sesudah DDL manual");
        assert.deepEqual(await katalog(pool), bentuk, "DDL manual = entri migrate-pg");
    });
    await denganSkema(async (pool) => {
        await pool.query(await berkas("../../db/migrations/0031_kasir_baca.sql"));
        assert.deepEqual(await katalog(pool), bentuk, "db/migrations/0031 = entri migrate-pg");
        // Tanpa cache K1a: VERIFIKASI prasyarat = false (DDL_K1A wajib lebih dulu).
        const v = new Map((await verifikasi(pool, await berkas("../../docs/handover/DDL_K1B.sql"))).map((r) => [r.cek, r.ok]));
        assert.equal([...v].find(([cek]) => /prasyarat K1a/.test(cek))?.[1], false);
    });
    const cfg = getTableConfig(kasirPelunasanBaca);
    const tipe: Record<string, string> = { "timestamp with time zone": "timestamp with time zone", integer: "integer", jsonb: "jsonb", text: "text", date: "date" };
    assert.deepEqual(
        cfg.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES", c.hasDefault ? normDefault(teksSql(c.default)) : ""].join("|")).sort(),
        bentuk!.kolom.map((r) => [r.column_name, tipe[r.data_type] ?? r.data_type, r.is_nullable, normDefault(r.column_default)].join("|")).sort(),
        "kolom Drizzle = DB (nama|tipe|nullable|default)");
    assert.deepEqual(cfg.checks.map((c) => c.name).sort(), bentuk!.constraint.filter((r) => r.contype === "c").map((r) => r.conname).sort());
    assert.ok(cfg.primaryKeys.some((p) => p.getName() === "kasir_pelunasan_baca_pkey"));
});

test("PG K1b: CHECK status — konsisten (gagal ⇔ sebab, berjalan ⇔ token & tanpa selesai, lengkap = sisa 0 tanpa ditolak), sebab di daftar", { skip: pgSkip }, async () => {
    await denganSkema(async (pool) => {
        await siapSkema(pool);
        let n = 0;
        const sisip = (kolom: Record<string, unknown>) => {
            const isi = { database_id: DB, tanggal: new Date(Date.UTC(2026, 0, 1) + ++n * 86_400_000).toISOString().slice(0, 10), pemicu: "uji", ...kolom };
            const k = Object.keys(isi);
            return pool.query(`INSERT INTO kasir_pelunasan_baca (${k.join(", ")}) VALUES (${k.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(isi));
        };
        await sisip({ status: "berjalan", token: "t" });
        await sisip({ status: "lengkap", selesai_pada: "2026-10-05T10:00:00Z", lengkap_pada: "2026-10-05T10:00:00Z", jumlah_daftar: 3, sisa_detail: 0 });
        await sisip({ status: "sebagian", selesai_pada: "2026-10-05T10:00:00Z", jumlah_daftar: 3, sisa_detail: 2 });
        await sisip({ status: "sebagian", selesai_pada: "2026-10-05T10:00:00Z" }); // batas waktu saat daftar: angka belum ada
        for (const sebab of KELAS_GALAT) await sisip({ status: "gagal", sebab, selesai_pada: "2026-10-05T10:00:00Z" }); // daftar TS = CHECK SQL
        const tolak = async (kolom: Record<string, unknown>, apa: string) => assert.rejects(sisip(kolom), kodeGalat("23514"), apa);
        await tolak({ status: "selesai", selesai_pada: "2026-10-05T10:00:00Z" }, "status di luar daftar");
        await tolak({ status: "gagal", selesai_pada: "2026-10-05T10:00:00Z" }, "gagal tanpa sebab");
        await tolak({ status: "sebagian", sebab: "terpotong", selesai_pada: "2026-10-05T10:00:00Z" }, "sebab pada bukan-gagal");
        await tolak({ status: "gagal", sebab: "lain", selesai_pada: "2026-10-05T10:00:00Z" }, "sebab di luar KELAS_GALAT");
        await tolak({ status: "berjalan" }, "berjalan tanpa token");
        await tolak({ status: "lengkap", token: "t", selesai_pada: "2026-10-05T10:00:00Z", lengkap_pada: "2026-10-05T10:00:00Z", jumlah_daftar: 0, sisa_detail: 0 }, "token sesudah selesai");
        await tolak({ status: "sebagian" }, "selesai tanpa selesai_pada");
        await tolak({ status: "lengkap", selesai_pada: "2026-10-05T10:00:00Z", lengkap_pada: "2026-10-05T10:00:00Z", jumlah_daftar: 3, sisa_detail: 1 }, "lengkap dengan sisa");
        await tolak({ status: "lengkap", selesai_pada: "2026-10-05T10:00:00Z", lengkap_pada: "2026-10-05T10:00:00Z", jumlah_daftar: 3 }, "lengkap tanpa sisa (NULL tidak lolos)");
        await tolak({ status: "lengkap", selesai_pada: "2026-10-05T10:00:00Z", lengkap_pada: "2026-10-05T10:00:00Z", jumlah_daftar: 3, sisa_detail: 0,
            ditolak: JSON.stringify([{ nomor: "SR/1" }]) }, "lengkap dengan ditolak");
        await tolak({ status: "lengkap", selesai_pada: "2026-10-05T10:00:00Z", jumlah_daftar: 3, sisa_detail: 0 }, "lengkap tanpa lengkap_pada");
        await tolak({ status: "sebagian", selesai_pada: "2026-10-05T10:00:00Z", jumlah_daftar: 3, sisa_detail: 4 }, "sisa > daftar");
        await tolak({ status: "berjalan", token: "t", ditolak: "{}" }, "ditolak harus larik");
        await tolak({ status: "berjalan", token: "t", pemicu: " " }, "pemicu kosong");
    });
});

test("PG K1b: hak accapi_app (role sementara, transaksi di-ROLLBACK) — status SELECT/INSERT/UPDATE tanpa DELETE; cache DML", { skip: pgSkip }, async () => {
    const tanpaTransaksi = (s: string) => s.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
    const ddlA = tanpaTransaksi(await berkas("../../docs/handover/DDL_K1A.sql"));
    const ddlB = tanpaTransaksi(await berkas("../../docs/handover/DDL_K1B.sql"));
    assert.ok(!/^(BEGIN|COMMIT);$/m.test(ddlB), "DDL_K1B punya tepat satu BEGIN/COMMIT");
    await denganSkema(async (pool, skema) => {
        const c = await pool.connect();
        try {
            await c.query("BEGIN");
            if (!(await c.query("SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app'")).rowCount) await c.query("CREATE ROLE accapi_app NOLOGIN");
            await c.query(`GRANT USAGE ON SCHEMA ${skema} TO accapi_app`);
            await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${skema} GRANT ALL ON TABLES TO accapi_app`); // REVOKE di berkas wajib mencabut
            await verifikasi(c, ddlA);
            const v = new Map((await verifikasi(c, ddlB)).map((r) => [r.cek, r.ok]));
            for (const [cek, ok] of v) assert.equal(ok, true, `VERIFIKASI ${cek}`);
            await c.query("SET LOCAL ROLE accapi_app");
            await c.query(`INSERT INTO kasir_pelunasan_baca (database_id, tanggal, status, token, pemicu) VALUES ('DB-1', '2026-10-05', 'berjalan', 't', 'uji')`);
            await c.query(`UPDATE kasir_pelunasan_baca SET status = 'gagal', sebab = 'jaringan', token = NULL, selesai_pada = now()`);
            await c.query(`INSERT INTO kasir_pelunasan (database_id, pelunasan_id, nomor, tanggal, metode, cheque_amount) VALUES ('DB-1', 1, 'SR/1', '2026-10-05', 'CASH_OTHER', 1)`);
            await c.query(`DELETE FROM kasir_pelunasan`);
            for (const sql of ["DELETE FROM kasir_pelunasan_baca", "TRUNCATE kasir_pelunasan_baca"]) {
                await c.query("SAVEPOINT s");
                await assert.rejects(c.query(sql), kodeGalat("42501"), `accapi_app: ${sql} ditolak`);
                await c.query("ROLLBACK TO SAVEPOINT s");
            }
        } finally {
            await c.query("ROLLBACK");
            c.release();
        }
        assert.equal((await pool.query("SELECT to_regclass('kasir_pelunasan_baca') AS r")).rows[0].r, null, "transaksi uji benar-benar di-ROLLBACK");
    });
});

const pel = (id: number, faktur: [number, number | null, number][], cheque = 1000): Pelunasan => ({
    id, nomor: `SR/${id}`, tanggal: D, metode: "CASH_OTHER", chequeAmount: cheque * 100,
    faktur: faktur.map(([fakturId, masterSalesmanId, rp]) => ({ fakturId, nomorFaktur: `INV/${fakturId}`, masterSalesmanId, invoicePayment: rp * 100 })),
});

test("PG K1b tokoPg: dua pengklaim -> satu menang; upsert idempoten + baris faktur DIGANTI; token basi tak menimpa; jeda lengkap", { skip: pgSkip }, async () => {
    await denganSkema(async (pool) => {
        await siapSkema(pool);
        const toko = tokoPg(drizzle(pool));
        const klaim = (token: string, penuh = false) => toko.klaim({ databaseId: DB, tanggal: D, token, pemicu: "uji", penuh, akun: "u-sinkron" });
        const [a, b] = await Promise.all([klaim("A"), klaim("B")]);
        assert.equal([a, b].filter((x) => x.diklaim).length, 1, "tepat satu menang");
        const menang = a.diklaim ? "A" : "B";
        const kalah = a.diklaim ? b : a;
        assert.ok(!kalah.diklaim && kalah.status.status === "berjalan" && kalah.status.aktif);

        assert.equal(await toko.tulis(menang, DB, pel(1, [[10, 4652, 600], [11, null, 400]]), "05/10/2026 09:00:00"), true);
        assert.equal(await toko.tulis(menang, DB, pel(1, [[10, 4652, 600], [11, null, 400]]), "05/10/2026 09:00:00"), true, "ulang = idempoten");
        const baris = async () => (await pool.query(`SELECT faktur_id::int AS f, master_salesman_id::int AS s, invoice_payment FROM kasir_pelunasan_faktur ORDER BY 1`)).rows;
        assert.deepEqual(await baris(), [{ f: 10, s: 4652, invoice_payment: "600.00" }, { f: 11, s: null, invoice_payment: "400.00" }]);
        assert.equal(await toko.tulis(menang, DB, pel(1, [[12, 7, 1000.55]], 1000.55), "05/10/2026 09:30:00"), true);
        assert.deepEqual(await baris(), [{ f: 12, s: 7, invoice_payment: "1000.55" }], "baris faktur lama diganti, bukan ditumpuk");
        assert.deepEqual((await pool.query(`SELECT count(*)::int AS n, max(cheque_amount) AS c, max(last_update) AS lu FROM kasir_pelunasan`)).rows[0],
            { n: 1, c: "1000.55", lu: "05/10/2026 09:30:00" });

        // Lease kedaluwarsa (pembaca mati) -> pengklaim baru menang; token lama tak bisa menulis / menghapus / menutup.
        await pool.query(`UPDATE kasir_pelunasan_baca SET mulai_pada = now() - interval '3 minutes'`);
        assert.equal((await klaim("C")).diklaim, true);
        assert.equal(await toko.tulis(menang, DB, pel(1, [[99, 1, 1]], 1), "basi"), false);
        assert.equal(await toko.hapus(menang, DB, D, [1]), false);
        assert.equal(await toko.tandaiBasi(menang, DB, D), false);
        assert.equal(await toko.selesai(menang, DB, D, { status: "lengkap", sebab: null, pesan: null, jumlahDaftar: 1, sisaDetail: 0 }, [], "u-sinkron"), null);
        assert.deepEqual(await baris(), [{ f: 12, s: 7, invoice_payment: "1000.55" }], "token basi tidak menimpa");
        const s = await toko.selesai("C", DB, D, { status: "lengkap", sebab: null, pesan: null, jumlahDaftar: 1, sisaDetail: 0 }, [], "u-sinkron");
        assert.ok(s && s.status === "lengkap" && s.lengkapPada && !s.aktif);
        const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
        assert.match(s.lengkapPada!, ISO, "lengkapPada ISO UTC, bukan teks PG");
        assert.match(s.mulaiPada!, ISO);
        assert.match(s.selesaiPada!, ISO);
        assert.equal(s.akunSinkron, "u-sinkron", "akun sinkron pembaca dicatat");
        assert.deepEqual(await toko.nomor(DB, [1, 999]), new Map([[1, "SR/1"]]));
        const jeda = await klaim("D");
        assert.ok(!jeda.diklaim && jeda.status.status === "lengkap", "lengkap < 60 dtk: tidak diklaim");
        assert.equal((await klaim("E", true)).diklaim, true, "penuh mengabaikan jeda");
    });
});

/** Simulator Accurate kecil (fetch tiruan) untuk pelaksana di atas tokoPg. */
function accurate(data: { id: number; lastUpdate: string; salesman?: number }[], rusakDaftar = () => false): DepsBaca["fetch"] {
    return async (url) => {
        const u = new URL(url);
        if (u.pathname.endsWith("/list.do")) {
            if (rusakDaftar()) return new Response(JSON.stringify({ s: true, d: [], sp: { rowCount: data.length } }));
            return new Response(JSON.stringify({ s: true, d: data.map((x) => ({ id: x.id, number: `SR/${x.id}`, transDate: "05/10/2026", lastUpdate: x.lastUpdate })),
                sp: { rowCount: data.length, pageCount: data.length ? 1 : 0 } }));
        }
        const x = data.find((y) => y.id === Number(u.searchParams.get("id")))!;
        return new Response(JSON.stringify({ s: true, d: { id: x.id, number: `SR/${x.id}`, transDate: "05/10/2026", paymentMethod: "BANK_TRANSFER",
            chequeAmount: 250000.5, detailInvoice: [{ invoice: { id: x.id * 10, number: `INV/${x.id}`, masterSalesmanId: x.salesman ?? 11 }, invoicePayment: 250000.5 }] } }));
    };
}

test("PG K1b pelaksana + tokoPg: lengkap, hapus CASCADE hanya saat daftar lengkap, galat tak memundurkan lengkap_pada, muatPelunasanHari", { skip: pgSkip }, async () => {
    await denganSkema(async (pool) => {
        await siapSkema(pool);
        const d = drizzle(pool);
        const data = [{ id: 1, lastUpdate: "a" }, { id: 2, lastUpdate: "b" }, { id: 3, lastUpdate: "c" }];
        let rusak = false;
        let n = 0;
        const deps: DepsBaca = { kredensial: async () => ({ creds: { sessionHost: "https://sim.accurate.invalid", sessionId: "S", apiKey: "T", databaseId: DB } }),
            sesi: async () => ({ userId: "u-sinkron", databaseId: DB }), nama: async () => new Map(),
            toko: () => tokoPg(d), fetch: accurate(data, () => rusak), tidur: async () => undefined, sekarang: () => Date.now(), token: () => `tok-${++n}` };
        const baca = (penuh = false) => bacaPelunasanHari({ tanggal: D, pemicu: "uji", penuh }, deps);
        const h1 = await baca();
        assert.ok(h1.jenis === "selesai" && h1.status.status === "lengkap", JSON.stringify(h1));
        const lengkapPada = h1.status.lengkapPada;
        const muat = await muatPelunasanHari(DB, D, d);
        assert.equal(muat.status.status, "lengkap");
        assert.deepEqual(muat.pelunasan[0], { id: 1, nomor: "SR/1", tanggal: D, metode: "BANK_TRANSFER", chequeAmount: 25000050,
            faktur: [{ fakturId: 10, nomorFaktur: "INV/1", masterSalesmanId: 11, invoicePayment: 25000050 }] });
        assert.equal(muat.pelunasan.length, 3);
        assert.deepEqual(await muatPelunasanHari(DB, "2026-10-06", d), { status: belumDibaca(DB, "2026-10-06"), pelunasan: [] });

        // Accurate menghapus id 2, daftarnya RUSAK (terpotong) -> gagal, tidak ada yang terhapus, lengkap_pada tetap.
        data.splice(1, 1);
        rusak = true;
        const h2 = await baca(true);
        assert.ok(h2.jenis === "selesai" && h2.status.status === "gagal" && h2.status.sebab === "terpotong");
        assert.equal(h2.status.lengkapPada, lengkapPada, "galat tidak memundurkan lengkap_pada");
        assert.deepEqual((await pool.query(`SELECT count(*)::int AS k, (SELECT count(*)::int FROM kasir_pelunasan_faktur) AS f FROM kasir_pelunasan`)).rows[0],
            { k: 3, f: 3 }, "daftar terpotong tidak menghapus");
        // Daftar kembali lengkap -> id 2 dihapus, baris fakturnya ikut (CASCADE).
        rusak = false;
        const h3 = await baca(true);
        assert.ok(h3.jenis === "selesai" && h3.status.status === "lengkap");
        assert.deepEqual((await pool.query(`SELECT array_agg(pelunasan_id::int ORDER BY pelunasan_id) AS k, (SELECT count(*)::int FROM kasir_pelunasan_faktur) AS f
            FROM kasir_pelunasan`)).rows[0], { k: [1, 3], f: 2 });
        assert.ok(h3.status.lengkapPada! > lengkapPada!, "lengkap_pada maju");

        // Butir 1: lengkap 3 jam lalu, lalu sesi sinkron MATI -> status gagal/sesi_sinkron tersimpan, lengkap_pada TIDAK dimundurkan.
        await pool.query(`UPDATE kasir_pelunasan_baca SET selesai_pada = now() - interval '3 hours', lengkap_pada = now() - interval '3 hours'`);
        const lengkap3jam = (await muatPelunasanHari(DB, D, d)).status.lengkapPada;
        const mati = await bacaPelunasanHari({ tanggal: D, pemicu: "cron" }, { ...deps, kredensial: async () => ({ error: "token kedaluwarsa" }) });
        assert.ok(mati.jenis === "kredensial" && mati.status, JSON.stringify(mati));
        const sesudah = (await muatPelunasanHari(DB, D, d));
        assert.deepEqual([sesudah.status.status, sesudah.status.sebab, sesudah.status.lengkapPada, sesudah.pelunasan.length],
            ["gagal", "sesi_sinkron", lengkap3jam, 2], "tidak lagi lengkap; riwayat lengkap_pada & cache utuh");
    });
});

test("PG K1b databaseIdSinkron: ACCURATE_SYNC_USER_ID, atau sesi TERBARU milik admin (bukan sesi terbaru siapa pun) — tanpa Accurate", { skip: pgSkip }, async () => {
    await denganSkema(async (pool) => {
        await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY, role text);
            CREATE TABLE accurate_oauth_session (user_id text PRIMARY KEY, access_token text NOT NULL, session_host text, session_id text, database_id text,
                database_alias text, created_at timestamp NOT NULL, updated_at timestamp NOT NULL);
            INSERT INTO "user" VALUES ('u-admin', 'admin'), ('u-staf', 'staff');
            INSERT INTO accurate_oauth_session VALUES ('u-admin', 'x', NULL, NULL, '111', NULL, now(), now() - interval '1 day'),
                ('u-staf', 'x', NULL, NULL, '222', NULL, now(), now());`);
        const d = drizzle(pool);
        const env = process.env.ACCURATE_SYNC_USER_ID;
        try {
            delete process.env.ACCURATE_SYNC_USER_ID;
            assert.equal(await databaseIdSinkron(d), "111", "sesi staf yang lebih baru tidak merebut identitas");
            process.env.ACCURATE_SYNC_USER_ID = "u-staf";
            assert.equal(await databaseIdSinkron(d), "222");
            process.env.ACCURATE_SYNC_USER_ID = "u-tidak-ada";
            assert.equal(await databaseIdSinkron(d), "");
        } finally {
            if (env === undefined) delete process.env.ACCURATE_SYNC_USER_ID;
            else process.env.ACCURATE_SYNC_USER_ID = env;
        }
    });
});

test("PG K1b penjaga hapus massal: 6 dari 12 hilang -> tidak dihapus, ditolak memuat NOMOR dari cache; konfirmasi menghapus", { skip: pgSkip }, async () => {
    await denganSkema(async (pool) => {
        await siapSkema(pool);
        const d = drizzle(pool);
        const data = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, lastUpdate: `l${i}` }));
        let n = 0;
        const deps: DepsBaca = { kredensial: async () => ({ creds: { sessionHost: "https://sim.accurate.invalid", sessionId: "S", apiKey: "T", databaseId: DB } }),
            sesi: async () => ({ userId: "u-sinkron", databaseId: DB }), nama: async () => new Map(),
            toko: () => tokoPg(d), fetch: accurate(data), tidur: async () => undefined, sekarang: () => Date.now(), token: () => `tok-${++n}` };
        await bacaPelunasanHari({ tanggal: D, pemicu: "uji" }, deps);
        data.splice(0, 6);
        const h = await bacaPelunasanHari({ tanggal: D, pemicu: "uji", penuh: true }, deps);
        assert.ok(h.jenis === "selesai" && h.status.status === "gagal" && h.status.sebab === "hapus_massal", JSON.stringify(h));
        assert.deepEqual(h.status.ditolak.map((x) => x.nomor), ["SR/1", "SR/2", "SR/3", "SR/4", "SR/5", "SR/6"]);
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM kasir_pelunasan`)).rows[0].n, 12);
        const ok = await bacaPelunasanHari({ tanggal: D, pemicu: "uji", penuh: true, konfirmasiHapus: true }, deps);
        assert.ok(ok.jenis === "selesai" && ok.status.status === "lengkap");
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM kasir_pelunasan`)).rows[0].n, 6);
    });
});

test("PG K1b DDL: VERIFIKASI membandingkan DEFINISI CHECK (CHECK (true) bernama sama = false); tabel versi awal tanpa akun_sinkron dilengkapi", { skip: pgSkip }, async () => {
    const ddl = await berkas("../../docs/handover/DDL_K1B.sql");
    const cekVerifikasi = ddl.slice(ddl.indexOf("-- 3. VERIFIKASI"));
    await denganSkema(async (pool) => {
        await migrasi(pool, await entri(NAMA_K1A));
        for (const v of await verifikasi(pool, ddl)) assert.notEqual(v.ok, false, `VERIFIKASI awal: ${v.cek}`);
        for (const nama of ["kasir_pelunasan_baca_status", "kasir_pelunasan_baca_sebab", "kasir_pelunasan_baca_isi", "kasir_pelunasan_baca_konsisten"]) {
            await pool.query(`ALTER TABLE kasir_pelunasan_baca DROP CONSTRAINT ${nama}, ADD CONSTRAINT ${nama} CHECK (true)`);
            const v = new Map((await verifikasi(pool, cekVerifikasi)).map((r) => [r.cek, r.ok]));
            assert.equal([...v].find(([cek]) => /definisi persis/.test(cek))?.[1], false, `${nama} = CHECK (true) harus tertangkap`);
            await pool.query("DROP TABLE kasir_pelunasan_baca");
            await verifikasi(pool, ddl); // pulihkan
        }
    });
    await denganSkema(async (pool) => {
        // Tabel VERSI AWAL K1b (hanya pernah ada di DB uji): tanpa akun_sinkron/penuh_tertunda_pada DAN CHECK sebab lama (tanpa hapus_massal).
        // EXPAND hanya menambah KOLOM; CHECK lama TETAP -> VERIFIKASI "definisi persis" false -> runbook: DROP TABLE lalu jalankan ulang.
        await migrasi(pool, await entri(NAMA_K1A));
        const versiAwal = (await entri(NAMA_K1B)).sql.replace(/\n\s*akun_sinkron\s+text,/, "").replace(/\n\s*penuh_tertunda_pada\s+timestamptz,/, "")
            .replace(", 'hapus_massal'", "").replace(/ALTER TABLE[^;]*;/g, "");
        assert.ok(!versiAwal.includes("hapus_massal") && !versiAwal.includes("akun_sinkron"));
        await pool.query(versiAwal);
        assert.equal(await migrasi(pool, await entri(NAMA_K1B)), `OK ${NAMA_K1B}`, "sudahAda (pg_attribute) melihat kolom yang kurang");
        assert.equal(await migrasi(pool, await entri(NAMA_K1B)), `SKIP ${NAMA_K1B}`, "kolom ditambahkan (EXPAND kolom)");
        const ddlB = await berkas("../../docs/handover/DDL_K1B.sql");
        const v = new Map((await verifikasi(pool, ddlB)).map((r) => [r.cek, r.ok]));
        assert.equal([...v].find(([cek]) => /definisi persis/.test(cek))?.[1], false, "CHECK sebab lama TIDAK diperluas — tertangkap VERIFIKASI");
        await pool.query("DROP TABLE kasir_pelunasan_baca"); // runbook versi awal
        for (const r of await verifikasi(pool, ddlB)) assert.notEqual(r.ok, false, `sesudah DROP + DDL ulang: ${r.cek}`);
    });
});

test("PG K1b klaim ulang oleh AKUN BERBEDA: akunLama dikembalikan, akun_sinkron tidak ditimpa klaim; hapus 1 baris ditahan sampai konfirmasi", { skip: pgSkip }, async () => {
    await denganSkema(async (pool) => {
        await siapSkema(pool);
        const d = drizzle(pool);
        const toko = tokoPg(d);
        const data = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, lastUpdate: `l${i}` }));
        let n = 0;
        let akun = "u-sinkron";
        const deps: DepsBaca = { kredensial: async () => ({ creds: { sessionHost: "https://sim.accurate.invalid", sessionId: "S", apiKey: "T", databaseId: DB } }),
            sesi: async () => ({ userId: akun, databaseId: DB }), nama: async () => new Map(),
            toko: () => toko, fetch: accurate(data), tidur: async () => undefined, sekarang: () => Date.now(), token: () => `tok-${++n}` };
        await bacaPelunasanHari({ tanggal: D, pemicu: "uji" }, deps);
        const k = await toko.klaim({ databaseId: DB, tanggal: D, token: "X", pemicu: "uji", penuh: true, akun: "u-lain" });
        assert.ok(k.diklaim && k.akunLama === "u-sinkron" && !k.penuhTertunda, JSON.stringify(k));
        assert.equal((await toko.status(DB, D)).akunSinkron, "u-sinkron", "klaim tidak menimpa akun_sinkron");
        await toko.selesai("X", DB, D, { status: "sebagian", sebab: null, pesan: null, jumlahDaftar: null, sisaDetail: null }, [], k.akunLama);
        akun = "u-lain";
        data.splice(0, 1);
        const h = await bacaPelunasanHari({ tanggal: D, pemicu: "uji", penuh: true }, deps);
        assert.ok(h.jenis === "selesai" && h.status.sebab === "hapus_massal" && h.status.akunSinkron === "u-sinkron", JSON.stringify(h));
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM kasir_pelunasan`)).rows[0].n, 4);
        const ok = await bacaPelunasanHari({ tanggal: D, pemicu: "uji", penuh: true, konfirmasiHapus: true }, deps);
        assert.ok(ok.jenis === "selesai" && ok.status.status === "lengkap" && ok.status.akunSinkron === "u-lain");
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM kasir_pelunasan`)).rows[0].n, 3);
    });
});

test("PG K1b PENUH_TERTUNDA: dicatat tanpa menyentuh lease, terlihat (ISO), membuka jeda lengkap untuk klaim berikut, dikosongkan tandaiBasi", { skip: pgSkip }, async () => {
    await denganSkema(async (pool) => {
        await siapSkema(pool);
        const toko = tokoPg(drizzle(pool));
        assert.ok((await toko.klaim({ databaseId: DB, tanggal: D, token: "T1", pemicu: "manual:u-k", penuh: false, akun: "u-sinkron" })).diklaim);
        await toko.tandaiPenuhTertunda(DB, D);
        const s1 = await toko.status(DB, D);
        assert.ok(s1.status === "berjalan" && s1.aktif && /Z$/.test(s1.penuhTertundaPada ?? ""), JSON.stringify(s1));
        await toko.selesai("T1", DB, D, { status: "lengkap", sebab: null, pesan: null, jumlahDaftar: 0, sisaDetail: 0 }, [], "u-sinkron");
        const k = await toko.klaim({ databaseId: DB, tanggal: D, token: "T2", pemicu: "cron", penuh: false, akun: "u-sinkron" });
        assert.ok(k.diklaim && k.penuhTertunda, "lengkap < 60 dtk tidak menahan baca penuh yang tertunda");
        assert.equal(await toko.tandaiBasi("T2", DB, D), true);
        assert.equal((await toko.status(DB, D)).penuhTertundaPada, null);
    });
});

test("PG K1b migrate-pg sudahAda lewat katalog: role TANPA hak tabel tetap melihat tabel sudah ada (bukan crash loop ALTER 42501)", { skip: pgSkip }, async () => {
    const m = await entri(NAMA_K1B);
    await denganSkema(async (pool, skema) => {
        await siapSkema(pool);
        const c = await pool.connect();
        try {
            await c.query("BEGIN");
            await c.query("CREATE ROLE uji_k1b_tanpa_hak NOLOGIN");
            await c.query(`GRANT USAGE ON SCHEMA ${skema} TO uji_k1b_tanpa_hak`);
            await c.query("REVOKE ALL ON kasir_pelunasan_baca FROM uji_k1b_tanpa_hak");
            await c.query("SET LOCAL ROLE uji_k1b_tanpa_hak");
            assert.equal((await c.query(m.sudahAda)).rowCount, 1, "sudahAda = 1 tanpa hak tabel");
        } finally {
            await c.query("ROLLBACK");
            c.release();
        }
    });
});
