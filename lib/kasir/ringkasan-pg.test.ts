/* K3 (BL-59) ringkasan Kasir di Postgres EVALUASI (AM040_DATABASE_URL, bukan produksi); skema sekali-pakai per uji (pola hari-pg.test.ts).
 * Diuji: angka tile = angka layar /kasir (muatHari) pada data yang SAMA (selisih orang, ember, belum setor, hari belum ditutup per tanggal
 * lawan muatHari().hari.sebab); BACA-SAJA (muatHari sesudah 20.00 menulis event `kunci`, muatRingkasan tidak); Incaso belum lengkap
 * (sebagian / gagal / berjalan / belum dibaca / tanpa database) = null, bukan nol; `lengkap` tua tetap angka (sama dengan layar).
 * Tanpa env dilewati. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { catatSetoran, jelaskan, muatHari, type DepsHari, type IsianSetoran } from "./hari.ts";
import { jendelaTutup, muatRingkasan } from "./ringkasan.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";

type Migration = { nama: string; sudahAda: string; sql: string };
const D = "2026-10-12"; // Senin
const DB = "DB-UJI";
const KASIR = "u-kasir";
const wita = (t: string) => new Date(`${t}+08:00`);
const berkas = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

async function entri(nama: string): Promise<Migration> {
    const mod = await import(new URL("../../scripts/migrate-pg.mjs", import.meta.url).href) as { migrations: Migration[] };
    const m = mod.migrations.find((x) => x.nama === nama);
    assert.ok(m, `entri migrate-pg ${nama}`);
    return m;
}

async function denganSkema(fn: (pool: Pool) => Promise<void>) {
    const skema = `uji_k3_${randomUUID().slice(0, 8)}`;
    const admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${skema}`);
    const url = new URL(PG_URL);
    url.searchParams.set("options", `-c search_path=${skema}`);
    const pool = new Pool({ connectionString: url.toString(), max: 4 });
    try {
        await pool.query(await berkas("../../docs/handover/DDL_K1A.sql"));
        for (const nama of ["kasir_pelunasan_baca (status baca K1b)", "kasir_setoran giro (K2a)"]) {
            const m = await entri(nama);
            if (!(await pool.query(m.sudahAda)).rowCount) await pool.query(m.sql);
        }
        await pool.query(`
            CREATE TABLE accurate_employee (id bigint PRIMARY KEY, number text NOT NULL DEFAULT '', name text NOT NULL DEFAULT '', branch_id bigint,
                salesman boolean NOT NULL DEFAULT false, suspended boolean NOT NULL DEFAULT false, raw_data jsonb, synced_at timestamptz NOT NULL DEFAULT now());
            CREATE TABLE sales_code_merge (id text PRIMARY KEY, period_month integer NOT NULL, period_year integer NOT NULL, prefix text NOT NULL,
                from_sales_code text NOT NULL, to_sales_code text, decision text NOT NULL, decided_by text, created_at timestamp NOT NULL, updated_at timestamp NOT NULL);`);
        await fn(pool);
    } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${skema} CASCADE`);
        await admin.end();
    }
}

function depsUji(pool: Pool, jam: { t: Date }, databaseId = DB): DepsHari {
    return { db: drizzle(pool), sekarang: () => jam.t, databaseId: async () => databaseId, nama: async (ids) => new Map(ids.map((i) => [i, `Nama ${i}`])),
        jeda: async () => undefined };
}

async function pelunasan(pool: Pool, id: number, cheque: string, faktur: [number, number | null, string][], metode = "CASH_OTHER") {
    await pool.query(`INSERT INTO kasir_pelunasan (database_id, pelunasan_id, nomor, tanggal, metode, cheque_amount, last_update)
        VALUES ($1, $2, $3, $4, $5, $6, 'x')`, [DB, id, `SR/${id}`, D, metode, cheque]);
    for (const [fid, sid, ip] of faktur) {
        await pool.query(`INSERT INTO kasir_pelunasan_faktur (database_id, pelunasan_id, faktur_id, nomor_faktur, master_salesman_id, invoice_payment)
            VALUES ($1, $2, $3, $4, $5, $6)`, [DB, id, fid, `INV/${fid}`, sid, ip]);
    }
}
async function baca(pool: Pool, status: "lengkap" | "berjalan" | "sebagian" | "gagal", lengkapPada: Date | null) {
    const isi = {
        lengkap: { sebab: null, token: null, jumlah: 1, sisa: 0, selesai: true },
        berjalan: { sebab: null, token: "tok", jumlah: null, sisa: null, selesai: false },
        sebagian: { sebab: null, token: null, jumlah: 3, sisa: 1, selesai: true },
        gagal: { sebab: "bentuk", token: null, jumlah: null, sisa: null, selesai: true },
    }[status];
    await pool.query(`INSERT INTO kasir_pelunasan_baca AS b (database_id, tanggal, status, sebab, token, jumlah_daftar, sisa_detail, selesai_pada, lengkap_pada, pemicu, akun_sinkron)
        VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN now() END, $9, 'cron', 'u-sinkron')
        ON CONFLICT (database_id, tanggal) DO UPDATE SET status = EXCLUDED.status, sebab = EXCLUDED.sebab, token = EXCLUDED.token,
            jumlah_daftar = EXCLUDED.jumlah_daftar, sisa_detail = EXCLUDED.sisa_detail, selesai_pada = EXCLUDED.selesai_pada,
            lengkap_pada = coalesce(EXCLUDED.lengkap_pada, b.lengkap_pada), mulai_pada = now()`,
    [DB, D, status, isi.sebab, isi.token, isi.jumlah, isi.sisa, isi.selesai, lengkapPada]);
}
const setoranIsian = (o: Partial<IsianSetoran> & { orang: string }): IsianSetoran & { buktiBaru: string | null } => ({
    tanggal: D, tunai: 0, transfer: 0, giro: 0, noFormKasir: "FK-1", giroNomor: null, giroJatuhTempo: null, buktiLama: false, catatan: null,
    dasar: [], buktiBaru: null, ...o });
const eventSql = (pool: Pool, tanggal: string, jenis: "tutup" | "kunci" | "buka", pada: string, alasan: string | null = null) =>
    pool.query(`INSERT INTO kasir_hari_event (tanggal, jenis, alasan, snapshot, oleh, pada) VALUES ($1, $2, $3, $4::jsonb, 'x', $5)`,
        [tanggal, jenis, alasan, jenis === "buka" ? null : '{"terhalang":[]}', wita(pada)]);
const jumlahEvent = async (pool: Pool) => Number((await pool.query("SELECT count(*) AS n FROM kasir_hari_event")).rows[0].n);

/**
 * Senin 12 Okt. S-A klop; S-B selisih (belum dijelaskan); S-C belum setor (belum dijelaskan); S-D belum setor (SUDAH dijelaskan);
 * ember 91 (belum dijelaskan) dan 92 (sudah dijelaskan). Angka dalam rupiah teks (kolom numeric) / sen (isian lib).
 */
async function hariCampur(pool: Pool, jam: { t: Date }, lengkapPada = new Date(jam.t.getTime() - 5 * 60_000)) {
    for (const [id, number, name] of [[1, "S-A", "SALES A"], [2, "S-B", "SALES B"], [3, "S-C", "SALES C"], [4, "S-D", "SALES D"]] as const) {
        await pool.query("INSERT INTO accurate_employee (id, number, name, salesman, suspended) VALUES ($1, $2, $3, true, false)", [id, number, name]);
    }
    await pelunasan(pool, 11, "100000", [[101, 1, "100000"]]);
    await pelunasan(pool, 12, "200000", [[102, 2, "200000"]]);
    await pelunasan(pool, 13, "300000", [[103, 3, "300000"]]);
    await pelunasan(pool, 14, "50000", [[104, 4, "50000"]]);
    await pelunasan(pool, 91, "500000", [], "CREDIT_CARD");
    await pelunasan(pool, 92, "70000", [], "CREDIT_CARD");
    await baca(pool, "lengkap", lengkapPada);
    const deps = depsUji(pool, jam);
    await catatSetoran(setoranIsian({ orang: "S-A", tunai: 10_000_000 }), KASIR, deps);
    await catatSetoran(setoranIsian({ orang: "S-B", tunai: 15_000_000 }), KASIR, deps);
    await jelaskan({ tanggal: D, jenis: "selisih", orang: "S-D", pelunasan: 5_000_000, setoran: 0, penjelasan: "SALES D setor besok pagi", tindakLanjut: "setor_susulan" }, KASIR, deps);
    await jelaskan({ tanggal: D, jenis: "tak_teralokasi", pelunasanId: 92, sisa: 7_000_000, penjelasan: "Kartu kredit pelanggan A, diurus Finance" }, KASIR, deps);
}

test("PG K3 ringkasan = layar /kasir (muatHari) pada data yang sama; hari belum ditutup per tanggal = hari.sebab; BACA-SAJA", { skip: pgSkip }, async () => {
    await denganSkema(async (pool) => {
        const jam = { t: wita(`${D}T10:00:00`) };
        await hariCampur(pool, jam);
        // Jendela Senin 12 Okt: 3, 5, 6, 7, 8, 9, 10 Okt + hari ini. Tutup: 5, 6, 9. Kunci: 7. Tutup lalu buka beralasan: 8 (lewat 20.00 = terkunci).
        await eventSql(pool, "2026-10-05", "tutup", "2026-10-05T18:00:00");
        await eventSql(pool, "2026-10-06", "tutup", "2026-10-06T18:00:00");
        await eventSql(pool, "2026-10-07", "kunci", "2026-10-07T20:00:00");
        await eventSql(pool, "2026-10-08", "tutup", "2026-10-08T18:00:00");
        await eventSql(pool, "2026-10-08", "buka", "2026-10-08T21:00:00", "koreksi selisih ember tak teralokasi");
        await eventSql(pool, "2026-10-09", "tutup", "2026-10-09T18:00:00");
        const sebelum = await jumlahEvent(pool);
        const deps = depsUji(pool, jam);

        const r = await muatRingkasan(D, deps);
        assert.equal(await jumlahEvent(pool), sebelum, "ringkasan tidak menulis apa pun");
        const layar = await muatHari(D, { orang: null }, deps);
        // Rumus KPI layar (Kasir.tsx) pada JawabanHari yang sama.
        const nSelisih = layar.orang.filter((o) => o.status === "selisih" && !o.dijelaskan).length;
        const nBelum = layar.orang.filter((o) => o.status === "belum_setor" && !o.dijelaskan).length;
        assert.deepEqual(layar.orang.map((o) => [o.orang, o.status, o.dijelaskan]), [["S-A", "klop", false], ["S-B", "selisih", false], ["S-C", "belum_setor", false], ["S-D", "belum_setor", true]]);
        assert.equal(layar.total.takTeralokasiBelumDijelaskan, 1);
        assert.deepEqual(r.selisih, { orang: nSelisih, takTeralokasi: layar.total.takTeralokasiBelumDijelaskan, jumlah: 2 });
        assert.deepEqual(r.belumSetor, { jumlah: layar.orang.filter((o) => o.status === "belum_setor").length, belumDijelaskan: nBelum });
        assert.deepEqual(r.belumSetor, { jumlah: 2, belumDijelaskan: 1 });
        assert.deepEqual(r.incaso, layar.incaso);
        assert.equal(r.baca?.status, "lengkap");
        // Hari belum ditutup: tiap tanggal jendela lawan hari.sebab dari muatHari (layar) tanggal itu.
        const jendela = jendelaTutup(D);
        assert.deepEqual(jendela, ["2026-10-03", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-12"]);
        const dariLayar: string[] = [];
        for (const t of jendela) if ((await muatHari(t, { orang: null }, deps)).hari.sebab !== "tutup") dariLayar.push(t);
        assert.deepEqual(r.hariBelumDitutup.tanggal, dariLayar);
        assert.deepEqual(r.hariBelumDitutup.tanggal, ["2026-10-03", "2026-10-07", "2026-10-08", "2026-10-10", "2026-10-12"]);
        assert.equal(r.hariBelumDitutup.jumlah, 5);
    });
    // BACA-SAJA: sesudah 20.00 hari D terkunci otomatis. muatHari (layar) mencatat `kunci` malas; muatRingkasan TIDAK.
    await denganSkema(async (pool) => {
        const siang = { t: wita(`${D}T10:00:00`) };
        await hariCampur(pool, siang);
        const malam = { t: wita(`${D}T21:00:00`) };
        const deps = depsUji(pool, malam);
        const sebelum = await jumlahEvent(pool);
        const r = await muatRingkasan(D, deps);
        assert.equal(await jumlahEvent(pool), sebelum, "ringkasan sesudah 20.00: tanpa event kunci");
        assert.deepEqual(r.selisih, { orang: 1, takTeralokasi: 1, jumlah: 2 });
        const layar = await muatHari(D, { orang: null }, deps);
        assert.equal(await jumlahEvent(pool), sebelum + 1, "layar /kasir mencatat kunci otomatis (perilaku K2a)");
        assert.equal(layar.hari.sebab, "kunci");
        assert.deepEqual((await muatRingkasan(D, deps)).selisih, r.selisih, "angka sama sebelum dan sesudah kunci dicatat");
        assert.equal(r.hariBelumDitutup.tanggal.includes(D), true, "kunci otomatis ≠ tutup");
    });
});

test("PG K3 ringkasan: Incaso belum lengkap / tanpa database = null (BUKAN nol); lengkap yang tua tetap angka; hari belum ditutup tetap terhitung", { skip: pgSkip }, async () => {
    await denganSkema(async (pool) => {
        const jam = { t: wita(`${D}T10:00:00`) };
        await hariCampur(pool, jam);
        const deps = depsUji(pool, jam);
        const lengkap = await muatRingkasan(D, deps);
        assert.equal(lengkap.selisih?.jumlah, 2);
        // lengkap berumur 2 jam: umur bebas di layar (hanya Tutup menuntut ≤ 15 mnt) -> angka tetap ada.
        await baca(pool, "lengkap", new Date(jam.t.getTime() - 2 * 3600_000));
        assert.deepEqual((await muatRingkasan(D, deps)).selisih, lengkap.selisih, "lengkap tua = angka sama");
        // Status lain (upsert sah menurut CHECK K1b): angka Incaso null, sebab BACA_BELUM_LENGKAP, `baca.status` mengikuti.
        for (const status of ["sebagian", "gagal", "berjalan"] as const) {
            await baca(pool, status, null);
            const r = await muatRingkasan(D, deps);
            assert.deepEqual([r.selisih, r.belumSetor, r.incaso.lengkap, r.incaso.sebab, r.baca?.status], [null, null, false, "BACA_BELUM_LENGKAP", status], status);
            assert.equal(r.hariBelumDitutup.jumlah, 8, "Tutup tidak bergantung pada Incaso");
            const layar = await muatHari(D, { orang: null }, deps);
            assert.equal(layar.incaso.lengkap, false);
            assert.equal(layar.total.klop, null, "layar pun tidak menampilkan angka Incaso");
        }
        // Belum pernah dibaca (tanggal tanpa baris status) dan sesi sinkron tanpa database.
        await pool.query("DELETE FROM kasir_pelunasan_baca");
        const tanggalLain = await muatRingkasan("2026-10-10", deps);
        assert.deepEqual([tanggalLain.selisih, tanggalLain.belumSetor, tanggalLain.baca?.status], [null, null, "belum_dibaca"]);
        const tanpaDb = await muatRingkasan(D, depsUji(pool, jam, ""));
        assert.deepEqual([tanpaDb.baca, tanpaDb.incaso.sebab, tanpaDb.selisih, tanpaDb.belumSetor], [null, "SESI_SINKRON", null, null]);
    });
});
