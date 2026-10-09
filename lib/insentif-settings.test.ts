/* AM-020 (H08): fallback tampilan konstanta insentif tidak boleh menjadi basis tulis.
 * AM-045 (H08-c): dua admin menyimpan dari versi yang sama tidak saling menimpa. */
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { db } from "./db.ts";
import { KONSTANTA_KEY, KonstantaBerubahError, getKonstantaBerlabel, readKonstantaVersi, setKonstanta } from "./insentif-settings.ts";
import { NextRequest } from "next/server";
import { POST as postPayment } from "../app/api/insentif-sales/payments/route.ts";
import { PATCH as patchSettings } from "../app/api/insentif-sales/settings/route.ts";
import { DEFAULT_KONSTANTA } from "./insentif-konstanta.ts";

test("baca konstanta gagal -> setKonstanta menolak dan TIDAK menulis bawaan + patch", async () => {
    // Pool habis / statement timeout saat membaca: dulu getKonstanta menelan error dan
    // mengembalikan BAWAAN, lalu setKonstanta menulis bawaan + satu field ke DB — semua 25
    // angka uang lain kembali ke bawaan tanpa ada yang meminta.
    const select = mock.method(db, "select", () => { throw new Error("pool habis"); });
    const insert = mock.method(db, "insert", () => { throw new Error("TIDAK BOLEH MENULIS"); });
    try {
        await assert.rejects(setKonstanta({ gt: { pool1: 2_000_000 } }, "admin", null), /pool habis/);
        assert.equal(insert.mock.callCount(), 0, "menulis walau baca gagal");
    } finally {
        select.mock.restore();
        insert.mock.restore();
    }
});

const T = new Date("2026-09-30T01:02:03.456Z");
const tersimpan = () => mock.method(db, "select", () => ({
    from: () => ({ where: () => ({ limit: async () => [{ value: JSON.stringify(DEFAULT_KONSTANTA), updatedAt: T }] }) }),
}));
const updateMengembalikan = (rows: unknown[]) => mock.method(db, "update", () => ({
    set: () => ({ where: () => ({ returning: async () => rows }) }),
}));

test("AM-045: versi editor basi -> 409 tanpa menulis", async () => {
    const select = tersimpan();
    const update = updateMengembalikan([{ key: "x" }]);
    try {
        await assert.rejects(setKonstanta({ gt: { pool1: 2_000_000 } }, "admin", "2026-09-29T00:00:00.000Z"), KonstantaBerubahError);
        await assert.rejects(setKonstanta({ gt: { pool1: 2_000_000 } }, "admin", null), KonstantaBerubahError, "baris ada, editor mengira belum pernah disimpan");
        assert.equal(update.mock.callCount(), 0, "menulis walau versi basi");
    } finally {
        select.mock.restore();
        update.mock.restore();
    }
});

test("AM-045: admin lain menyimpan di antara baca dan tulis -> UPDATE bersyarat 0 baris -> 409", async () => {
    const select = tersimpan();
    const update = updateMengembalikan([]);
    try {
        await assert.rejects(setKonstanta({ gt: { pool1: 2_000_000 } }, "admin", T.toISOString()), KonstantaBerubahError);
        assert.equal(update.mock.callCount(), 1);
    } finally {
        select.mock.restore();
        update.mock.restore();
    }
});

test("AM-045: versi cocok -> tersimpan, versi baru dikembalikan (kontrol positif)", async () => {
    const select = tersimpan();
    const update = updateMengembalikan([{ key: "insentif_konstanta" }]);
    try {
        const hasil = await setKonstanta({ gt: { pool1: 2_000_000 } }, "admin", T.toISOString());
        assert.equal(hasil.konstanta.gt.pool1, 2_000_000);
        assert.equal(hasil.konstanta.gt.aoAmbang, DEFAULT_KONSTANTA.gt.aoAmbang, "field lain dari yang tersimpan");
        assert.ok(hasil.versi > T.toISOString(), `versi baru ${hasil.versi}`);
    } finally {
        select.mock.restore();
        update.mock.restore();
    }
});

/*
 * S6-0c perbaikan 5 (peninjau B): dashboard/spv/sm dulu jatuh ke bawaan TANPA memberi tahu, lalu Pembayaran mengirim nominal
 * hasil bawaan sebagai totalIncentive. Kini tampilan DILABELI dan server menolak menandai lunas selama konstanta tak terbaca.
 */
test("getKonstantaBerlabel: baca gagal → bawaan DILABELI gagal_baca (tampilan boleh degraded, tidak diam-diam)", async () => {
    const select = mock.method(db, "select", () => { throw new Error("statement timeout"); });
    try {
        assert.deepEqual(await getKonstantaBerlabel(), { konstanta: DEFAULT_KONSTANTA, konstantaSumber: "gagal_baca" });
    } finally {
        select.mock.restore();
    }
});

test("POST payments lunas saat konstanta tak terbaca → 503 KONSTANTA_GAGAL_BACA, tidak menulis; status lain lewat ke validasi biasa", async () => {
    const env = { NODE_ENV: process.env.NODE_ENV, LOCAL_AUTH_BYPASS: process.env.LOCAL_AUTH_BYPASS };
    Object.assign(process.env, { NODE_ENV: "development", LOCAL_AUTH_BYPASS: "true" });
    const select = mock.method(db, "select", () => { throw new Error("DB tak terbaca"); });
    const insert = mock.method(db, "insert", () => { throw new Error("TIDAK BOLEH MENULIS"); });
    const kirim = (paymentStatus: string) => postPayment(new NextRequest("http://localhost/api/insentif-sales/payments", {
        method: "POST", headers: { host: "localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({ salesCode: "S-A", salesName: "SALES A", principle: "PRINCIPLE A", branch: "CABANG A", periodMonth: 9, periodYear: 2026, totalIncentive: 1_000_000, paymentStatus }),
    }));
    try {
        const res = await kirim("lunas");
        assert.equal(res.status, 503);
        assert.equal((await res.json()).code, "KONSTANTA_GAGAL_BACA");
        assert.equal(insert.mock.callCount(), 0);
        // Kontrol: status "belum" tidak memeriksa konstanta — sampai ke pencarian target (DB) seperti biasa.
        await assert.rejects(kirim("belum"), /DB tak terbaca/);
    } finally {
        select.mock.restore();
        insert.mock.restore();
        for (const [k, v] of Object.entries(env)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
});

// ---------------------------------------------------------------- Postgres evaluasi (AM-040)
/*
 * S6-0c perbaikan 6 (peninjau B): mock `where` di atas mengabaikan argumennya — membuang predikat `eq(appSetting.value, row.value)`
 * atau `.onConflictDoNothing()` dari setKonstanta tidak menggagalkan apa pun. Uji ini memakai Postgres sungguhan dan penghalang
 * kunci tabel (seperti scripts/am040-concurrency.mjs): kedua penyimpan SUDAH lolos cek versi sebelum salah satunya menulis, jadi
 * yang menolak penyimpan kedua hanyalah predikat tulis bersyarat itu.
 */
const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";

/** lib/db terikat DATABASE_URL saat impor: select/insert/update-nya dialihkan ke Postgres evaluasi; baris konstanta dipulihkan. */
async function denganPg(fn: (pool: Pool) => Promise<void>) {
    const pool = new Pool({ connectionString: PG_URL, max: 6 });
    const pg = drizzle(pool);
    const awal = await pool.query("SELECT value, updated_by, updated_at::text AS updated_at FROM app_setting WHERE key = $1", [KONSTANTA_KEY]);
    const alih = (["select", "insert", "update"] as const).map((k) => mock.method(db, k, (...a: unknown[]) => (pg[k] as (...x: unknown[]) => unknown)(...a)));
    try {
        await pool.query("DELETE FROM app_setting WHERE key = $1", [KONSTANTA_KEY]);
        await fn(pool);
    } finally {
        for (const m of alih) m.mock.restore();
        await pool.query("DELETE FROM app_setting WHERE key = $1", [KONSTANTA_KEY]);
        const r = awal.rows[0];
        if (r) await pool.query("INSERT INTO app_setting (key, value, updated_by, updated_at) VALUES ($1, $2, $3, $4::timestamp)", [KONSTANTA_KEY, r.value, r.updated_by, r.updated_at]);
        await pool.end();
    }
}

/** Dua penyimpan bersamaan di balik kunci tabel: SELECT jalan, INSERT/UPDATE tertahan sampai keduanya menunggu. */
async function bersamaan(pool: Pool, a: () => Promise<unknown>, b: () => Promise<unknown>) {
    const penahan = await pool.connect();
    try {
        await penahan.query("BEGIN");
        await penahan.query("LOCK TABLE app_setting IN SHARE ROW EXCLUSIVE MODE");
        const pid = (await penahan.query("SELECT pg_backend_pid() AS p")).rows[0].p;
        const hasil = Promise.allSettled([a(), b()]);
        let menunggu = 0;
        for (let i = 0; i < 400 && menunggu < 2; i++) {
            await new Promise((r) => setTimeout(r, 25));
            menunggu = (await pool.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1 AND query ILIKE '%app_setting%'",
                [pid])).rows[0].n;
        }
        await penahan.query("COMMIT");
        return { hasil: await hasil, menunggu };
    } finally {
        penahan.release();
    }
}

const tolak409 = (h: PromiseSettledResult<unknown>[]) => h.filter((x) => x.status === "rejected" && x.reason instanceof KonstantaBerubahError).length;

test("PG: dua penyimpan PERTAMA bersamaan (versi null) → satu tersimpan, satu 409 (INSERT ON CONFLICT DO NOTHING)", { skip: pgSkip }, async () => {
    await denganPg(async (pool) => {
        const { hasil, menunggu } = await bersamaan(pool,
            () => setKonstanta({ gt: { pool1: 1_111_000 } }, "admin-a", null),
            () => setKonstanta({ spv: { rate1: 1_222_000 } }, "admin-b", null));
        assert.equal(menunggu, 2, "penghalang tidak menahan kedua penyimpan");
        assert.deepEqual(hasil.map((x) => x.status).sort(), ["fulfilled", "rejected"], JSON.stringify(hasil.map((x) => x.status === "rejected" ? String(x.reason) : "ok")));
        assert.equal(tolak409(hasil), 1, "penyimpan kedua harus 409, bukan galat unik/ditimpa");
        const { konstanta } = await readKonstantaVersi();
        const aMenang = hasil[0].status === "fulfilled";
        assert.equal(konstanta.gt.pool1, aMenang ? 1_111_000 : DEFAULT_KONSTANTA.gt.pool1);
        assert.equal(konstanta.spv.rate1, aMenang ? DEFAULT_KONSTANTA.spv.rate1 : 1_222_000);
    });
});

test("PG: dua penyimpan dari versi yang sama → satu 409 (UPDATE bersyarat isi); versi basi → 409; versi terbaru → tersimpan", { skip: pgSkip }, async () => {
    await denganPg(async (pool) => {
        await setKonstanta({}, "seed", null);
        const { versi: v0 } = await readKonstantaVersi(); // versi seperti yang dilihat editor (GET), bukan nilai balik tulis
        const { hasil, menunggu } = await bersamaan(pool,
            () => setKonstanta({ gt: { pool1: 1_333_000 } }, "admin-a", v0),
            () => setKonstanta({ spv: { rate1: 1_444_000 } }, "admin-b", v0));
        assert.equal(menunggu, 2, "penghalang tidak menahan kedua penyimpan");
        assert.equal(tolak409(hasil), 1, JSON.stringify(hasil.map((x) => x.status === "rejected" ? String(x.reason) : "ok")));
        const tersimpan = await readKonstantaVersi();
        const aMenang = hasil[0].status === "fulfilled";
        assert.equal(tersimpan.konstanta.gt.pool1, aMenang ? 1_333_000 : DEFAULT_KONSTANTA.gt.pool1, "perubahan pemenang hilang / ditimpa");
        assert.equal(tersimpan.konstanta.spv.rate1, aMenang ? DEFAULT_KONSTANTA.spv.rate1 : 1_444_000);
        await assert.rejects(setKonstanta({ gt: { pool1: 1 } }, "admin-basi", v0), KonstantaBerubahError);
        const ok = await setKonstanta({ gt: { pool1: 1_555_000 } }, "admin-c", tersimpan.versi);
        assert.equal(ok.konstanta.gt.pool1, 1_555_000);
        assert.equal((await readKonstantaVersi()).konstanta.gt.pool1, 1_555_000);
    });
});

// ---------------------------------------------------------------- route PATCH settings (S6-0c perbaikan 7a/7b)
async function denganAdminLokal<T>(fn: () => Promise<T>): Promise<T> {
    const env = { NODE_ENV: process.env.NODE_ENV, LOCAL_AUTH_BYPASS: process.env.LOCAL_AUTH_BYPASS };
    Object.assign(process.env, { NODE_ENV: "development", LOCAL_AUTH_BYPASS: "true" });
    try {
        return await fn();
    } finally {
        for (const [k, v] of Object.entries(env)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}
const patchReq = (body: unknown) => new NextRequest("http://localhost/api/insentif-sales/settings", {
    method: "PATCH", headers: { host: "localhost:3000", "content-type": "application/json" }, body: JSON.stringify(body),
});
/** insert(appSetting).values().onConflictDoUpdate() — dicatat, tidak menulis. */
const catatInsert = () => mock.method(db, "insert", () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }));

test("PATCH daftar saat konstanta tak terbaca → 200 berlabel gagal_baca, bukan 500 padahal daftar sudah tertulis (7a)", async () => {
    await denganAdminLokal(async () => {
        const select = mock.method(db, "select", () => { throw new Error("statement timeout"); });
        const insert = catatInsert();
        try {
            const res = await patchSettings(patchReq({ smBerhak: ["SM A"] }));
            assert.equal(res.status, 200);
            const data = await res.json();
            assert.equal(data.konstantaSumber, "gagal_baca");
            assert.equal(data.konstantaVersi, null);
            assert.equal(insert.mock.callCount(), 1, "daftar harus tertulis");
            // Dengan konstanta di badan, jawaban tetap dibaca STRICT (dasar draf berikutnya): versi tak terbaca → 409 (cek versi).
        } finally {
            select.mock.restore();
            insert.mock.restore();
        }
    });
});

test("PATCH gabungan tidak menulis sebagian: konstanta ditolak (400 atau 409) → penyebut AO/daftar TIDAK tertulis (7b)", async () => {
    await denganAdminLokal(async () => {
        const select = tersimpan();
        const insert = catatInsert();
        const update = updateMengembalikan([{ key: "x" }]);
        try {
            const tidakSah = await patchSettings(patchReq({ gtAoMode: "file", smBerhak: ["SM A"], konstanta: { gt: { pool1: -1 } }, konstantaVersi: T.toISOString() }));
            assert.equal(tidakSah.status, 400);
            const basi = await patchSettings(patchReq({ gtAoMode: "file", smBerhak: ["SM A"], konstanta: { gt: { pool1: 2_000_000 } }, konstantaVersi: "2026-09-29T00:00:00.000Z" }));
            assert.equal(basi.status, 409);
            const tanpaVersi = await patchSettings(patchReq({ branchNilaiJual: ["CABANG A"], konstanta: { gt: { pool1: 2_000_000 } } }));
            assert.equal(tanpaVersi.status, 400);
            assert.equal(insert.mock.callCount(), 0, "setelan lain tertulis walau konstanta ditolak");
            assert.equal(update.mock.callCount(), 0);
            // Kontrol: versi cocok → konstanta ditulis (update) DAN penyebut AO/daftar ditulis (insert).
            const ok = await patchSettings(patchReq({ gtAoMode: "file", smBerhak: ["SM A"], konstanta: { gt: { pool1: 2_000_000 } }, konstantaVersi: T.toISOString() }));
            assert.equal(ok.status, 200);
            assert.equal(update.mock.callCount(), 1);
            assert.equal(insert.mock.callCount(), 2);
        } finally {
            select.mock.restore();
            insert.mock.restore();
            update.mock.restore();
        }
    });
});
