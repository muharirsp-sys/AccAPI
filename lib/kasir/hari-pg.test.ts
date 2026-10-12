/* K2a (BL-59) server Kasir di Postgres EVALUASI (AM040_DATABASE_URL, bukan produksi). Tiap uji memakai SKEMA SEKALI-PAKAI (search_path hanya
 * skema itu, DROP di akhir): DDL_K1A (trigger append-only) + entri migrate-pg K1b + K2a, tabel accurate_employee / sales_code_merge minimal.
 * Diuji: DDL_K2A dua kali + VERIFIKASI, migrate-pg OK/SKIP, 0032 = entri; setoran multi-kode = semua revisi SATU transaksi (gagal satu =
 * batal semua); dua POST ber-dasar sama -> satu revisi + 409; BALAPAN Tutup ↔ Catat (2 koneksi, dua urutan) -> tak pernah setoran sesudah
 * tutup / tutup basi; klaim pembaca K1b MENUNGGU transaksi Tutup (FOR SHARE); Tutup saat berjalan/sebagian/gagal/lengkap 16 mnt -> 409;
 * terhalang -> 409 + CHECK DB; buka (tak terkunci / lintas tengah malam / terkunci lagi 20.00 berikut); GET serentak -> satu `kunci`; POST
 * yang menabrak kunci tetap menyimpan `kunci`; status ≠ lengkap -> angka Incaso null; jelaskan (ANGKA_BERUBAH / TIDAK_PERLU / sudahAda /
 * tanpa syarat lengkap / ember); galat sesudah commit -> 502 TIDAK_PASTI. Jam disuntik (bukan jam sistem). Tanpa env dilewati. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { bukaHari, catatKunciOtomatis, catatSetoran, GalatKasir, jelaskan, muatHari, tutupHari, type DepsHari, type IsianSetoran, type TitikJeda } from "./hari.ts";
import { tokoPg } from "./baca-pelunasan.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";

type Migration = { nama: string; sudahAda: string; sql: string };
const D = "2026-10-05"; // Senin
const DB = "DB-UJI";
const KASIR = "u-kasir";
const wita = (t: string) => new Date(`${t}+08:00`);

async function entri(nama: string): Promise<Migration> {
    const mod = await import(new URL("../../scripts/migrate-pg.mjs", import.meta.url).href) as { migrations: Migration[] };
    const m = mod.migrations.find((x) => x.nama === nama);
    assert.ok(m, `entri migrate-pg ${nama}`);
    return m;
}
const berkas = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");
async function migrasi(pool: Pool, m: Migration) {
    if ((await pool.query(m.sudahAda)).rowCount) return `SKIP ${m.nama}`;
    await pool.query(m.sql);
    return `OK ${m.nama}`;
}
type Hasil = { rows: { cek: string; ok: boolean | null }[] };
const verifikasi = async (pool: Pool, sqlTeks: string) => {
    const h = await pool.query(sqlTeks) as unknown as Hasil | Hasil[];
    return Array.isArray(h) ? h[h.length - 1].rows : h.rows;
};

async function denganSkema(fn: (pool: Pool) => Promise<void>, siap = true) {
    const skema = `uji_k2a_${randomUUID().slice(0, 8)}`;
    const admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${skema}`);
    const url = new URL(PG_URL);
    url.searchParams.set("options", `-c search_path=${skema}`);
    const pool = new Pool({ connectionString: url.toString(), max: 8 });
    try {
        if (siap) {
            await pool.query(await berkas("../../docs/handover/DDL_K1A.sql"));
            await migrasi(pool, await entri("kasir_pelunasan_baca (status baca K1b)"));
            await migrasi(pool, await entri("kasir_setoran giro (K2a)"));
            await pool.query(`
                CREATE TABLE accurate_employee (id bigint PRIMARY KEY, number text NOT NULL DEFAULT '', name text NOT NULL DEFAULT '', branch_id bigint,
                    salesman boolean NOT NULL DEFAULT false, suspended boolean NOT NULL DEFAULT false, raw_data jsonb, synced_at timestamptz NOT NULL DEFAULT now());
                CREATE TABLE sales_code_merge (id text PRIMARY KEY, period_month integer NOT NULL, period_year integer NOT NULL, prefix text NOT NULL,
                    from_sales_code text NOT NULL, to_sales_code text, decision text NOT NULL, decided_by text, created_at timestamp NOT NULL, updated_at timestamp NOT NULL);`);
        }
        await fn(pool);
    } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${skema} CASCADE`);
        await admin.end();
    }
}

const jamUji = (t = wita("2026-10-05T10:00:00")) => ({ t });
function depsUji(pool: Pool, jam: { t: Date }, jeda?: (t: TitikJeda) => Promise<void>, databaseId = DB): DepsHari {
    return { db: drizzle(pool), sekarang: () => jam.t, databaseId: async () => databaseId, nama: async (ids) => new Map(ids.map((i) => [i, `Nama ${i}`])),
        jeda: jeda ?? (async () => undefined) };
}
/** Gerbang jeda: transaksi berhenti di titik `titik` (memegang kuncinya) sampai buka(). */
function gerbang(titik: TitikJeda) {
    let buka!: () => void;
    let sampai!: () => void;
    const lepas = new Promise<void>((r) => { buka = r; });
    const tiba = new Promise<void>((r) => { sampai = r; });
    return { tiba, buka, jeda: async (t: TitikJeda) => { if (t === titik) { sampai(); await lepas; } } };
}
const tidur = (ms: number) => new Promise((r) => setTimeout(r, ms));
const galat = (kode: string) => (e: unknown) => e instanceof GalatKasir && e.kode === kode;

// --- benih ---
async function pegawai(pool: Pool, rows: [number, string, string, boolean?, boolean?][]) {
    for (const [id, number, name, salesman = true, suspended = false] of rows) {
        await pool.query("INSERT INTO accurate_employee (id, number, name, salesman, suspended) VALUES ($1, $2, $3, $4, $5)", [id, number, name, salesman, suspended]);
    }
}
async function gabung(pool: Pool, dari: string, ke: string) {
    await pool.query(`INSERT INTO sales_code_merge (id, period_month, period_year, prefix, from_sales_code, to_sales_code, decision, created_at, updated_at)
        VALUES ($1, 10, 2026, 'P', $2, $3, 'merge', now(), now())`, [randomUUID(), dari, ke]);
}
async function pelunasan(pool: Pool, id: number, cheque: string, faktur: [number, number | null, string][], metode = "CASH_OTHER", tanggal = D) {
    await pool.query(`INSERT INTO kasir_pelunasan (database_id, pelunasan_id, nomor, tanggal, metode, cheque_amount, last_update)
        VALUES ($1, $2, $3, $4, $5, $6, 'x')`, [DB, id, `SR/${id}`, tanggal, metode, cheque]);
    for (const [fid, sid, ip] of faktur) {
        await pool.query(`INSERT INTO kasir_pelunasan_faktur (database_id, pelunasan_id, faktur_id, nomor_faktur, master_salesman_id, invoice_payment)
            VALUES ($1, $2, $3, $4, $5, $6)`, [DB, id, fid, `INV/${fid}`, sid, ip]);
    }
}
/** Status baca (upsert) sesuai CHECK konsisten K1b. */
async function baca(pool: Pool, status: "lengkap" | "berjalan" | "sebagian" | "gagal", lengkapPada: Date | null, tanggal = D) {
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
    [DB, tanggal, status, isi.sebab, isi.token, isi.jumlah, isi.sisa, isi.selesai, lengkapPada]);
}
const setoranIsian = (o: Partial<IsianSetoran> & { orang: string }): IsianSetoran & { buktiBaru: string | null } => ({
    tanggal: D, tunai: 0, transfer: 0, giro: 0, noFormKasir: "FK-1", giroNomor: null, giroJatuhTempo: null, buktiLama: false, catatan: null,
    dasar: [], buktiBaru: null, ...o });
const revisi = async (pool: Pool) => (await pool.query(`SELECT salesman_kode AS kode, revisi, tunai, transfer, giro, no_form_kasir, catatan
    FROM kasir_setoran ORDER BY salesman_kode, revisi`)).rows;
const event = async (pool: Pool) => (await pool.query("SELECT jenis, oleh, snapshot FROM kasir_hari_event ORDER BY id")).rows;

/** Hari siap tutup: S-A (id 1) pelunasan Rp 100.000, setoran Rp 100.000 (klop), status lengkap 5 mnt lalu. */
async function hariKlop(pool: Pool, jam: { t: Date }) {
    await pegawai(pool, [[1, "S-A", "SALES A"], [2, "S-B", "SALES B"]]);
    await pelunasan(pool, 11, "100000", [[101, 1, "100000"]]);
    await baca(pool, "lengkap", new Date(jam.t.getTime() - 5 * 60_000));
    await catatSetoran(setoranIsian({ orang: "S-A", tunai: 10_000_000 }), KASIR, depsUji(pool, jam));
    const h = await muatHari(D, { orang: null }, depsUji(pool, jam));
    assert.equal(h.orang[0].status, "klop");
    return h;
}

test("PG K2a DDL: DDL_K2A dua kali + VERIFIKASI; migrate-pg OK lalu SKIP; 0032 = entri; CHECK giro_nomor", { skip: pgSkip }, async () => {
    const m = await entri("kasir_setoran giro (K2a)");
    const ddl = await berkas("../../docs/handover/DDL_K2A.sql");
    const bentuk = async (pool: Pool) => (await pool.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'kasir_setoran' ORDER BY 1`)).rows
        .concat((await pool.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE connamespace = current_schema()::regnamespace AND conrelid::regclass::text = 'kasir_setoran' ORDER BY 1`)).rows);
    let acuan: unknown;
    await denganSkema(async (pool) => {
        await pool.query(await berkas("../../docs/handover/DDL_K1A.sql"));
        assert.equal(await migrasi(pool, m), `OK ${m.nama}`);
        assert.equal(await migrasi(pool, m), `SKIP ${m.nama}`);
        await pool.query(m.sql); // SQL mentah diulang aman
        acuan = await bentuk(pool);
    }, false);
    await denganSkema(async (pool) => {
        await pool.query(await berkas("../../docs/handover/DDL_K1A.sql"));
        for (let i = 0; i < 2; i++) for (const v of await verifikasi(pool, ddl)) assert.notEqual(v.ok, false, `VERIFIKASI: ${v.cek}`);
        assert.equal(await migrasi(pool, m), `SKIP ${m.nama}`, "migrate-pg melewati sesudah DDL manual");
        assert.deepEqual(await bentuk(pool), acuan, "DDL manual = entri migrate-pg");
        await assert.rejects(pool.query(`INSERT INTO kasir_setoran (tanggal, salesman_kode, revisi, tunai, transfer, giro, giro_nomor, dicatat_oleh)
            VALUES ('2026-10-05', 'S-A', 1, 0, 0, 1, '  ', 'x')`), (e: { code?: string }) => e.code === "23514", "nomor BG hanya spasi ditolak");
        await pool.query(`INSERT INTO kasir_setoran (tanggal, salesman_kode, revisi, tunai, transfer, giro, giro_nomor, giro_jatuh_tempo, dicatat_oleh)
            VALUES ('2026-10-05', 'S-A', 1, 0, 0, 1, 'BG-1', '2026-11-01', 'x')`);
        await assert.rejects(pool.query("UPDATE kasir_setoran SET giro_nomor = 'BG-2'"), /append-only/, "trigger append-only tetap untuk kolom baru");
    }, false);
    await denganSkema(async (pool) => {
        await pool.query(await berkas("../../docs/handover/DDL_K1A.sql"));
        await pool.query(await berkas("../../db/migrations/0032_kasir_setoran_giro.sql"));
        assert.deepEqual(await bentuk(pool), acuan, "db/migrations/0032 = entri migrate-pg");
    }, false);
});

test("PG K2a setoran multi-kode: semua revisi SATU transaksi; satu baris gagal = semua batal; dua POST dasar sama -> satu revisi + 409", { skip: pgSkip }, async () => {
    await denganSkema(async (pool) => {
        const jam = jamUji();
        const deps = depsUji(pool, jam);
        await pegawai(pool, [[1, "S-A", "SALES A"], [2, "S-B", "SALES B"]]);
        // Setoran dicatat per kode SEBELUM gabungan S-A -> S-B diputuskan.
        await catatSetoran(setoranIsian({ orang: "S-A", tunai: 10_000_000 }), KASIR, deps);
        await catatSetoran(setoranIsian({ orang: "S-B", tunai: 5_000_000 }), KASIR, deps);
        await gabung(pool, "S-A", "S-B");
        const h = await muatHari(D, { orang: null }, deps);
        assert.deepEqual(h.orang.map((o) => [o.orang, o.setoran?.total, o.dasar]), [["S-B", "150000.00", [{ kode: "S-A", revisi: 1 }, { kode: "S-B", revisi: 1 }]]]);
        // Koreksi orang S-B (dikirim lewat kode lama S-A -> dilipat): S-B revisi 2 = 200.000, rantai S-A revisi 2 = 0.
        const r = await catatSetoran(setoranIsian({ orang: "S-A", tunai: 20_000_000, dasar: h.orang[0].dasar }), KASIR, deps);
        assert.equal(r.orang, "S-B");
        const rows = await revisi(pool);
        assert.deepEqual(rows.map((x) => [x.kode, x.revisi, x.tunai]), [["S-A", 1, "100000.00"], ["S-A", 2, "0.00"], ["S-B", 1, "50000.00"], ["S-B", 2, "200000.00"]]);
        assert.equal(rows.find((x) => x.kode === "S-A" && x.revisi === 2)!.no_form_kasir, null, "baris nol tanpa Form Kasir");
        assert.match(rows.find((x) => x.kode === "S-A" && x.revisi === 2)!.catatan, /Dinolkan/);
        // Rantai S-A sudah 0: koreksi berikut hanya menulis S-B (rantai nol tidak ditulis ulang).
        await catatSetoran(setoranIsian({ orang: "S-B", tunai: 0, noFormKasir: null, dasar: [{ kode: "S-A", revisi: 2 }, { kode: "S-B", revisi: 2 }] }), KASIR, deps);
        assert.deepEqual((await revisi(pool)).map((x) => [x.kode, x.revisi]), [["S-A", 1], ["S-A", 2], ["S-B", 1], ["S-B", 2], ["S-B", 3]]);
    });
    await denganSkema(async (pool) => {
        const jam = jamUji();
        const deps = depsUji(pool, jam);
        await pegawai(pool, [[1, "S-A", "SALES A"], [2, "S-B", "SALES B"]]);
        await catatSetoran(setoranIsian({ orang: "S-A", tunai: 10_000_000 }), KASIR, deps);
        await catatSetoran(setoranIsian({ orang: "S-B", tunai: 5_000_000 }), KASIR, deps);
        await gabung(pool, "S-A", "S-B");
        await pool.query(`CREATE FUNCTION tolak_uji() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            IF NEW.salesman_kode = 'S-A' THEN RAISE EXCEPTION 'uji: tolak S-A'; END IF; RETURN NEW; END $$;
            CREATE TRIGGER trg_tolak_uji BEFORE INSERT ON kasir_setoran FOR EACH ROW EXECUTE FUNCTION tolak_uji();`);
        await assert.rejects(catatSetoran(setoranIsian({ orang: "S-B", tunai: 20_000_000, dasar: [{ kode: "S-A", revisi: 1 }, { kode: "S-B", revisi: 1 }] }), KASIR, deps),
            (e: unknown) => !(e instanceof GalatKasir), "galat DB di dalam transaksi = GALAT_INTERNAL (pasti batal)");
        assert.deepEqual((await revisi(pool)).map((x) => [x.kode, x.revisi]), [["S-A", 1], ["S-B", 1]], "S-B revisi 2 ikut batal");
        await pool.query("DROP TRIGGER trg_tolak_uji ON kasir_setoran");

        // Klik ganda: dua POST ber-dasar sama serentak -> satu 200, satu 409 SETORAN_BERUBAH, satu revisi.
        const isian = setoranIsian({ orang: "S-B", tunai: 30_000_000, dasar: [{ kode: "S-A", revisi: 1 }, { kode: "S-B", revisi: 1 }] });
        const hasil = await Promise.allSettled([catatSetoran(isian, KASIR, deps), catatSetoran(isian, KASIR, deps)]);
        assert.deepEqual(hasil.map((h) => h.status).sort(), ["fulfilled", "rejected"]);
        const ditolak = hasil.find((h) => h.status === "rejected") as PromiseRejectedResult;
        assert.ok(galat("SETORAN_BERUBAH")(ditolak.reason));
        assert.deepEqual((ditolak.reason as GalatKasir).tambahan.keadaan, { orang: "S-B", dasar: [{ kode: "S-A", revisi: 2 }, { kode: "S-B", revisi: 2 }],
            setoranPerKode: [{ kode: "S-A", revisi: 2, tunai: "0.00", transfer: "0.00", giro: "0.00", total: "0.00" },
                { kode: "S-B", revisi: 2, tunai: "300000.00", transfer: "0.00", giro: "0.00", total: "300000.00" }],
            setoran: { tunai: "300000.00", transfer: "0.00", giro: "0.00", total: "300000.00" } }, "409 membawa keadaan terbaru");
        assert.deepEqual((await revisi(pool)).map((x) => [x.kode, x.revisi]), [["S-A", 1], ["S-A", 2], ["S-B", 1], ["S-B", 2]]);
        // Kode tak dikenal / Tanpa salesman ditolak; giro & bukti tersimpan di baris utama.
        await assert.rejects(catatSetoran(setoranIsian({ orang: "S-Z", tunai: 100 }), KASIR, deps), galat("INPUT_SALAH"));
        await catatSetoran(setoranIsian({ orang: "S-B", transfer: 100, giro: 200, giroNomor: "BG-9", giroJatuhTempo: "2026-11-01",
            buktiBaru: "00000000-0000-4000-8000-000000000000.png", dasar: [{ kode: "S-A", revisi: 2 }, { kode: "S-B", revisi: 2 }] }), KASIR, deps);
        const akhir = (await pool.query(`SELECT giro_nomor, giro_jatuh_tempo::text AS jt, bukti_transfer FROM kasir_setoran WHERE salesman_kode = 'S-B' AND revisi = 3`)).rows[0];
        assert.deepEqual(akhir, { giro_nomor: "BG-9", jt: "2026-11-01", bukti_transfer: "00000000-0000-4000-8000-000000000000.png" });
        // buktiLama: transfer sama -> berkas revisi sebelumnya dipakai; transfer beda -> 400.
        await catatSetoran(setoranIsian({ orang: "S-B", tunai: 1, transfer: 100, buktiLama: true, dasar: [{ kode: "S-A", revisi: 2 }, { kode: "S-B", revisi: 3 }] }), KASIR, deps);
        assert.equal((await pool.query(`SELECT bukti_transfer FROM kasir_setoran WHERE salesman_kode = 'S-B' AND revisi = 4`)).rows[0].bukti_transfer,
            "00000000-0000-4000-8000-000000000000.png");
        await assert.rejects(catatSetoran(setoranIsian({ orang: "S-B", transfer: 999, buktiLama: true, dasar: [{ kode: "S-A", revisi: 2 }, { kode: "S-B", revisi: 4 }] }), KASIR, deps),
            galat("INPUT_SALAH"));
    });
});

test("PG K2a BALAPAN Tutup ↔ Catat (2 koneksi): Tutup memegang kunci -> Catat menunggu lalu HARI_TERKUNCI; Catat memegang kunci -> Tutup menunggu lalu melihat setoran baru", { skip: pgSkip }, async () => {
    // Urutan 1: Tutup sudah membaca (memegang kunci hari) -> Catat harus MENUNGGU; sesudah Tutup commit, Catat ditolak (tak ada setoran sesudah tutup).
    await denganSkema(async (pool) => {
        const jam = jamUji();
        const h = await hariKlop(pool, jam);
        const g = gerbang("tutup:sesudah-baca");
        const pTutup = tutupHari({ tanggal: D, sidik: h.sidik! }, KASIR, depsUji(pool, jam, g.jeda));
        pTutup.catch(() => undefined);
        await g.tiba;
        let catatSelesai = false;
        const pCatat = catatSetoran(setoranIsian({ orang: "S-A", tunai: 15_000_000, dasar: h.orang[0].dasar }), KASIR, depsUji(pool, jam))
            .finally(() => { catatSelesai = true; });
        pCatat.catch(() => undefined);
        try {
            await tidur(400);
            assert.equal(catatSelesai, false, "Catat menunggu kunci hari selama Tutup berjalan");
        } finally {
            g.buka(); // merah pun: lepaskan transaksi Tutup agar pool bisa ditutup (tanpa uji menggantung)
        }
        assert.ok("event" in (await pTutup));
        await assert.rejects(pCatat, galat("HARI_TERKUNCI"));
        assert.deepEqual((await revisi(pool)).map((x) => [x.kode, x.revisi]), [["S-A", 1]], "tak ada setoran sesudah tutup");
        const [tutup] = await event(pool);
        assert.equal(tutup.snapshot.total.setoran, 10_000_000, "snapshot tutup = keadaan sebenarnya");
    });
    // Urutan 2: Catat memegang kunci (sebelum INSERT) -> Tutup MENUNGGU; sesudah Catat commit, Tutup membaca ulang (READ COMMITTED) dan
    // melihat setoran baru -> selisih belum dijelaskan -> TERHALANG (bukan tutup dengan angka basi).
    await denganSkema(async (pool) => {
        const jam = jamUji();
        const h = await hariKlop(pool, jam);
        const g = gerbang("setoran:sebelum-insert");
        const pCatat = catatSetoran(setoranIsian({ orang: "S-A", tunai: 15_000_000, dasar: h.orang[0].dasar }), KASIR, depsUji(pool, jam, g.jeda));
        pCatat.catch(() => undefined);
        await g.tiba;
        let tutupSelesai = false;
        const pTutup = tutupHari({ tanggal: D, sidik: h.sidik! }, KASIR, depsUji(pool, jam)).finally(() => { tutupSelesai = true; });
        pTutup.catch(() => undefined);
        try {
            await tidur(400);
            assert.equal(tutupSelesai, false, "Tutup menunggu kunci hari selama Catat berjalan");
        } finally {
            g.buka();
        }
        await pCatat;
        await assert.rejects(pTutup, (e: unknown) => galat("TERHALANG")(e) && /Selisih S-A/.test(((e as GalatKasir).tambahan.alasan as string[]).join(" ")));
        assert.deepEqual(await event(pool), [], "tidak ada event tutup");
    });
});

test("PG K2a Tutup: klaim pembaca K1b MENUNGGU transaksi Tutup (FOR SHARE status baca); sesudah commit klaim berjalan", { skip: pgSkip }, async () => {
    await denganSkema(async (pool) => {
        const jam = jamUji();
        const h = await hariKlop(pool, jam);
        const g = gerbang("tutup:sesudah-baca");
        const pTutup = tutupHari({ tanggal: D, sidik: h.sidik! }, KASIR, depsUji(pool, jam, g.jeda));
        pTutup.catch(() => undefined);
        await g.tiba;
        const urutan: string[] = [];
        const pKlaim = tokoPg(drizzle(pool)).klaim({ databaseId: DB, tanggal: D, token: "tok-baru", pemicu: "cron", penuh: true, akun: "u-sinkron" })
            .then((k) => { urutan.push("klaim"); return k; });
        pKlaim.catch(() => undefined);
        try {
            await tidur(400);
            assert.deepEqual(urutan, [], "klaim (UPDATE status) menunggu FOR SHARE transaksi Tutup");
        } finally {
            g.buka();
        }
        assert.ok("event" in (await pTutup));
        const k = await pKlaim;
        assert.equal(k.diklaim, true, "sesudah Tutup commit, klaim pembaca berjalan");
        const [tutup] = await event(pool);
        assert.equal(tutup.snapshot.baca.status, "lengkap", "snapshot memuat status baca SAAT ditutup");
        assert.deepEqual(Object.keys(tutup.snapshot.baca).sort(), ["akun", "jumlahDaftar", "lengkapPada", "status"]);
    });
});

test("PG K2a Tutup: berjalan / sebagian / gagal / lengkap 16 mnt -> 409 BACA_BELUM_SEGAR; lengkap 14 mnt + sidik -> tutup; klik ganda -> sudahDitutup", { skip: pgSkip }, async () => {
    await denganSkema(async (pool) => {
        const jam = jamUji();
        const h = await hariKlop(pool, jam);
        const deps = depsUji(pool, jam);
        const menit = (n: number) => new Date(jam.t.getTime() - n * 60_000);
        for (const [status, pada] of [["berjalan", menit(1)], ["sebagian", menit(1)], ["gagal", menit(1)], ["lengkap", menit(16)]] as const) {
            await baca(pool, status, pada);
            if (status === "lengkap") await pool.query("UPDATE kasir_pelunasan_baca SET lengkap_pada = $1", [pada]);
            await assert.rejects(tutupHari({ tanggal: D, sidik: h.sidik! }, KASIR, deps), (e: unknown) => galat("BACA_BELUM_SEGAR")(e)
                && ((e as GalatKasir).tambahan.keadaan as { segarUntukTutup: boolean }).segarUntukTutup === false, `status ${status}`);
        }
        await baca(pool, "lengkap", menit(14));
        await pool.query("UPDATE kasir_pelunasan_baca SET lengkap_pada = $1", [menit(14)]);
        await assert.rejects(tutupHari({ tanggal: D, sidik: "0000000000000000" }, KASIR, deps), galat("ANGKA_BERUBAH"));
        // Tanpa database sinkron -> 503 SESI_SINKRON; baris klop -> tidak perlu dijelaskan.
        await assert.rejects(tutupHari({ tanggal: D, sidik: h.sidik! }, KASIR, depsUji(pool, jam, undefined, "")), galat("SESI_SINKRON"));
        await assert.rejects(jelaskan({ tanggal: D, jenis: "selisih", orang: "S-A", pelunasan: 10_000_000, setoran: 10_000_000, penjelasan: "Tidak ada selisih apa pun",
            tindakLanjut: "lapor_om" }, KASIR, deps), galat("TIDAK_PERLU_DIJELASKAN"));
        const r = await tutupHari({ tanggal: D, sidik: h.sidik! }, KASIR, deps);
        assert.ok("event" in r);
        assert.deepEqual(await tutupHari({ tanggal: D, sidik: h.sidik! }, KASIR, deps), { sudahDitutup: true, event: (r as { event: unknown }).event });
        assert.equal((await event(pool)).length, 1);
        // Sesudah tutup: setoran ditolak.
        await assert.rejects(catatSetoran(setoranIsian({ orang: "S-B", tunai: 100 }), KASIR, deps), galat("HARI_TERKUNCI"));
    });
});

test("PG K2a Tutup terhalang -> 409 TERHALANG + alasan; jelaskan (tanpa syarat lengkap) membuka jalan; CHECK DB menolak tutup terhalang", { skip: pgSkip }, async () => {
    await denganSkema(async (pool) => {
        const jam = jamUji();
        const deps = depsUji(pool, jam);
        await pegawai(pool, [[1, "S-A", "SALES A"], [2, "S-B", "SALES B"]]);
        await pelunasan(pool, 11, "100000", [[101, 1, "100000"]]);
        await pelunasan(pool, 12, "50000", [[102, 1, "20000"], [103, 2, "20000"]]); // multi-orang, sisa 10.000 tak teralokasi
        await baca(pool, "lengkap", new Date(jam.t.getTime() - 60_000));
        await catatSetoran(setoranIsian({ orang: "S-A", tunai: 9_000_000 }), KASIR, deps); // selisih -10.000 (pelunasan 120.000)
        let h = await muatHari(D, { orang: null }, deps);
        await assert.rejects(tutupHari({ tanggal: D, sidik: h.sidik! }, KASIR, deps), (e: unknown) => galat("TERHALANG")(e)
            && ((e as GalatKasir).tambahan.alasan as string[]).length === 3);
        await assert.rejects(pool.query(`INSERT INTO kasir_hari_event (tanggal, jenis, snapshot, oleh) VALUES ($1, 'tutup', $2, 'x')`,
            [D, JSON.stringify({ terhalang: ["Selisih S-A belum dijelaskan"] })]), (e: { code?: string; constraint?: string }) =>
            e.code === "23514" && e.constraint === "kasir_hari_event_tutup_tuntas", "CHECK tutup_tuntas = jaring kedua");

        // Jelaskan saat status `berjalan` (cron sedang membaca) tetap boleh: angka dihitung dari cache sekarang.
        await baca(pool, "berjalan", null);
        const sa = { tanggal: D, jenis: "selisih" as const, orang: "S-A", pelunasan: 12_000_000, setoran: 9_000_000, penjelasan: "Setor susulan besok pagi", tindakLanjut: "setor_susulan" as const };
        await assert.rejects(jelaskan({ ...sa, setoran: 9_500_000 }, KASIR, deps), (e: unknown) => galat("ANGKA_BERUBAH")(e)
            && JSON.stringify((e as GalatKasir).tambahan.keadaan) === JSON.stringify({ angka: { pelunasan: "120000.00", setoran: "90000.00" }, status: "selisih" }));
        const j1 = await jelaskan(sa, KASIR, deps);
        assert.ok("id" in j1);
        assert.deepEqual(await jelaskan(sa, KASIR, deps), { sudahAda: true }, "klik ganda = tanpa baris kedua");
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM kasir_selisih_catatan")).rows[0].n, 1);
        await assert.rejects(jelaskan({ ...sa, orang: "S-B" }, KASIR, deps), galat("ANGKA_BERUBAH"), "S-B belum setor 20.000");
        await jelaskan({ ...sa, orang: "S-B", pelunasan: 2_000_000, setoran: 0, penjelasan: "SALES B setor besok pagi" }, KASIR, deps);
        // Ember tak teralokasi: sisa beda -> ANGKA_BERUBAH; tak ada -> TIDAK_PERLU; benar -> tersimpan berdatabase.
        await assert.rejects(jelaskan({ tanggal: D, jenis: "tak_teralokasi", pelunasanId: 12, sisa: 999, penjelasan: "Lebih bayar pelanggan A" }, KASIR, deps), galat("ANGKA_BERUBAH"));
        await assert.rejects(jelaskan({ tanggal: D, jenis: "tak_teralokasi", pelunasanId: 11, sisa: 1_000_000, penjelasan: "Lebih bayar pelanggan A" }, KASIR, deps), galat("TIDAK_PERLU_DIJELASKAN"));
        await jelaskan({ tanggal: D, jenis: "tak_teralokasi", pelunasanId: 12, sisa: 1_000_000, penjelasan: "Lebih bayar pelanggan A" }, KASIR, deps);
        assert.equal((await pool.query("SELECT database_id FROM kasir_tak_teralokasi_catatan")).rows[0].database_id, DB);
        await assert.rejects(jelaskan(sa, KASIR, depsUji(pool, jam, undefined, "")), galat("SESI_SINKRON"));

        await baca(pool, "lengkap", new Date(jam.t.getTime() - 60_000));
        h = await muatHari(D, { orang: null }, deps);
        assert.deepEqual(h.penghalangTutup, { bisaDitutup: true, alasan: [] });
        assert.ok("event" in (await tutupHari({ tanggal: D, sidik: h.sidik! }, KASIR, deps)));
    });
});

test("PG K2a kunci 20.00 dicatat malas: GET serentak -> SATU kunci; POST yang menabrak kunci tetap menyimpan kunci; buka -> boleh catat lintas tengah malam -> terkunci lagi 20.00 berikut", { skip: pgSkip }, async () => {
    await denganSkema(async (pool) => {
        const jam = jamUji(wita("2026-10-05T20:30:00"));
        const deps = depsUji(pool, jam);
        await pegawai(pool, [[1, "S-A", "SALES A"]]);
        await pelunasan(pool, 11, "100000", [[101, 1, "100000"]]);
        await baca(pool, "lengkap", new Date(jam.t.getTime() - 60_000));
        const hs = await Promise.all(Array.from({ length: 6 }, () => muatHari(D, { orang: null }, deps)));
        assert.deepEqual((await event(pool)).map((e) => [e.jenis, e.oleh]), [["kunci", "sistem"]], "satu kunci walau 6 GET serentak");
        assert.ok(hs.every((h) => h.hari.terkunci && h.hari.event.length === 1 && h.hari.event[0].oleh === "Sistem"));
        const [k] = await event(pool);
        assert.deepEqual(k.snapshot.terhalang, ["S-A belum setor dan belum dijelaskan: pelunasan Rp 100.000."], "snapshot kunci mencatat yang belum dijelaskan");
        assert.equal(await catatKunciOtomatis(D, deps), false, "sudah dicatat");

        // Hari lain: POST pertama sesudah 20.00 menyimpan kunci lalu 409.
        await baca(pool, "lengkap", new Date(jam.t.getTime() - 60_000), "2026-10-03");
        jam.t = wita("2026-10-03T21:00:00");
        await assert.rejects(catatSetoran(setoranIsian({ tanggal: "2026-10-03", orang: "S-A", tunai: 100 }), KASIR, deps), galat("HARI_TERKUNCI"));
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM kasir_hari_event WHERE tanggal = '2026-10-03' AND jenis = 'kunci'")).rows[0].n, 1);

        // Buka (OM) 23.30 WITA tanggal 5 -> terbuka sampai 20.00 WITA tanggal 6; catat 00.30 tanggal 6 boleh; 20.01 tanggal 6 terkunci lagi.
        jam.t = wita("2026-10-05T23:30:00");
        await assert.rejects(bukaHari({ tanggal: D, alasan: "Koreksi setoran SALES A" }, "u-om", depsUji(pool, jam)).then(() =>
            bukaHari({ tanggal: D, alasan: "Koreksi setoran SALES A" }, "u-om", deps)), galat("TIDAK_TERKUNCI"), "buka kedua = tidak terkunci");
        const evBuka = (await pool.query("SELECT pada FROM kasir_hari_event WHERE tanggal = $1 AND jenis = 'buka'", [D])).rows;
        assert.equal(evBuka.length, 1);
        jam.t = wita("2026-10-06T00:30:00");
        const h = await muatHari(D, { orang: null }, deps);
        assert.equal(h.hari.kunciBerikutnya, "2026-10-06T12:00:00.000Z", "terkunci lagi 20.00 WITA tanggal 6");
        await catatSetoran(setoranIsian({ orang: "S-A", tunai: 10_000_000 }), KASIR, deps);
        jam.t = wita("2026-10-06T20:01:00");
        await assert.rejects(catatSetoran(setoranIsian({ orang: "S-A", tunai: 1, dasar: [{ kode: "S-A", revisi: 1 }] }), KASIR, deps), galat("HARI_TERKUNCI"));
        assert.deepEqual((await pool.query("SELECT jenis FROM kasir_hari_event WHERE tanggal = $1 ORDER BY id", [D])).rows.map((x) => x.jenis), ["kunci", "buka", "kunci"]);
    });
});

test("PG K2a GET: status ≠ lengkap -> angka Incaso null (setoran tetap); lengkap -> angka + rincian; tanpa database sinkron -> SESI_SINKRON", { skip: pgSkip }, async () => {
    await denganSkema(async (pool) => {
        const jam = jamUji();
        const deps = depsUji(pool, jam);
        await pegawai(pool, [[1, "S-A", "SALES A"], [2, "S-B", "SALES B", true, true]]);
        await pelunasan(pool, 11, "100000", [[101, 1, "100000"]]);
        await pelunasan(pool, 12, "7000", [[102, 1, "7000"]], "OTHERS");
        await catatSetoran(setoranIsian({ orang: "S-A", tunai: 5_000_000 }), KASIR, deps);
        for (const st of ["sebagian", "gagal", "berjalan"] as const) {
            await baca(pool, st, null);
            const h = await muatHari(D, { orang: "S-A" }, deps);
            assert.deepEqual([h.incaso.lengkap, h.incaso.sebab], [false, "BACA_BELUM_LENGKAP"], st);
            const o = h.orang[0];
            assert.deepEqual([o.pelunasan, o.pelunasanPerMetode, o.jumlahFaktur, o.selisih, o.status, o.dijelaskan], [null, null, null, null, null, null], st);
            assert.deepEqual([h.total.pelunasan, h.total.selisih, h.total.klop, h.takTeralokasi, h.nonKas, h.penghalangTutup, h.sidik, h.rincian],
                [null, null, null, null, null, null, null, null], st);
            assert.equal(o.setoran?.total, "50000.00", "setoran tetap tampil");
            assert.equal(h.total.setoran, "50000.00");
        }
        await baca(pool, "lengkap", new Date(jam.t.getTime() - 60_000));
        const h = await muatHari(D, { orang: "S-A" }, deps);
        assert.deepEqual([h.orang[0].pelunasan, h.orang[0].status, h.orang[0].selisih, h.total.nonKas], ["100000.00", "selisih", "-50000.00", "7000.00"]);
        assert.deepEqual(h.rincian, { orang: "S-A", pelunasan: [{ pelunasanId: 11, nomor: "SR/11", metode: "CASH_OTHER", chequeAmount: "100000.00",
            bagian: "100000.00", faktur: [{ fakturId: 101, nomorFaktur: "INV/101", invoicePayment: "100000.00" }] }] });
        assert.deepEqual(h.pegawai, [{ kode: "S-A", orang: "S-A", nama: "SALES A" }], "pegawai suspended tidak ditawarkan");
        assert.equal(h.riwayat.setoran[0].oleh, `Nama ${KASIR}`);
        const tanpa = await muatHari(D, { orang: null }, depsUji(pool, jam, undefined, ""));
        assert.deepEqual([tanpa.baca, tanpa.incaso.sebab, tanpa.orang.length, tanpa.orang[0].setoran?.total], [null, "SESI_SINKRON", 1, "50000.00"]);
    });
});

test("PG K2a galat SESUDAH commit -> 502 TIDAK_PASTI (baris memang tersimpan); galat di dalam transaksi -> bukan TIDAK_PASTI", { skip: pgSkip }, async () => {
    await denganSkema(async (pool) => {
        const jam = jamUji();
        const asli = depsUji(pool, jam);
        await pegawai(pool, [[1, "S-A", "SALES A"]]);
        const putusDiCommit = { ...asli, db: new Proxy(asli.db, { get(t, k, r) {
            if (k !== "transaction") return Reflect.get(t, k, r);
            return async (...a: Parameters<typeof t.transaction>) => { await t.transaction(...a); throw new Error("uji: koneksi putus saat COMMIT"); };
        } }) } as DepsHari;
        await assert.rejects(catatSetoran(setoranIsian({ orang: "S-A", tunai: 100 }), KASIR, putusDiCommit), (e: unknown) => galat("TIDAK_PASTI")(e)
            && (e as GalatKasir).http === 502);
        assert.equal((await revisi(pool)).length, 1, "tidak pasti: baris bisa saja tersimpan");
    });
});
