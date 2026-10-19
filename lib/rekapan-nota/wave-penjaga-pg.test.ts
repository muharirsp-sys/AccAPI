/* BL-24 / BL-25 / BL-54 Rekapan Nota (14 Okt 2026) di Postgres EVALUASI (AM040_DATABASE_URL, bukan produksi): route ASLI pada SKEMA
 * SEKALI-PAKAI (user/item/customer/app_setting/user_group/group_permission disalin `LIKE public.*`, lalu db/migrations/0002_rekapan_nota.sql
 * dijalankan di skema itu; search_path hanya skema itu; DROP di akhir). Sesi Better Auth dipalsukan; peran legacy admin = semua izin.
 * Uji serentak dibuat deterministik: transaksi uji memegang kunci baris/tabel, menunggu route benar-benar tertahan (pg_stat_activity
 * per application_name), lalu melepas. Tidak boleh menggantung: lock_timeout/statement_timeout di semua koneksi uji, batas waktu per
 * uji, dan koneksi yang tersisa diputus sebelum DROP SCHEMA. Data contoh generik. Tanpa env dilewati. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import * as XLSX from "xlsx";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";

const TABEL = ["user", "item", "customer", "app_setting", "user_group", "group_permission"];
const skema = `uji_rekapan_${randomUUID().slice(0, 8)}`;
const APP = skema; // application_name koneksi route: penanda "route ini sedang menunggu kunci"
const BATAS = "-c lock_timeout=10s -c statement_timeout=30s"; // regresi yang menunggu kunci jadi merah, bukan menggantung
const T_UJI = { skip: pgSkip, timeout: 120_000 } as const;
type Ctx = { params: Promise<{ id: string }> };
type Handler = (req: Request, ctx: Ctx) => Promise<Response>;
let admin: Pool;
let db: Pool;
let rWave: { GET: (req: Request) => Promise<Response>; POST: (req: Request) => Promise<Response> };
let rWaveId: { GET: Handler; PATCH: Handler };
let rNota: { POST: Handler; PATCH: Handler };
let rExc: { PATCH: Handler };
let rUpload: { POST: (req: Request) => Promise<Response> };
let notaPool: (tanggal: string) => Promise<Array<{ no_nota: string }>>;

let sesi: { id: string; name: string; role: string } | null = null;
const sebagai = async (userId: string) => { sesi = (await db.query(`SELECT id, name, role FROM "user" WHERE id = $1`, [userId])).rows[0] ?? null; };
const ctx = (id: number): Ctx => ({ params: Promise.resolve({ id: String(id) }) });
const jsonReq = (url: string, method: string, body: unknown) =>
    new Request(`http://app.test${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function jawab(p: Promise<Response>) { const r = await p; return { status: r.status, body: await r.json() as Record<string, unknown> }; }

const waveBaru = async (tanggal: string, urutan: number) => Number((await jawab(rWave.POST(jsonReq("/api/rekapan-nota/wave", "POST", { tanggal, urutan, nama: `Uji ${urutan}` })))).body.id);
const tambah = (id: number, noNota: string[]) => jawab(rNota.POST(jsonReq(`/x/${id}/nota`, "POST", { noNota }), ctx(id)));
const transisi = (id: number, aksi: string, alasan?: string) => jawab(rWaveId.PATCH(jsonReq(`/x/${id}`, "PATCH", { aksi, alasan }), ctx(id)));
const ubahNota = (id: number, body: Record<string, unknown>) => jawab(rNota.PATCH(jsonReq(`/x/${id}/nota`, "PATCH", body), ctx(id)));
const tutup = (id: number, exceptionId: number, aksi: string, alasan?: string) =>
    jawab(rExc.PATCH(jsonReq(`/x/${id}/exception`, "PATCH", { exceptionId, aksi, alasan }), ctx(id)));
const statusWave = async (id: number) => (await db.query(`SELECT status::text FROM wave WHERE id = $1`, [id])).rows[0].status as string;

const KOLOM = ["NO_NOTA", "TANGGAL", "KODE PELANGGAN INDUK", "NAMA PELANGGAN FAKTUR PENJUALAN", "KODE_BARANG", "NAMA_BARANG",
    "QTY", "SATUAN", "QTY_SATUANKECIL", "SATUAN_KECIL", "JENIS PRODUK", "PRINCIPLE"];
/** baris: [nota, kode barang, qty, pcs, satuan (bawaan CTN)]; isi per karton tersirat = pcs/qty bila satuan bukan PCS. */
function xlsx(tanggal: string, baris: Array<[string, string, number, number, string?]>, ekstra = ""): Buffer {
    const rows = baris.map(([n, b, q, p, sat = "CTN"]) => [n, tanggal, `C-${n}`, `TOKO ${n}${ekstra}`, b, `BARANG ${b}`, q, sat, p, "PCS", "PRINCIPLE A", "PRINCIPLE A"]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([KOLOM, ...rows]), "Rincian");
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
function unggah(tanggal: string, buf: Buffer, nama = "export.xlsx") {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(buf)], nama));
    form.append("tanggal", tanggal);
    return jawab(rUpload.POST(new Request("http://app.test/api/rekapan-nota/upload", { method: "POST", body: form })));
}

/** Tunggu sampai `n` koneksi route tertahan kunci (maks ~5 dtk). false = tidak pernah tertahan (mis. penjaga disabotase). */
async function tertahan(n: number) {
    for (let i = 0; i < 100; i++) {
        const r = await admin.query<{ n: number }>(
            `SELECT count(*)::int n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`, [APP]);
        if (r.rows[0].n >= n) return true;
        await new Promise((ok) => setTimeout(ok, 50));
    }
    return false;
}
/** Transaksi "layar lain" pada koneksi terpisah; `lepas()` = COMMIT. */
async function layarLain(sql: string[]) {
    const c: PoolClient = await admin.connect();
    await c.query("BEGIN");
    await c.query(`SET LOCAL search_path = ${skema}`);
    for (const q of sql) await c.query(q);
    return { lepas: async () => { await c.query("COMMIT"); c.release(); } };
}

before(async () => {
    if (!PG_URL) return;
    const ua = new URL(PG_URL);
    ua.searchParams.set("options", BATAS);
    ua.searchParams.set("application_name", `${APP}-admin`);
    admin = new Pool({ connectionString: ua.toString(), max: 4 });
    await admin.query(`CREATE SCHEMA ${skema}`);
    for (const t of TABEL) await admin.query(`CREATE TABLE ${skema}."${t}" (LIKE public."${t}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    const u = new URL(PG_URL);
    u.searchParams.set("options", `-c search_path=${skema} ${BATAS}`);
    u.searchParams.set("application_name", APP);
    const migrasi = await readFile(new URL("../../db/migrations/0002_rekapan_nota.sql", import.meta.url), "utf8");
    const satu = new Pool({ connectionString: u.toString(), max: 1 });
    await satu.query(migrasi);
    await satu.query(`INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt") VALUES
        ('u-gudang', 'Admin Gudang A', 'gudang@uji.test', true, 'admin', now(), now()),
        ('u-lain', 'Admin Gudang B', 'gudang-b@uji.test', true, 'admin', now(), now()),
        ('u-fin', 'Finance A', 'fin@uji.test', true, 'finance', now(), now())`);
    // BRG-A: file 24, master 12 (KONVERSI_BEDA); BRG-B tanpa master + dijual PCS (KONVERSI_TIDAK_ADA); BRG-C cocok 12.
    await satu.query(`INSERT INTO item (id, no, name, isi_per_karton) VALUES (1, 'BRG-A', 'BARANG A', 12), (2, 'BRG-C', 'BARANG C', 12)`);
    await satu.end();

    process.env.DATABASE_URL = u.toString();
    process.env.PG_STATEMENT_TIMEOUT_MS = "30000";
    delete process.env.LOCAL_AUTH_BYPASS;
    const auth = (await import("../auth.ts")).auth;
    Object.defineProperty(auth.api, "getSession", { configurable: true,
        value: async () => (sesi ? { user: { ...sesi, email: `${sesi.id}@uji.test` }, session: { id: "s" } } : null) });
    db = (await import("../db.ts")).pool;
    rWave = await import("../../app/api/rekapan-nota/wave/route.ts") as unknown as typeof rWave;
    rWaveId = await import("../../app/api/rekapan-nota/wave/[id]/route.ts") as unknown as typeof rWaveId;
    rNota = await import("../../app/api/rekapan-nota/wave/[id]/nota/route.ts") as unknown as typeof rNota;
    rExc = await import("../../app/api/rekapan-nota/wave/[id]/exception/route.ts") as unknown as typeof rExc;
    rUpload = await import("../../app/api/rekapan-nota/upload/route.ts") as unknown as typeof rUpload;
    notaPool = (await import("./query.ts")).notaPool;
    await sebagai("u-gudang");
});

after(async () => {
    if (!PG_URL) return;
    await db?.end().catch(() => {});
    admin.on("error", () => {}); // koneksi idle admin yang diputus di bawah melapor lewat event ini
    const c = await admin.connect(); // putus + DROP di SATU koneksi: tidak ada koneksi mati yang dipakai ulang
    await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                    WHERE application_name IN ($1, $2) AND pid <> pg_backend_pid()`, [APP, `${APP}-admin`]);
    await c.query(`DROP SCHEMA ${skema} CASCADE`);
    c.release();
    await admin.end();
});

test("BL-54: file sore tidak menggandakan nota pagi; berubah sebelum wave diganti, sesudah wave jadi exception", T_UJI, async () => {
    const T = "2026-10-06";
    const pagi = await unggah(T, xlsx(T, [["N1", "BRG-C", 2, 24], ["N2", "BRG-C", 1, 12], ["N3", "BRG-C", 5, 60], ["N5", "BRG-A", 1, 12], ["N6", "BRG-C", 1, 12]]), "pagi.xlsx");
    assert.equal(pagi.status, 200);
    assert.deepEqual([pagi.body.notaBaru, pagi.body.notaSudahAda, pagi.body.notaDiganti], [5, 0, 0]);
    const w = await waveBaru(T, 1);
    assert.equal((await tambah(w, ["N1"])).status, 200);

    // Sore: N1 berubah (di wave), N2 berubah (belum di wave), N3 sama, N4 baru, N5 barang DITUKAR dengan qty sama,
    // N6 baris bertambah. Alamat/nama outlet beda tidak dihitung berubah.
    const sore = await unggah(T, xlsx(T, [["N1", "BRG-C", 3, 36], ["N2", "BRG-C", 2, 24], ["N3", "BRG-C", 5, 60], ["N4", "BRG-C", 1, 12],
        ["N5", "BRG-C", 1, 12], ["N6", "BRG-C", 1, 12], ["N6", "BRG-A", 1, 12]], " (ketik ulang)"), "sore.xlsx");
    assert.equal(sore.status, 200);
    assert.deepEqual([sore.body.notaBaru, sore.body.notaSudahAda, sore.body.notaDiganti], [1, 1, 3]);
    assert.deepEqual(sore.body.notaSelisih, [{ noNota: "N1", waveId: w, wave: "Uji 1" }]);

    const dobel = await db.query(`SELECT no_nota FROM wave_line_pool WHERE tanggal = $1 GROUP BY no_nota HAVING count(*) > count(DISTINCT kode_barang) OR count(DISTINCT upload_id) > 1`, [T]);
    assert.deepEqual(dobel.rows, [], "satu nota = satu set baris di pool tanggal itu");
    const qty = Object.fromEntries((await db.query(`SELECT no_nota, qty_pcs::float8 q FROM wave_line_pool WHERE tanggal = $1`, [T])).rows.map((r) => [r.no_nota, r.q]));
    assert.deepEqual(qty, { N1: 24, N2: 24, N3: 60, N4: 12, N5: 12, N6: 12 }, "N1 tetap isi yang di wave; N2 diganti isi terbaru");
    const brg = (await db.query(`SELECT no_nota, string_agg(kode_barang, ',' ORDER BY kode_barang) b FROM wave_line_pool WHERE tanggal = $1 AND no_nota IN ('N5','N6') GROUP BY 1 ORDER BY 1`, [T])).rows;
    assert.deepEqual(brg, [{ no_nota: "N5", b: "BRG-C" }, { no_nota: "N6", b: "BRG-A,BRG-C" }], "barang ditukar & baris bertambah = berubah");
    const exc = await db.query(`SELECT jenis::text, ref_tipe, ref_kode, status::text FROM wave_exception WHERE wave_id = $1`, [w]);
    assert.deepEqual(exc.rows, [{ jenis: "REKONSILIASI_SELISIH", ref_tipe: "nota", ref_kode: "N1", status: "open" }]);

    // Unggah ketiga (file lain, selisih sama): exception tidak menumpuk.
    const lagi = await unggah(T, xlsx(T, [["N1", "BRG-C", 3, 36]], " x"), "malam.xlsx");
    assert.equal(lagi.status, 200);
    assert.equal((await db.query(`SELECT count(*)::int n FROM wave_exception WHERE wave_id = $1`, [w])).rows[0].n, 1);
});

test("BL-54 serentak: dua file berbeda dengan nota yang sama diunggah bersamaan -> nota tetap satu kali di pool", T_UJI, async () => {
    const T = "2026-10-07";
    const kunci = await layarLain([`LOCK TABLE wave_line_pool IN SHARE MODE`]); // tahan semua INSERT pool
    const a = unggah(T, xlsx(T, [["N10", "BRG-C", 1, 12], ["N11", "BRG-C", 1, 12]]), "a.xlsx");
    const b = unggah(T, xlsx(T, [["N10", "BRG-C", 1, 12], ["N12", "BRG-C", 1, 12]]), "b.xlsx");
    const tahan = await tertahan(2);
    await kunci.lepas();
    assert.ok(tahan, "kedua unggahan harus benar-benar bertemu kunci");
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual([ra.status, rb.status], [200, 200]);
    assert.equal(Number(ra.body.notaBaru) + Number(rb.body.notaBaru), 3, "N10 hanya baru di salah satu unggahan");
    const n10 = await db.query(`SELECT count(*)::int n FROM wave_line_pool WHERE tanggal = $1 AND no_nota = 'N10'`, [T]);
    assert.equal(n10.rows[0].n, 1);
});

test("BL-54 serentak: file yang sama diunggah dua kali bersamaan -> diproses berurutan, yang kedua '0 baru, 1 sudah ada', tanpa 500", T_UJI, async () => {
    const T = "2026-10-08";
    const buf = xlsx(T, [["N20", "BRG-C", 1, 12]]);
    const kunci = await layarLain([`LOCK TABLE wave_line_pool IN SHARE MODE`]);
    const a = unggah(T, buf);
    const b = unggah(T, buf);
    const tahan = await tertahan(2);
    await kunci.lepas();
    assert.ok(tahan, "kedua unggahan harus benar-benar bertemu kunci");
    const hasil = await Promise.all([a, b]);
    assert.deepEqual(hasil.map((h) => h.status), [200, 200], JSON.stringify(hasil.map((h) => h.body)));
    assert.deepEqual(hasil.map((h) => [h.body.notaBaru, h.body.notaSudahAda]).sort(), [[0, 1], [1, 0]]);
    assert.equal(hasil.filter((h) => h.body.fileSama === true).length, 1);
    assert.equal((await db.query(`SELECT count(*)::int n FROM wave_line_pool WHERE tanggal = $1`, [T])).rows[0].n, 1);
});

test("BL-24: exception ditutup Selesai/Abaikan beralasan; 409 bila sudah ditutup (termasuk serentak); konfirmasi lolos sesudahnya", T_UJI, async () => {
    const T = "2026-10-09";
    // BRG-A: file 24/karton vs master 12; BRG-B: dijual PCS (tanpa konversi) dan tanpa master.
    const up = await unggah(T, xlsx(T, [["N30", "BRG-A", 1, 24], ["N30", "BRG-B", 6, 6, "PCS"]]));
    assert.equal(up.status, 200);
    const w = await waveBaru(T, 1);
    assert.equal((await tambah(w, ["N30"])).status, 200);
    assert.equal((await transisi(w, "release")).status, 200);
    const exc = Object.fromEntries((await db.query(`SELECT jenis::text, id::int FROM wave_exception WHERE wave_id = $1`, [w])).rows.map((r) => [r.jenis, r.id]));
    assert.ok(exc.KONVERSI_BEDA_DENGAN_EXPORT && exc.KONVERSI_TIDAK_ADA, JSON.stringify(exc));

    const ditahan = await transisi(w, "confirm");
    assert.equal(ditahan.status, 409);
    assert.match(String(ditahan.body.error), /2 exception konversi/);

    const detail = await jawab(rWaveId.GET(new Request(`http://app.test/x/${w}`), ctx(w)));
    const beda = (detail.body.exception as Array<Record<string, unknown>>).find((e) => e.jenis === "KONVERSI_BEDA_DENGAN_EXPORT");
    assert.equal(beda?.master_saat_ini, "12", "nilai master saat ini sebagai petunjuk");

    await sebagai("u-fin");
    assert.equal((await tutup(w, exc.KONVERSI_BEDA_DENGAN_EXPORT, "selesai")).status, 403);
    await sebagai("u-gudang");
    assert.equal((await tutup(w, exc.KONVERSI_BEDA_DENGAN_EXPORT, "abaikan")).status, 400, "abaikan tanpa alasan ditolak");
    assert.equal((await tutup(w + 999, exc.KONVERSI_BEDA_DENGAN_EXPORT, "selesai")).status, 404);

    const ok = await tutup(w, exc.KONVERSI_BEDA_DENGAN_EXPORT, "abaikan", "file benar; master sedang dikoreksi");
    assert.equal(ok.status, 200);
    const row = (await db.query(`SELECT status::text, resolved_by, resolved_at IS NOT NULL AS ada FROM wave_exception WHERE id = $1`, [exc.KONVERSI_BEDA_DENGAN_EXPORT])).rows[0];
    assert.deepEqual(row, { status: "diabaikan", resolved_by: "u-gudang", ada: true });
    const ev = await db.query(`SELECT payload FROM wave_event WHERE wave_id = $1 AND event = 'wave.exception_resolved'`, [w]);
    assert.equal(ev.rows[0].payload.alasan, "file benar; master sedang dikoreksi");
    const kedua = await tutup(w, exc.KONVERSI_BEDA_DENGAN_EXPORT, "selesai");
    assert.equal(kedua.status, 409, "sudah ditutup -> 409, keputusan pertama tidak ditimpa");
    assert.equal((await db.query(`SELECT status::text FROM wave_exception WHERE id = $1`, [exc.KONVERSI_BEDA_DENGAN_EXPORT])).rows[0].status, "diabaikan");

    // Serentak: layar lain menandai Selesai lebih dulu (belum commit); route menunggu baris itu lalu 409.
    const lain = await layarLain([`UPDATE wave_exception SET status = 'selesai', resolved_at = now(), resolved_by = 'u-lain' WHERE id = ${exc.KONVERSI_TIDAK_ADA}`]);
    const balapan = tutup(w, exc.KONVERSI_TIDAK_ADA, "abaikan", "barang tidak dikirim");
    const tahan = await tertahan(1);
    await lain.lepas();
    assert.ok(tahan, "route harus menunggu layar lain");
    const kalah = await balapan;
    assert.equal(kalah.status, 409, JSON.stringify(kalah.body));
    assert.equal((await db.query(`SELECT resolved_by FROM wave_exception WHERE id = $1`, [exc.KONVERSI_TIDAK_ADA])).rows[0].resolved_by, "u-lain");

    assert.equal((await transisi(w, "confirm")).status, 200, "semua KONVERSI_* ditutup -> konfirmasi lolos");
});

test("BL-25: batal melepas semua nota (kembali ke pool, bisa masuk wave lain); wave tertutup menolak ubah isi", T_UJI, async () => {
    const T = "2026-10-10";
    assert.equal((await unggah(T, xlsx(T, ["N40", "N41", "N42", "N43", "N44"].map((n) => [n, "BRG-C", 1, 12] as [string, string, number, number])))).status, 200);
    const w1 = await waveBaru(T, 1);
    assert.equal((await tambah(w1, ["N40", "N41"])).status, 200);
    const batal = await transisi(w1, "cancel", "mobil rute A rusak");
    assert.equal(batal.status, 200);
    assert.equal(batal.body.notaKembali, 2);
    const lepas = await db.query(`SELECT DISTINCT dilepas, dilepas_alasan, dilepas_by, dilepas_at IS NOT NULL AS ada FROM wave_assignment WHERE wave_id = $1`, [w1]);
    assert.deepEqual(lepas.rows, [{ dilepas: true, dilepas_alasan: "wave dibatalkan", dilepas_by: "u-gudang", ada: true }]);
    assert.deepEqual((await notaPool(T)).map((r) => r.no_nota).filter((n) => n === "N40" || n === "N41"), ["N40", "N41"]);
    const ev = await db.query(`SELECT payload FROM wave_event WHERE wave_id = $1 AND event = 'wave.cancelled'`, [w1]);
    assert.deepEqual(ev.rows[0].payload.nota_kembali.sort(), ["N40", "N41"]);

    // Wave batal: semua ubah isi 409 (bukan 404/200).
    await db.query(`INSERT INTO wave_exception (wave_id, jenis, ref_tipe, ref_kode) VALUES ($1, 'OUTLET_TANPA_AREA', 'customer', 'C-N40')`, [w1]);
    const excBatal = (await db.query(`SELECT id::int FROM wave_exception WHERE wave_id = $1`, [w1])).rows[0].id;
    assert.equal((await ubahNota(w1, { aksi: "takeout", noNota: "N40", alasan: "uji wave batal" })).status, 409);
    assert.equal((await ubahNota(w1, { aksi: "prioritas", noNota: "N40", prioritas: "urgent" })).status, 409);
    assert.equal((await jawab(rWaveId.PATCH(jsonReq(`/x/${w1}`, "PATCH", { aksi: "set_grup", pickGroupIds: [] }), ctx(w1)))).status, 409);
    assert.equal((await tutup(w1, excBatal, "selesai")).status, 409);

    // Wave lain hari ini bisa memakai nota yang dilepas.
    const w2 = await waveBaru(T, 2);
    assert.deepEqual((await tambah(w2, ["N40", "N42"])).body.masuk, ["N40", "N42"]);
    assert.equal((await transisi(w2, "release")).status, 200);
    assert.equal((await transisi(w2, "confirm")).status, 200);
    const kunci = await ubahNota(w2, { aksi: "takeout", noNota: "N40", alasan: "uji wave dikonfirmasi" });
    assert.equal(kunci.status, 409);
    assert.match(String(kunci.body.error), /dikonfirmasi/);
    assert.equal((await ubahNota(w2, { aksi: "prioritas", noNota: "N40", prioritas: "urgent" })).status, 409);
    assert.equal((await jawab(rWaveId.PATCH(jsonReq(`/x/${w2}`, "PATCH", { aksi: "set_grup", pickGroupIds: [] }), ctx(w2)))).status, 409);
    assert.equal((await db.query(`SELECT count(*)::int n FROM wave_assignment WHERE wave_id = $1 AND dilepas = false`, [w2])).rows[0].n, 2);
});

test("BL-25 serentak: layar lain mengonfirmasi saat batal/lepas sedang berjalan -> 409, tidak ada yang tertimpa", T_UJI, async () => {
    const T = "2026-10-11";
    assert.equal((await unggah(T, xlsx(T, [["N50", "BRG-C", 1, 12], ["N51", "BRG-C", 1, 12]]))).status, 200);
    const konfirmasiLain = (id: number) => [`UPDATE wave SET status = 'confirmed', confirmed_at = now(), confirmed_by = 'u-lain' WHERE id = ${id}`];

    // Batal vs konfirmasi: route membaca "released" sebelum transaksinya, lalu UPDATE-nya menunggu baris wave.
    const w3 = await waveBaru(T, 1);
    await tambah(w3, ["N50"]);
    await transisi(w3, "release");
    const lain = await layarLain(konfirmasiLain(w3));
    const batal = transisi(w3, "cancel", "uji balapan");
    const tahan = await tertahan(1);
    await lain.lepas();
    assert.ok(tahan, "route harus menunggu layar lain");
    const hasil = await batal;
    assert.equal(hasil.status, 409, JSON.stringify(hasil.body));
    assert.equal(await statusWave(w3), "confirmed", "konfirmasi layar lain tidak ditimpa batal");
    assert.equal((await db.query(`SELECT count(*)::int n FROM wave_assignment WHERE wave_id = $1 AND dilepas = false`, [w3])).rows[0].n, 1, "nota tidak dilepas");

    // Lepas nota vs konfirmasi: route mengunci wave FOR SHARE, jadi melihat status sesudah layar lain commit.
    const w4 = await waveBaru(T, 2);
    await tambah(w4, ["N51"]);
    await transisi(w4, "release");
    const lain2 = await layarLain(konfirmasiLain(w4));
    const lepas = ubahNota(w4, { aksi: "takeout", noNota: "N51", alasan: "toko minta besok" });
    const tahan2 = await tertahan(1);
    await lain2.lepas();
    assert.ok(tahan2, "lepas nota harus menunggu konfirmasi layar lain");
    const h2 = await lepas;
    assert.equal(h2.status, 409, JSON.stringify(h2.body));
    assert.equal((await db.query(`SELECT dilepas FROM wave_assignment WHERE wave_id = $1`, [w4])).rows[0].dilepas, false);
});

test("BL-25: exception terbuka di wave batal tidak dihitung sebagai pekerjaan terbuka di daftar wave", T_UJI, async () => {
    const T = "2026-10-12";
    assert.equal((await unggah(T, xlsx(T, [["N60", "BRG-C", 1, 12]]))).status, 200);
    const w = await waveBaru(T, 1);
    await tambah(w, ["N60"]);
    await transisi(w, "release"); // OUTLET_TANPA_AREA terbuka (outlet uji tanpa area)
    const daftar = async () => ((await jawab(rWave.GET(new Request(`http://app.test/api/rekapan-nota/wave?tanggal=${T}`)))).body.wave as Array<{ id: number; exception_open: number }>).find((x) => x.id === w)!;
    assert.ok((await daftar()).exception_open > 0);
    assert.equal((await transisi(w, "cancel", "uji daftar")).status, 200);
    assert.equal((await daftar()).exception_open, 0);
});

test("R2: file sama diunggah ulang diproses per nota -- nota yang kembali dari wave batal mendapat isi file; file lama tidak menimpa isi lebih baru", T_UJI, async () => {
    const T = "2026-10-13";
    const pagi = xlsx(T, [["N80", "BRG-C", 1, 12], ["N81", "BRG-C", 1, 12]]);
    const sore = xlsx(T, [["N80", "BRG-C", 2, 24], ["N81", "BRG-C", 3, 36]]);
    assert.equal((await unggah(T, pagi, "pagi.xlsx")).status, 200);
    const w = await waveBaru(T, 1);
    await tambah(w, ["N80"]);
    const s1 = await unggah(T, sore, "sore.xlsx");
    assert.deepEqual([s1.body.notaDiganti, (s1.body.notaSelisih as unknown[]).length], [1, 1], "N81 diganti, N80 selisih");
    assert.equal((await transisi(w, "cancel", "uji unggah ulang")).status, 200);

    const ulang = await unggah(T, sore, "sore.xlsx");
    assert.equal(ulang.status, 200);
    assert.deepEqual([ulang.body.fileSama, ulang.body.notaBaru, ulang.body.notaSudahAda, ulang.body.notaDiganti], [true, 0, 1, 1]);
    const pcs = async () => Object.fromEntries((await db.query(`SELECT no_nota, sum(qty_pcs)::float8 q FROM wave_line_pool WHERE tanggal = $1 GROUP BY 1`, [T])).rows.map((r) => [r.no_nota, r.q]));
    assert.deepEqual(await pcs(), { N80: 24, N81: 36 });

    // File pagi (lebih lama) diunggah ulang: isi sore di pool tidak ditimpa.
    const lama = await unggah(T, pagi, "pagi.xlsx");
    assert.deepEqual([lama.body.fileSama, lama.body.notaLebihBaru, lama.body.notaDiganti], [true, 2, 0]);
    assert.deepEqual(await pcs(), { N80: 24, N81: 36 });
});

test("R1: selisih file yang sudah ditutup dibuka lagi hanya bila isi file BERBEDA dari selisih yang dicatat", T_UJI, async () => {
    const T = "2026-10-14";
    assert.equal((await unggah(T, xlsx(T, [["N90", "BRG-C", 1, 12]]), "pagi.xlsx")).status, 200);
    const w = await waveBaru(T, 1);
    await tambah(w, ["N90"]);
    assert.equal((await unggah(T, xlsx(T, [["N90", "BRG-C", 2, 24]]), "sore.xlsx")).status, 200);
    const exc = async () => (await db.query(`SELECT id::int, status::text, resolved_by FROM wave_exception WHERE wave_id = $1 AND jenis = 'REKONSILIASI_SELISIH'`, [w])).rows;
    const [e] = await exc();
    assert.equal(e.status, "open");
    assert.equal((await tutup(w, e.id, "selesai")).status, 200);

    // File lain (byte beda) dengan selisih yang SAMA: tetap tertutup.
    assert.equal((await unggah(T, xlsx(T, [["N90", "BRG-C", 2, 24]], " (export ulang)"), "sore-2.xlsx")).status, 200);
    assert.deepEqual((await exc()).map((x) => x.status), ["selesai"]);
    // Selisih BARU: dibuka lagi, penutupan lama dikosongkan.
    assert.equal((await unggah(T, xlsx(T, [["N90", "BRG-C", 4, 48]]), "malam.xlsx")).status, 200);
    assert.deepEqual(await exc(), [{ id: e.id, status: "open", resolved_by: null }]);
});

test("M1 serentak: nota ditambah ke wave saat unggah sedang mengganti isinya -> snapshot karton dari isi baru", T_UJI, async () => {
    const T = "2026-10-15";
    assert.equal((await unggah(T, xlsx(T, [["N70", "BRG-C", 1, 12]]), "pagi.xlsx")).status, 200);
    const w = await waveBaru(T, 1);
    const kunci = await layarLain([`LOCK TABLE wave_line_pool IN SHARE MODE`]); // unggah tertahan SESUDAH klasifikasi
    const up = unggah(T, xlsx(T, [["N70", "BRG-C", 5, 60]]), "sore.xlsx");
    const tahanUnggah = await tertahan(1);
    const tb = tambah(w, ["N70"]);
    const tahanTambah = await tertahan(2); // tambah menunggu unggah (kunci bersama per tanggal)
    await kunci.lepas();
    const [ru, rt] = await Promise.all([up, tb]);
    assert.ok(tahanUnggah, "unggah harus tertahan kunci pool");
    assert.equal(rt.status, 200);
    assert.equal(ru.status, 200);
    const snap = (await db.query(`SELECT snap_total_krt::float8 k FROM wave_assignment WHERE wave_id = $1 AND no_nota = 'N70'`, [w])).rows[0].k;
    const poolKrt = (await db.query(`SELECT sum(qty_pcs)::float8 / 12 k FROM wave_line_pool WHERE tanggal = $1 AND no_nota = 'N70'`, [T])).rows[0].k;
    const selisih = (await db.query(`SELECT count(*)::int n FROM wave_exception WHERE wave_id = $1 AND jenis = 'REKONSILIASI_SELISIH'`, [w])).rows[0].n;
    assert.ok(snap === poolKrt || selisih === 1, `snapshot ${snap} krt vs pool ${poolKrt} krt tanpa exception (tambah tertahan: ${tahanTambah})`);
});

test("NON / LUAR KOTA: nota outlet ber-area itu ikut pool dan bisa masuk wave, seperti TTF Excel (owner 19 Okt 2026)", T_UJI, async () => {
    const T = "2026-10-16";
    await db.query(`INSERT INTO customer (id, "customerNo", name, area) VALUES (9101, 'C-NK1', 'TOKO A', 'NON'), (9102, 'C-NK2', 'TOKO B', 'LUAR KOTA')`);
    assert.equal((await unggah(T, xlsx(T, [["NK1", "BRG-C", 1, 12], ["NK2", "BRG-C", 1, 12]]))).status, 200);
    assert.deepEqual((await notaPool(T)).map((n) => n.no_nota).sort(), ["NK1", "NK2"]);
    const w = await waveBaru(T, 1);
    const r = await tambah(w, ["NK1", "NK2"]);
    assert.equal(r.status, 200);
    assert.deepEqual((r.body.masuk as string[]).sort(), ["NK1", "NK2"]);
});
