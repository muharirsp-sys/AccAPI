/* NOO (toko baru dari kunjungan salesman, owner 13 Okt 2026) di Postgres EVALUASI (AM040_DATABASE_URL, bukan produksi): route ASLI pada SKEMA
 * SEKALI-PAKAI (tabel disalin `LIKE public.*` + db/migrations/0033 + 0034 + 0035, search_path hanya skema itu, DROP di akhir). Sesi Better Auth
 * dipalsukan; izin dari tabel grup nyata; route memakai `headers()` -> lingkup permintaan Next tiruan (pola fk-msm2-pg.test.ts).
 * Dibuktikan: pengajuan multipart + kunjungan hari ini; cakupan per peran (salesman/SPV tim/SPV lain/SM/Admin/Admin Sales/Manager preset
 * produksi/Viewer); PRIVASI KTP (NIK tak pernah di respons daftar/rincian/galat/audit; lihat KTP dicatat; tanpa hak 403/404; SM pengganti
 * boleh); pembanding duplikat lintas tim tersamar (peninjau A R3); duplikat + konfirmasi wajib; transisi + serentak dengan KUNCI BARIS
 * DIPEGANG (peninjau A S1); HANYA grup Admin menautkan; antrean aktif tak terpotong (> 300 selesai, peninjau A T1); foto kedua gagal tulis ->
 * foto pertama dibuang (R2); body > 10,5 MB 413 + > 40 MP ditolak (R4); id sama isian beda 409; ORDER NOO ditolak; kunjungan ulang;
 * DDL_NOO 2× idempoten + VERIFIKASI (+ sabotase), migrate-pg OK->SKIP, = 0035 = Drizzle; RBAC_PRESET_NOO idempoten. Berkas foto uji ditulis ke data/private/noo
 * worktree dan dihapus di akhir. Data contoh generik. Tanpa env dilewati. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import sharp from "sharp";
import { getTableConfig } from "drizzle-orm/pg-core";
import { nooToko } from "../../db/schema.ts";
import { NOO_DIR } from "./uploads.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";

const TABEL = ["user", "access_group", "user_group", "group_permission", "permission_audit_log", "sales_profile", "jks_master", "ao_control_daily",
    "salesman_daily_report", "merchandising_check", "kontrol_audit_log", "customer", "branch", "accurate_employee", "item", "no_order_reason"];
const skema = `uji_noo_${randomUUID().slice(0, 8)}`;
const skemaLain: string[] = [];
let admin: Pool;
let pool: Pool;
const urlSkema = (s = skema) => { const u = new URL(PG_URL); u.searchParams.set("options", `-c search_path=${s}`); return u.toString(); };
const berkas = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");
const HARI_INI = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());
const NIK_A = "7371010101010012", NIK_B = "7371020202020034", NIK_C = "7371030303030056";

type Route = (req: Request, ctx?: unknown) => Promise<Response>;
async function muat() {
    (globalThis as Record<string, unknown>).AsyncLocalStorage ??= AsyncLocalStorage;
    const r = (p: string) => import(p) as Promise<Record<string, Route>>;
    return {
        ...await import("next/dist/server/app-render/work-async-storage.external.js"),
        ...await import("next/dist/server/app-render/work-unit-async-storage.external.js"),
        auth: (await import("../auth.ts")).auth,
        dbMod: await import("../db.ts"),
        noo: await r("../../app/api/form-kontrol/noo/route.ts"),
        satu: await r("../../app/api/form-kontrol/noo/[id]/route.ts"),
        lib: await import("./noo.ts"),
        aturan: await import("./noo-aturan.ts"),
        ktp: await r("../../app/api/form-kontrol/noo/[id]/ktp/route.ts"),
        foto: await r("../../app/api/form-kontrol/noo/[id]/foto-toko/route.ts"),
        ao: await r("../../app/api/form-kontrol/ao-control/route.ts"),
        luar: await r("../../app/api/form-kontrol/luar-rute/route.ts"),
        konf: await r("../../app/api/form-kontrol/luar-rute/konfirmasi/route.ts"),
        batal: await r("../../app/api/form-kontrol/luar-rute/batal/route.ts"),
        visit: await r("../../app/api/form-kontrol/visit/route.ts"),
        checkin: await r("../../app/api/form-kontrol/checkin/route.ts"),
        spv: await r("../../app/api/form-kontrol/spv-dashboard/route.ts"),
    };
}
let m: Awaited<ReturnType<typeof muat>>;

// Sesi per permintaan di AsyncLocalStorage (bukan variabel global): dua permintaan SERENTAK dari akun berbeda tidak saling menimpa sesi.
type Sesi = { id: string; name: string; role: string };
const sesiAls = new AsyncLocalStorage<Sesi | null>();
async function sebagai<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const sesi: Sesi | null = (await pool.query(`SELECT id, name, role FROM "user" WHERE id = $1`, [userId])).rows[0] ?? null;
    const store = { route: "/uji", forceStatic: false, dynamicShouldError: false };
    const unit = { type: "private-cache", phase: "render", headers: new Headers({ host: "app.test" }) };
    return sesiAls.run(sesi, () => m.workAsyncStorage.run(store as never, () => m.workUnitAsyncStorage.run(unit as never, fn)));
}
const req = (url: string, method = "GET", body?: unknown) => new Request(`http://app.test${url}`, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});
type J = { status: number; body: Record<string, unknown>; teks: string; header: Headers };
async function jawab(res: Response): Promise<J> {
    const teks = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(teks) as Record<string, unknown>; } catch { /* bukan JSON (gambar) */ }
    return { status: res.status, body, teks, header: res.headers };
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

let JPEG: Buffer;
const ISIAN = { namaToko: "TOKO BARU A", namaPemilik: "PEMILIK A", alamat: "JL. CONTOH 1 CABANG A", noHp: "0812-3456-7890", nik: NIK_A,
    namaKtp: "PEMILIK A", lat: "-5.147700", lng: "119.432700", akurasi: "15" };
function formNoo(o: Record<string, string | null> = {}, foto: { toko?: Buffer | null; ktp?: Buffer | null; tipe?: string } = {}) {
    const f = new FormData();
    const isi: Record<string, string | null> = { id: randomUUID(), salesCode: "M-SLA", principle: "PRINCIPLE A", ...ISIAN, ...o };
    for (const [k, v] of Object.entries(isi)) if (v !== null) f.set(k, v);
    const tipe = foto.tipe ?? "image/jpeg";
    if (foto.toko !== null) f.set("fotoToko", new File([new Uint8Array(foto.toko ?? JPEG)], "toko.jpg", { type: tipe }));
    if (foto.ktp !== null) f.set("fotoKtp", new File([new Uint8Array(foto.ktp ?? JPEG)], "ktp.jpg", { type: tipe }));
    return { f, id: isi.id as string };
}
/** Seperti peramban: multipart diserialisasi lebih dulu sehingga Content-Length terpasang (route menolak kiriman tanpa ukuran, 411). */
const ajukan = async (u: string, f: FormData, headers?: Record<string, string>) => {
    const r0 = new Request("http://app.test/api/form-kontrol/noo", { method: "POST", body: f });
    const isi = new Uint8Array(await r0.arrayBuffer());
    const h = { "content-type": r0.headers.get("content-type")!, "content-length": String(isi.byteLength), ...headers };
    return jawab(await sebagai(u, () => m.noo.POST(new Request("http://app.test/api/form-kontrol/noo", { method: "POST", body: isi, headers: h }))));
};
const daftar = async (u: string, q = "") => jawab(await sebagai(u, () => m.noo.GET(req(`/api/form-kontrol/noo${q}`))));
const rinci = async (u: string, id: string, q = "") => jawab(await sebagai(u, () => m.satu.GET(req(`/api/form-kontrol/noo/${id}${q}`), ctx(id))));
const aksi = async (u: string, id: string, isi: Record<string, unknown>) =>
    jawab(await sebagai(u, () => m.satu.POST(req(`/api/form-kontrol/noo/${id}`, "POST", isi), ctx(id))));
const lihatKtp = async (u: string, id: string) => jawab(await sebagai(u, () => m.ktp.POST(req(`/api/form-kontrol/noo/${id}/ktp`, "POST"), ctx(id))));
const fotoToko = async (u: string, id: string) => jawab(await sebagai(u, () => m.foto.GET(req(`/api/form-kontrol/noo/${id}/foto-toko`), ctx(id))));
const nAudit = async (action: string, id?: string) => (await pool.query(`SELECT count(*)::int n FROM kontrol_audit_log WHERE entity = 'noo' AND action = $1
    AND ($2::text IS NULL OR entity_id = $2)`, [action, id ?? null])).rows[0].n as number;
/**
 * Pegang kunci baris noo_toko `id` di koneksi lain, jalankan aksi serentak, TUNGGU sampai dua backend terbukti terhalang kunci itu
 * (langsung atau di belakang penunggu lain), lalu lepas. Tanpa ini "serentak" praktis berurutan dan uji tidak bisa merah (peninjau A S1).
 */
async function denganKunciBaris(id: string, jalan: () => Promise<J>[]): Promise<J[]> {
    const k = await pool.connect();
    let janji: Promise<J>[] = [];
    try {
        await k.query("BEGIN");
        await k.query(`SELECT 1 FROM noo_toko WHERE id = $1 FOR UPDATE`, [id]);
        const pid = (await k.query(`SELECT pg_backend_pid() p`)).rows[0].p as number;
        janji = jalan();
        for (let i = 0; ; i++) {
            const n = (await admin.query(`WITH RECURSIVE t(p) AS (SELECT $1::int UNION SELECT a.pid FROM pg_stat_activity a JOIN t ON t.p = ANY(pg_blocking_pids(a.pid)))
                SELECT count(*)::int - 1 n FROM t`, [pid])).rows[0].n as number;
            if (n >= 2) break;
            assert.ok(i < 200, `dua aksi tidak pernah menunggu kunci baris (terhalang: ${n})`);
            await new Promise((r) => setTimeout(r, 50));
        }
    } finally {
        await k.query("COMMIT");
        k.release();
    }
    return Promise.all(janji);
}
const tanpaNik = (teks: string, ...nik: string[]) => { for (const n of nik) assert.ok(!teks.includes(n), "NIK lengkap bocor di respons"); };

before(async () => {
    if (!PG_URL) return;
    JPEG = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#88aa44" } }).jpeg().toBuffer();
    admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${skema}`);
    for (const t of TABEL) await admin.query(`CREATE TABLE ${skema}."${t}" (LIKE public."${t}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    pool = new Pool({ connectionString: urlSkema(), max: 3 });
    await pool.query(await berkas("../../db/migrations/0033_order_cabang.sql"));
    await pool.query(await berkas("../../db/migrations/0034_kunjungan_luar_rute.sql"));
    await pool.query(await berkas("../../db/migrations/0035_noo_toko.sql"));
    const p = pool;
    await p.query(`INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt") VALUES
        ('u-sla', 'Sales A', 'sla@uji.test', true, 'staff', now(), now()),
        ('u-slb', 'Sales B', 'slb@uji.test', true, 'staff', now(), now()),
        ('u-slc', 'Sales C', 'slc@uji.test', true, 'staff', now(), now()),
        ('u-spva', 'SPV A (SPV)', 'spva@uji.test', true, 'spv', now(), now()),
        ('u-spvb', 'SPV B (SPV)', 'spvb@uji.test', true, 'spv', now(), now()),
        ('u-sma', 'SM A (SM)', 'sma@uji.test', true, 'sm', now(), now()),
        ('u-admin', 'Admin A', 'admin@uji.test', true, 'admin', now(), now()),
        ('u-adms', 'Admin Sales A', 'adms@uji.test', true, 'admin_sales', now(), now()),
        ('u-mgr', 'Manager A', 'mgr@uji.test', true, 'manager', now(), now()),
        ('u-vw', 'Viewer A', 'vw@uji.test', true, 'manager', now(), now())`);
    await p.query(`INSERT INTO access_group (id, name, created_at, updated_at) VALUES ('g-sales', 'Salesman', now(), now()), ('g-spv', 'SPV', now(), now()),
        ('g-sm', 'SM', now(), now()), ('g-admin', 'Admin', now(), now()), ('g-adms', 'Admin Sales', now(), now()), ('g-mgr', 'Manager', now(), now()),
        ('g-vw', 'Viewer', now(), now())`);
    const izin = async (g: string, k: string[]) => p.query(`INSERT INTO group_permission (group_id, permission_key) SELECT $1, k FROM unnest($2::text[]) k`, [g, k]);
    await izin("g-sales", ["form_kontrol.view", "form_kontrol.submit", "websales.view", "websales.create"]);
    await izin("g-spv", ["form_kontrol.view", "form_kontrol.submit", "form_kontrol.noo_setujui"]);
    await izin("g-sm", ["form_kontrol.view", "form_kontrol.submit", "form_kontrol.noo_setujui"]);
    await izin("g-admin", ["form_kontrol.view", "form_kontrol.submit", "form_kontrol.manage", "form_kontrol.noo_setujui", "form_kontrol.noo_ktp",
        "form_kontrol.noo_tautkan", "order.view", "order.create", "websales.create"]);
    await izin("g-adms", ["form_kontrol.view", "form_kontrol.submit", "form_kontrol.manage"]);
    // Manager = preset produksi (scripts/seed-rbac-presets.ts: form_kontrol view/submit/manage); Viewer = form_kontrol.view saja.
    await izin("g-mgr", ["form_kontrol.view", "form_kontrol.submit", "form_kontrol.manage"]);
    await izin("g-vw", ["form_kontrol.view"]);
    await p.query(`INSERT INTO user_group (user_id, group_id, assigned_at) SELECT u, g, now() FROM (VALUES ('u-sla', 'g-sales'), ('u-slb', 'g-sales'),
        ('u-slc', 'g-sales'), ('u-spva', 'g-spv'), ('u-spvb', 'g-spv'), ('u-sma', 'g-sm'), ('u-admin', 'g-admin'), ('u-adms', 'g-adms'), ('u-mgr', 'g-mgr'),
        ('u-vw', 'g-vw')) v(u, g)`);
    // Tim A (SPV A, SM A): M-SLA + M-SLC. Tim B (SPV B, SM B): M-SLB. Semua cabang A, principal JKS "PRINCIPLE A" (M-SLA, M-SLB); M-SLC tanpa JKS.
    await p.query(`INSERT INTO sales_profile (id, user_id, sales_code, sales_name, principle, branch, channel, spv_name, sm_name, accurate_linked, created_at, updated_at) VALUES
        ('sp-a', 'u-sla', 'M-SLA', 'SALES A', 'PRINCIPLE A', 'CABANG A', 'TT', 'SPV A', 'SM A', true, now(), now()),
        ('sp-c', 'u-slc', 'M-SLC', 'SALES C', 'CABANG A', 'CABANG A', 'TT', 'SPV A', 'SM A', true, now(), now()),
        ('sp-b', 'u-slb', 'M-SLB', 'SALES B', 'PRINCIPLE A', 'CABANG A', 'TT', 'SPV B', 'SM B', true, now(), now())`);
    await p.query(`INSERT INTO branch (id, name) VALUES (201, 'CABANG A'), (202, 'CABANG B')`);
    await p.query(`INSERT INTO accurate_employee (id, number, name, branch_id, salesman, suspended) VALUES
        (1, 'M-SLA', 'SALES A', 201, true, false), (2, 'M-SLB', 'SALES B', 201, true, false), (3, 'M-SLC', 'SALES C', 201, true, false)`);
    await p.query(`INSERT INTO jks_master (id, sales_code, sales_name, cust_code, cust_name, hari_kunjungan, minggu_pattern, principle, channel,
            visit_frequency, is_active, created_at, updated_at) VALUES
        ('j1', 'M-SLA', 'SALES A', 'C-100001', 'PELANGGAN A', 'SENIN', 'all', 'PRINCIPLE A', 'TT', 4, true, now(), now()),
        ('j2', 'M-SLB', 'SALES B', 'C-100002', 'PELANGGAN B', 'SENIN', 'all', 'PRINCIPLE A', 'TT', 4, true, now(), now())`);
    await p.query(`INSERT INTO customer (id, "customerNo", name, alamat, branch_id, branch_name, category_name, suspended) VALUES
        (1, 'C-100001-CBA', 'PELANGGAN A', 'JL. A', 201, 'CABANG A', 'TT', false),
        (11, 'C-200011-CBA', 'TOKO BARU A', 'JL. CONTOH 1', 201, 'CABANG A', 'TT', false),
        (12, 'C-200012-CBA', 'TOKO BARU NONAKTIF', NULL, 201, 'CABANG A', 'TT', true),
        (13, 'C-200013-CBB', 'TOKO BARU A', NULL, 202, 'CABANG B', 'TT', false),
        (14, 'C-200014-CBA', 'TOKO LAIN SEKALI', NULL, 201, 'CABANG A', 'TT', false),
        (15, 'C-200015-CBA', 'TOKO BARU C', NULL, 201, 'CABANG A', 'TT', false)`);

    process.env.DATABASE_URL = urlSkema();
    delete process.env.LOCAL_AUTH_BYPASS;
    m = await muat();
    Object.defineProperty(m.auth.api, "getSession", { configurable: true,
        value: async () => { const sesi = sesiAls.getStore(); return sesi ? { user: { ...sesi, email: `${sesi.id}@uji.test` }, session: { id: "s" } } : null; } });
});

after(async () => {
    if (!PG_URL) return;
    // Berkas foto uji (nama dari baris skema ini) dihapus dari data/private/noo worktree.
    const nama = (await pool.query(`SELECT foto_toko, foto_ktp FROM noo_toko`)).rows.flatMap((r) => [r.foto_toko, r.foto_ktp]) as string[];
    await Promise.all(nama.map((n) => unlink(path.join(NOO_DIR, n)).catch(() => undefined)));
    await pool?.end();
    await m?.dbMod.pool.end();
    for (const s of [skema, ...skemaLain]) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await admin.end();
});

let ID_A = "", KODE_A = "";

test("ajukan: multipart salesman -> 201, kunjungan HARI INI bertanda luar rute (kode NOO), foto di folder privat, audit tanpa NIK/HP; kirim ulang = baris sama", { skip: pgSkip }, async () => {
    const { f, id } = formNoo();
    const a = await ajukan("u-sla", f);
    assert.equal(a.status, 201, a.teks);
    tanpaNik(a.teks, NIK_A);
    const row = a.body.row as Record<string, unknown>;
    assert.match(String(row.kode), /^NOO-[0-9A-Z]{8}$/);
    assert.deepEqual([row.status, row.nikTersamar, row.noHp, row.namaToko, row.branchName, row.tanggal, row.gpsFlag],
        ["menunggu_spv", "7371••••••••0012", "081234567890", "TOKO BARU A", "CABANG A", HARI_INI, null]);
    ID_A = id; KODE_A = String(row.kode);
    const db = (await pool.query(`SELECT nik, no_hp, foto_toko, foto_ktp, branch_id FROM noo_toko WHERE id = $1`, [id])).rows[0];
    assert.deepEqual([db.nik, db.no_hp, Number(db.branch_id)], [NIK_A, "081234567890", 201]);
    for (const n of [db.foto_toko, db.foto_ktp]) {
        assert.match(n, /^[0-9a-f-]{36}\.jpg$/);
        const p = path.join(NOO_DIR, n);
        assert.ok((await stat(p)).size > 0, "berkas tertulis di folder privat");
        assert.ok(!p.includes(`${path.sep}public${path.sep}`) && !p.includes(`${path.sep}uploads${path.sep}`), "bukan public/ atau data/uploads");
    }
    const k = (await pool.query(`SELECT cust_code, cust_name, customer_id, tanggal, konfirmasi FROM kunjungan_luar_rute WHERE cust_code = $1`, [KODE_A])).rows;
    assert.deepEqual(k, [{ cust_code: KODE_A, cust_name: "TOKO BARU A", customer_id: null, tanggal: HARI_INI, konfirmasi: "menunggu" }]);
    const audit = (await pool.query(`SELECT payload FROM kontrol_audit_log WHERE entity = 'noo' AND action = 'buat' AND entity_id = $1`, [id])).rows;
    assert.equal(audit.length, 1);
    const isiAudit = JSON.stringify(audit[0].payload);
    assert.ok(!isiAudit.includes(NIK_A) && !isiAudit.includes("081234567890") && !isiAudit.includes("PEMILIK A"), "audit tanpa NIK/HP/nama pemilik");

    // Rute hari ini + kunjungan: dibuka seperti toko luar rute; check-in tercatat.
    const ruteRes = await jawab(await sebagai("u-sla", () => m.ao.GET(req(`/api/form-kontrol/ao-control?${new URLSearchParams({ salesCode: "M-SLA", principle: "PRINCIPLE A", date: HARI_INI })}`))));
    const kartu = (ruteRes.body.rows as { custCode: string; custName: string; luarRute: boolean }[]).find((r) => r.custCode === KODE_A);
    assert.deepEqual([kartu?.custName, kartu?.luarRute], ["TOKO BARU A", true]);
    const q = new URLSearchParams({ salesCode: "M-SLA", custCode: KODE_A, principle: "PRINCIPLE A", date: HARI_INI });
    assert.equal((await jawab(await sebagai("u-sla", () => m.visit.GET(req(`/api/form-kontrol/visit?${q}`))))).status, 200);
    const ci = await jawab(await sebagai("u-sla", () => m.checkin.POST(req("/api/form-kontrol/checkin", "POST",
        { salesCode: "M-SLA", custCode: KODE_A, principle: "PRINCIPLE A", date: HARI_INI, photoUrl: "/api/uploads/form-kontrol/a.jpg" }))));
    assert.equal(ci.status, 200, ci.teks);

    // Kirim ulang id sama (jawaban tak pasti di ponsel) = baris sama, tanpa baris/berkas/audit tambahan.
    const nBerkas = (await pool.query(`SELECT count(*)::int n FROM noo_toko`)).rows[0].n;
    const ulang = await ajukan("u-sla", f);
    assert.equal(ulang.status, 200, ulang.teks);
    assert.equal((ulang.body.row as { kode: string }).kode, KODE_A);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM noo_toko`)).rows[0].n, nBerkas);
    assert.equal(await nAudit("buat", id), 1);
    // Peninjau B R6: id sama dengan isian BERBEDA (salesman mengubah isian sesudah jawaban tak pasti) = 409 ID_BEDA_ISI, bukan 200 baris lama
    // yang diam-diam membuang perubahan.
    const ubah = await ajukan("u-sla", formNoo({ id, namaToko: "TOKO BARU A UBAH" }).f);
    assert.deepEqual([ubah.status, ubah.body.kode, ubah.body.kodeNoo], [409, "ID_BEDA_ISI", KODE_A]);
    assert.ok(String(ubah.body.error).includes(KODE_A), "pesan menyebut pengajuan yang sudah tersimpan");
    tanpaNik(ubah.teks, NIK_A);
    assert.equal((await pool.query(`SELECT nama_toko FROM noo_toko WHERE id = $1`, [id])).rows[0].nama_toko, "TOKO BARU A", "baris lama tidak berubah");
    // id sama dari akun lain = ditolak (bukan baris orang lain).
    const curi = await ajukan("u-slc", formNoo({ id, salesCode: "M-SLC", principle: "CABANG A", nik: NIK_C, noHp: "081299990000" }).f);
    assert.deepEqual([curi.status, curi.body.kode], [409, "ID_TERPAKAI"]);
    tanpaNik(curi.teks, NIK_A);
});

test("ajukan: validasi berkode tanpa nilai pribadi di galat; bukan pemilik / SPV / admin ditolak; principal luar cakupan", { skip: pgSkip }, async () => {
    const kode = (j: J) => [j.status, j.body.kode];
    const nik15 = "737101010101001";
    const g = await ajukan("u-sla", formNoo({ nik: nik15 }).f);
    assert.deepEqual(kode(g), [400, "NIK_TIDAK_SAH"]);
    assert.ok(!g.teks.includes(nik15));
    assert.deepEqual(kode(await ajukan("u-sla", formNoo({ noHp: "0211234567" }).f)), [400, "HP_TIDAK_SAH"]);
    assert.deepEqual(kode(await ajukan("u-sla", formNoo({ lat: null }).f)), [400, "GPS_WAJIB"]);
    assert.deepEqual(kode(await ajukan("u-sla", formNoo({ namaToko: " " }).f)), [400, "ISIAN_WAJIB"]);
    assert.deepEqual(kode(await ajukan("u-sla", formNoo({}, { ktp: null }).f)), [400, "FOTO_WAJIB"]);
    assert.deepEqual(kode(await ajukan("u-sla", formNoo({}, { tipe: "application/pdf" }).f)), [400, "FOTO_TIDAK_SAH"]);
    assert.deepEqual(kode(await ajukan("u-sla", formNoo({ nik: NIK_C, noHp: "081277770000" }, { ktp: Buffer.from("bukan gambar") }).f)), [400, "FOTO_TIDAK_SAH"]);
    assert.deepEqual(kode(await ajukan("u-sla", formNoo({ salesCode: "M-SLB" }).f)), [403, "BUKAN_PEMILIK"]);
    assert.deepEqual(kode(await ajukan("u-spva", formNoo().f)), [403, "BUKAN_PEMILIK"], "SPV tidak mengajukan");
    assert.deepEqual(kode(await ajukan("u-mgr", formNoo().f)), [403, "BUKAN_PEMILIK"], "Manager (punya submit) bukan salesman pemilik");
    assert.equal((await ajukan("u-vw", formNoo().f)).status, 403, "tanpa form_kontrol.submit");
    // Peninjau A R4: body jelas > 2 × 5 MB + 512 KB ditolak dari Content-Length SEBELUM dibaca; foto > 40 MP ditolak sharp.
    const batas = 10 * 1024 * 1024 + 512 * 1024;
    assert.deepEqual(kode(await ajukan("u-sla", formNoo({ nik: NIK_C, noHp: "081277770000" }).f, { "content-length": String(batas + 1) })), [413, "FOTO_TERLALU_BESAR"]);
    // Peninjau A R-A1: tanpa Content-Length (chunked) = 411 sebelum body dibaca.
    const tanpaUkuran = await jawab(await sebagai("u-sla", () => m.noo.POST(new Request("http://app.test/api/form-kontrol/noo", { method: "POST", body: formNoo({ nik: NIK_C, noHp: "081277770000" }).f }))));
    assert.deepEqual(kode(tanpaUkuran), [411, "PANJANG_WAJIB"]);
    const bom = await sharp({ create: { width: 7000, height: 6000, channels: 3, background: "#ffffff" } }).png().toBuffer();
    assert.deepEqual(kode(await ajukan("u-sla", formNoo({ nik: NIK_C, noHp: "081277770000" }, { toko: bom }).f)), [400, "FOTO_TIDAK_SAH"], "42 MP ditolak");
    assert.deepEqual(kode(await ajukan("u-sla", formNoo({ principle: "PRINCIPLE Z", nik: NIK_C, noHp: "081277770000" }).f)), [403, "PRINCIPAL_LUAR_CAKUPAN"]);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM noo_toko`)).rows[0].n, 1, "semua penolakan tanpa baris");
    assert.equal((await pool.query(`SELECT count(*)::int n FROM kontrol_audit_log WHERE entity = 'noo'`)).rows[0].n, 1);
});

let ID_DUP = "", ID_B = "";

test("duplikat (owner P3): NIK atau HP sama dengan NOO belum ditolak -> 409 NOO_DUPLIKAT (pembanding tanpa NIK); ulang 'pemilik sama' + alasan -> bertanda", { skip: pgSkip }, async () => {
    // Peninjau A R3: NOO pembanding milik salesman LAIN tidak disebut (kode/toko/status) — 409 bukan oracle NIK/HP -> toko orang lain.
    const samaNik = await ajukan("u-slb", formNoo({ salesCode: "M-SLB", noHp: "081300001111" }).f);
    assert.deepEqual([samaNik.status, samaNik.body.kode, samaNik.body.pembanding, samaNik.body.lain], [409, "NOO_DUPLIKAT", [], [{ cocok: ["NIK"] }]]);
    assert.ok(!samaNik.teks.includes(KODE_A) && !samaNik.teks.includes("M-SLA"), "kode NOO/salesman lain tidak bocor");
    tanpaNik(samaNik.teks, NIK_A);
    const samaHp = await ajukan("u-slb", formNoo({ salesCode: "M-SLB", nik: NIK_B, noHp: "+62 812 3456 7890" }).f);
    assert.deepEqual([samaHp.status, samaHp.body.lain], [409, [{ cocok: ["No. HP"] }]]);
    // NOO pembanding MILIK sendiri tetap disebut lengkap (salesman tahu tokonya sendiri).
    const milik = await ajukan("u-sla", formNoo({ namaToko: "TOKO BARU A2", noHp: "081300002222" }).f);
    assert.deepEqual([milik.status, milik.body.pembanding, milik.body.lain],
        [409, [{ kode: KODE_A, namaToko: "TOKO BARU A", status: "menunggu_spv", cocok: ["NIK"] }], []]);
    assert.deepEqual([(await ajukan("u-slb", formNoo({ salesCode: "M-SLB", pemilikSama: "ya", alasanDuplikat: "sama" }).f)).body.kode], ["ALASAN_DUPLIKAT_WAJIB"]);
    const { f, id } = formNoo({ salesCode: "M-SLB", namaToko: "TOKO BARU A CABANG 2", noHp: "081300001111", pemilikSama: "ya", alasanDuplikat: "Pemilik sama membuka toko kedua di pasar." });
    const ok = await ajukan("u-slb", f);
    assert.equal(ok.status, 201, ok.teks);
    const okRow = ok.body.row as Record<string, unknown>;
    assert.deepEqual([okRow.duplikat, okRow.duplikatDengan, okRow.alasanDuplikat], [true, null, "Pemilik sama membuka toko kedua di pasar."],
        "salesman B: tanda duplikat tanpa kode NOO salesman A");
    assert.equal((await pool.query(`SELECT duplikat_dengan FROM noo_toko WHERE id = $1`, [id])).rows[0].duplikat_dengan, KODE_A);
    ID_DUP = id;
    // NOO lain tanpa kesamaan: biasa (tanpa tanda) walau dikirim pemilikSama.
    const lain = formNoo({ salesCode: "M-SLB", namaToko: "TOKO BARU B", nik: NIK_B, noHp: "081311112222", pemilikSama: "ya", alasanDuplikat: "Siapa tahu pemiliknya sama." });
    const b = await ajukan("u-slb", lain.f);
    assert.equal(b.status, 201, b.teks);
    assert.equal((b.body.row as Record<string, unknown>).duplikatDengan, null);
    ID_B = lain.id;
});

test("cakupan per peran: daftar/rincian/foto toko — salesman miliknya, SPV/SM tim, Admin & Admin Sales semua, Manager lihat-saja & SPV lain tidak; tanpa NIK/HP di daftar", { skip: pgSkip }, async () => {
    const ids = async (u: string, q = "") => { const d = await daftar(u, q); assert.equal(d.status, 200, d.teks); tanpaNik(d.teks, NIK_A, NIK_B);
        return (d.body.rows as { id: string }[]).map((r) => r.id).sort(); };
    assert.deepEqual(await ids("u-sla"), [ID_A]);
    assert.deepEqual(await ids("u-slb"), [ID_B, ID_DUP].sort());
    assert.deepEqual(await ids("u-spva"), [ID_A]);
    assert.deepEqual(await ids("u-spvb"), [ID_B, ID_DUP].sort());
    assert.deepEqual(await ids("u-sma"), [ID_A], "SM A = tim di bawah SPV A");
    assert.deepEqual(await ids("u-admin"), [ID_A, ID_B, ID_DUP].sort());
    assert.deepEqual(await ids("u-adms", "?status=menunggu_spv"), [ID_A, ID_B, ID_DUP].sort());
    assert.deepEqual(await ids("u-mgr"), [ID_A, ID_B, ID_DUP].sort(), "Manager (preset produksi) melihat semua NOO");
    const d = await daftar("u-spva");
    const baris = (d.body.rows as Record<string, unknown>[])[0];
    for (const k of ["nik", "noHp", "nikTersamar", "namaPemilik", "namaKtp", "fotoKtp"]) assert.ok(!(k in baris), `daftar tanpa ${k}`);
    assert.equal((await daftar("u-vw")).status, 403, "form_kontrol.view saja tidak membuka daftar NOO");
    assert.equal((await daftar("u-admin")).body.selesaiTerpotong, false);
    assert.deepEqual([(await daftar("u-spva", "?salesCode=M-SLB")).body.kode], ["LUAR_CAKUPAN"]);
    assert.deepEqual([(await daftar("u-sla", "?status=hilang")).status], [400]);

    const r = await rinci("u-spva", ID_A);
    assert.equal(r.status, 200, r.teks);
    tanpaNik(r.teks, NIK_A);
    assert.equal(r.header.get("cache-control"), "private, no-store");
    assert.deepEqual([(r.body.row as Record<string, unknown>).nikTersamar, (r.body.row as Record<string, unknown>).namaKtp, r.body.saran], ["7371••••••••0012", "PEMILIK A", null]);
    const mgr = await rinci("u-mgr", ID_A);
    assert.equal(mgr.status, 200, mgr.teks);
    tanpaNik(mgr.teks, NIK_A);
    assert.deepEqual((mgr.body.row as { boleh: unknown }).boleh, { putuskan: false, ktp: false, tautkan: false, kunjungi: false }, "Manager: lihat saja");
    for (const [u, id] of [["u-spvb", ID_A], ["u-slb", ID_A], ["u-vw", ID_A], ["u-sla", ID_B]] as const) {
        assert.deepEqual([(await rinci(u, id)).status, (await rinci(u, id)).body.kode], [404, "NOO_TIDAK_ADA"], `${u} -> ${id}`);
    }
    const ft = await fotoToko("u-sla", ID_A);
    assert.deepEqual([ft.status, ft.header.get("content-type"), ft.header.get("cache-control")], [200, "image/jpeg", "private, no-store"]);
    assert.equal((await fotoToko("u-spvb", ID_A)).status, 404);
    assert.equal((await fotoToko("u-mgr", ID_A)).status, 200, "Manager melihat foto toko");
    assert.equal((await fotoToko("u-vw", ID_A)).status, 404);
    // Rincian duplikat: pembanding untuk pemutus (tanpa NIK).
    const dup = await rinci("u-spvb", ID_DUP);
    assert.deepEqual(dup.body.pembanding, { kode: KODE_A, namaToko: "TOKO BARU A", status: "menunggu_spv", salesCode: "M-SLA", alamat: "JL. CONTOH 1 CABANG A", customerNo: null });
    assert.equal((dup.body.row as Record<string, unknown>).duplikatDengan, KODE_A);
    tanpaNik(dup.teks, NIK_A);
    // Salesman pengaju (tim lain dari pembanding): tanda duplikat saja, tanpa kode/alamat/salesman NOO pembanding (peninjau A R3).
    const dupSales = await rinci("u-slb", ID_DUP);
    assert.equal(dupSales.status, 200, dupSales.teks);
    assert.deepEqual([dupSales.body.pembanding, (dupSales.body.row as Record<string, unknown>).duplikatDengan, (dupSales.body.row as Record<string, unknown>).duplikat],
        [null, null, true]);
    assert.ok(!dupSales.teks.includes(KODE_A) && !dupSales.teks.includes("M-SLA"), "kode/salesman NOO pembanding tidak bocor ke salesman B");
    assert.ok(!(await daftar("u-slb")).teks.includes(KODE_A), "daftar salesman B tanpa kode pembanding");
});

test("Lihat KTP: pengaju (menunggu), SPV tim, SM pengganti, Admin = 200 + audit SEBELUM data; Admin Sales/Manager = 403; SPV lain/Viewer = 404; tanpa audit saat ditolak", { skip: pgSkip }, async () => {
    const awal = await nAudit("lihat_ktp");
    for (const u of ["u-sla", "u-spva", "u-sma", "u-admin"]) {
        const k = await lihatKtp(u, ID_A);
        assert.equal(k.status, 200, `${u}: ${k.teks}`);
        assert.deepEqual([k.body.nik, k.body.namaKtp, k.body.kode], [NIK_A, "PEMILIK A", KODE_A]);
        assert.match(String(k.body.foto), /^data:image\/jpeg;base64,\/9j\//);
        assert.match(String(k.header.get("cache-control")), /no-store/);
    }
    assert.equal(await nAudit("lihat_ktp"), awal + 4);
    const rows = (await pool.query(`SELECT actor_id, payload FROM kontrol_audit_log WHERE entity = 'noo' AND action = 'lihat_ktp' ORDER BY created_at`)).rows;
    assert.deepEqual(rows.map((r) => r.actor_id), ["u-sla", "u-spva", "u-sma", "u-admin"]);
    for (const r of rows) assert.deepEqual(r.payload, { kode: KODE_A }, "audit hanya kode NOO (tanpa NIK/foto)");
    const ktpAdms = await lihatKtp("u-adms", ID_A);
    assert.deepEqual([ktpAdms.body.kode], ["KTP_TIDAK_BOLEH"], "Admin Sales tidak melihat KTP");
    assert.match(String(ktpAdms.body.error), /SPV dan SM tim pengaju serta Admin/, "pesan 403 menyebut SPV, SM, dan Admin (peninjau A R-A3)");
    assert.deepEqual([(await lihatKtp("u-mgr", ID_A)).body.kode], ["KTP_TIDAK_BOLEH"], "Manager melihat NOO, KTP tidak (owner 13 Okt malam)");
    assert.equal((await lihatKtp("u-sma", ID_B)).status, 404, "SM A: NOO tim SM B tidak terlihat");
    assert.deepEqual([(await lihatKtp("u-spvb", ID_A)).status, (await lihatKtp("u-vw", ID_A)).status, (await lihatKtp("u-slb", ID_A)).status], [404, 404, 404]);
    for (const u of ["u-adms", "u-mgr", "u-spvb", "u-vw"]) tanpaNik((await lihatKtp(u, ID_A)).teks, NIK_A);
    assert.equal(await nAudit("lihat_ktp"), awal + 4, "penolakan tidak tercatat sebagai lihat");
});

test("keputusan: salesman/SPV lain/pengaju ditolak; tolak wajib alasan; duplikat WAJIB konfirmasi (juga CHECK DB); SM pengganti; serentak satu menang", { skip: pgSkip }, async () => {
    const kode = (j: J) => [j.status, j.body.kode ?? j.body.error];
    assert.equal((await aksi("u-sla", ID_A, { aksi: "setujui" })).status, 403, "salesman tanpa noo_setujui");
    assert.deepEqual(kode(await aksi("u-spvb", ID_A, { aksi: "setujui" })), [404, "NOO_TIDAK_ADA"]);
    assert.deepEqual(kode(await aksi("u-spva", ID_A, { aksi: "tolak", alasan: "  " })), [400, "ALASAN_WAJIB"]);
    assert.deepEqual(kode(await aksi("u-spva", ID_A, { aksi: "lain" })), [400, "AKSI_TIDAK_DIKENAL"]);
    // Duplikat: tanpa konfirmasi 409; DB juga menolak jalan pintas.
    assert.deepEqual(kode(await aksi("u-spvb", ID_DUP, { aksi: "setujui" })), [409, "KONFIRMASI_DUPLIKAT_WAJIB"]);
    await assert.rejects(pool.query(`UPDATE noo_toko SET status = 'disetujui', diputuskan_oleh = 'x', diputuskan_pada = now() WHERE id = $1`, [ID_DUP]),
        /noo_toko_duplikat/);
    const dup = await aksi("u-spvb", ID_DUP, { aksi: "setujui", konfirmasiPemilikSama: true });
    assert.equal(dup.status, 200, dup.teks);
    assert.deepEqual([(dup.body.row as Record<string, unknown>).status, (dup.body.row as Record<string, unknown>).duplikatDikonfirmasi], ["disetujui", true]);
    // SM A menyetujui NOO tim SPV A (SPV berhalangan) — serentak dengan tolak SPV A: satu menang. Baris DIKUNCI koneksi lain sampai kedua
    // keputusan terbukti menunggu kunci itu, lalu dilepas -> keduanya benar-benar bersaing (peninjau A S1; tanpa kunci baris DAN tanpa UPDATE
    // bersyarat status = 200/200 + dua jejak).
    const [x, y] = await denganKunciBaris(ID_A, () => [aksi("u-sma", ID_A, { aksi: "setujui" }), aksi("u-spva", ID_A, { aksi: "tolak", alasan: "Lokasi tidak sesuai foto." })]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    const kalah = x.status === 409 ? x : y;
    assert.equal(kalah.body.kode, "SUDAH_DIPUTUSKAN");
    const st = (await pool.query(`SELECT status, diputuskan_oleh, alasan_tolak FROM noo_toko WHERE id = $1`, [ID_A])).rows[0];
    if (st.status === "ditolak") {
        // tolak menang: kembalikan skenario dengan NOO baru yang disetujui SM.
        assert.deepEqual([st.diputuskan_oleh, st.alasan_tolak], ["u-spva", "Lokasi tidak sesuai foto."]);
        await pool.query(`UPDATE noo_toko SET status = 'disetujui', alasan_tolak = NULL, diputuskan_oleh = 'u-sma', diputuskan_oleh_nama = 'SM A (SM)' WHERE id = $1`, [ID_A]);
    } else {
        assert.deepEqual([st.status, st.diputuskan_oleh], ["disetujui", "u-sma"]);
    }
    assert.equal(await nAudit("setujui", ID_A) + await nAudit("tolak", ID_A), 1, "satu jejak keputusan");
    const jejak = (await pool.query(`SELECT payload FROM kontrol_audit_log WHERE entity = 'noo' AND action IN ('setujui', 'tolak') AND entity_id = $1`, [ID_A])).rows[0].payload;
    assert.ok(!JSON.stringify(jejak).includes(NIK_A) && !("alasan" in jejak), "audit keputusan tanpa NIK/isi alasan");
    // Sesudah diputuskan: pengaju tidak lagi melihat KTP; SPV tim masih.
    assert.equal((await lihatKtp("u-sla", ID_A)).body.kode, "KTP_TIDAK_BOLEH");
    assert.equal((await lihatKtp("u-spva", ID_A)).status, 200);
    // Admin (grup) boleh menyetujui; tolak NOO B oleh SPV B dengan alasan.
    const t = await aksi("u-spvb", ID_B, { aksi: "tolak", alasan: "Toko ternyata cabang pelanggan lama." });
    assert.deepEqual([t.status, (t.body.row as Record<string, unknown>).status, (t.body.row as Record<string, unknown>).alasanTolak], [200, "ditolak", "Toko ternyata cabang pelanggan lama."]);
    assert.deepEqual(kode(await aksi("u-admin", ID_B, { aksi: "setujui" })), [409, "SUDAH_DIPUTUSKAN"]);
});

test("NIK dari NOO ditolak boleh dipakai lagi tanpa tanda; Admin grup menyetujui; pengaju tak memutuskan sendiri", { skip: pgSkip }, async () => {
    const { f, id } = formNoo({ salesCode: "M-SLC", principle: "CABANG A", namaToko: "TOKO BARU C", nik: NIK_B, noHp: "081311112222" });
    const c = await ajukan("u-slc", f);
    assert.equal(c.status, 201, c.teks);
    assert.equal((c.body.row as Record<string, unknown>).duplikatDengan, null, "NOO B ditolak tidak dihitung ganda");
    const s = await aksi("u-admin", id, { aksi: "setujui" });
    assert.equal(s.status, 200, s.teks);
    assert.equal((await pool.query(`SELECT diputuskan_oleh FROM noo_toko WHERE id = $1`, [id])).rows[0].diputuskan_oleh, "u-admin");
});

test("tautkan (HANYA grup Admin): hanya disetujui; pelanggan ada, aktif, cabang sama, sekali; serentak satu menang; saran + cari; SPV/Admin Sales/Manager 403", { skip: pgSkip }, async () => {
    const kode = (j: J) => [j.status, j.body.kode ?? j.body.error];
    // Pelanggan lama (masuk sync SEBELUM NOO diajukan) tidak disarankan otomatis; yang masuk/berubah sesudahnya (= didaftarkan Admin) disarankan.
    assert.deepEqual((await rinci("u-admin", ID_A)).body.saran, []);
    assert.equal((await rinci("u-adms", ID_A)).body.saran, null, "Admin Sales tanpa saran penautan");
    await pool.query(`UPDATE customer SET synced_at = now() WHERE id IN (11, 12, 13, 14)`);
    const r = await rinci("u-admin", ID_A);
    const saran = r.body.saran as { id: number; customerNo: string; skor: number }[];
    assert.equal(saran[0]?.customerNo, "C-200011-CBA", "nama + alamat paling mirip, cabang sama");
    assert.ok(!saran.some((s) => s.customerNo === "C-200012-CBA" || s.customerNo === "C-200013-CBB"), "tanpa suspended / cabang lain");
    const cari = await rinci("u-admin", ID_A, "?cari=lain sekali");
    assert.deepEqual((cari.body.saran as { customerNo: string }[]).map((s) => s.customerNo), ["C-200014-CBA"]);
    // Owner 13 Okt malam: HANYA grup Admin (form_kontrol.noo_tautkan); form_kontrol.manage milik Admin Sales/Manager tidak cukup.
    for (const u of ["u-spva", "u-adms", "u-mgr"]) assert.equal((await aksi(u, ID_A, { aksi: "tautkan", customerId: 11 })).status, 403, `${u} tidak menautkan`);
    assert.equal((await pool.query(`SELECT status FROM noo_toko WHERE id = $1`, [ID_A])).rows[0].status, "disetujui");
    assert.deepEqual(kode(await aksi("u-admin", ID_A, { aksi: "tautkan", customerId: 13 })), [409, "CABANG_BERBEDA"]);
    assert.deepEqual(kode(await aksi("u-admin", ID_A, { aksi: "tautkan", customerId: 12 })), [409, "PELANGGAN_NONAKTIF"]);
    assert.deepEqual(kode(await aksi("u-admin", ID_A, { aksi: "tautkan", customerId: 999 })), [404, "PELANGGAN_TIDAK_DITEMUKAN"]);
    assert.deepEqual(kode(await aksi("u-admin", ID_A, { aksi: "tautkan", customerId: "11" })), [400, "INPUT_TIDAK_VALID"]);
    assert.deepEqual(kode(await aksi("u-admin", ID_B, { aksi: "tautkan", customerId: 11 })), [409, "BELUM_DISETUJUI"], "ditolak tidak ditautkan");
    // Dua penautan serentak NOO yang sama dengan baris dikunci koneksi lain: satu 200, satu 409, satu jejak (peninjau A S1).
    const [p, q] = await denganKunciBaris(ID_A, () => [aksi("u-admin", ID_A, { aksi: "tautkan", customerId: 11 }), aksi("u-admin", ID_A, { aksi: "tautkan", customerId: 11 })]);
    assert.deepEqual([p.status, q.status].sort(), [200, 409], `${p.teks} | ${q.teks}`);
    const ok = p.status === 200 ? p : q;
    assert.equal((p.status === 409 ? p : q).body.kode, "SUDAH_TERDAFTAR");
    assert.deepEqual([(ok.body.row as Record<string, unknown>).status, (ok.body.row as Record<string, unknown>).customerNo], ["terdaftar", "C-200011-CBA"]);
    assert.deepEqual(kode(await aksi("u-admin", ID_A, { aksi: "tautkan", customerId: 11 })), [409, "SUDAH_TERDAFTAR"]);
    assert.deepEqual(kode(await aksi("u-admin", ID_DUP, { aksi: "tautkan", customerId: 11 })), [409, "PELANGGAN_SUDAH_TERTAUT"]);
    const t = (await pool.query(`SELECT payload FROM kontrol_audit_log WHERE entity = 'noo' AND action = 'tautkan'`)).rows;
    assert.deepEqual(t.map((x) => x.payload), [{ kode: KODE_A, customerId: 11, customerNo: "C-200011-CBA" }]);
    // Pelanggan yang sudah tertaut tidak lagi disarankan.
    const s2 = await rinci("u-admin", ID_DUP, "?cari=TOKO BARU");
    assert.ok(!(s2.body.saran as { customerNo: string }[]).some((s) => s.customerNo === "C-200011-CBA"));
});

test("ORDER NOO ditolak 409 berkode (tidak order + alasan tetap); pelanggan biasa tidak terpengaruh; NOO keluar dari konfirmasi JKS", { skip: pgSkip }, async () => {
    const status = (custCode: string, s: string, alasan: string | null = null) => sebagai("u-sla", () => m.ao.POST(req("/api/form-kontrol/ao-control", "POST",
        { salesCode: "M-SLA", custCode, principle: "PRINCIPLE A", date: HARI_INI, status: s, noOrderReasonCode: alasan }))).then(jawab);
    const o = await status(KODE_A, "ordered");
    assert.deepEqual([o.status, o.body.kode], [409, "NOO_BELUM_TERDAFTAR"]);
    assert.match(String(o.body.error), /C-200011-CBA/, "sesudah terdaftar: arahkan ke kode pelanggan");
    assert.deepEqual([(await status(KODE_A, "active")).status], [409]);
    assert.equal((await status(KODE_A, "not_order", "R01")).status, 200);
    // Pelanggan Accurate biasa (kunjungan luar rute berkode pelanggan) tetap bisa ORDER.
    const t = await jawab(await sebagai("u-sla", () => m.luar.POST(req("/api/form-kontrol/luar-rute", "POST",
        { salesCode: "M-SLA", principle: "PRINCIPLE A", date: HARI_INI, customerNo: "C-200014-CBA" }))));
    assert.equal(t.status, 201, t.teks);
    assert.equal((await status("C-200014-CBA", "ordered")).status, 200, "pelanggan biasa tidak terpengaruh");
    assert.equal((await pool.query(`SELECT count(*)::int n FROM ao_control_daily WHERE cust_code = $1 AND status IN ('ordered', 'active')`, [KODE_A])).rows[0].n, 0);
    // Laporan harian: NOO tidak ditawarkan masuk JKS; konfirmasi langsung ditolak.
    const d = await jawab(await sebagai("u-sla", () => m.luar.GET(req(`/api/form-kontrol/luar-rute?${new URLSearchParams({ salesCode: "M-SLA", date: HARI_INI })}`))));
    assert.ok(!(d.body.rows as { custCode: string }[]).some((r) => r.custCode === KODE_A), "NOO tidak di daftar konfirmasi JKS");
    const idK = (await pool.query(`SELECT id FROM kunjungan_luar_rute WHERE cust_code = $1`, [KODE_A])).rows[0].id;
    const k = await jawab(await sebagai("u-sla", () => m.konf.POST(req("/api/form-kontrol/luar-rute/konfirmasi", "POST",
        { id: idK, salesCode: "M-SLA", keputusan: "jks", hari: "Senin", mingguPattern: "all" }))));
    assert.deepEqual([k.status, k.body.kode], [409, "NOO_BELUM_TERDAFTAR"]);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM jks_master WHERE cust_code = $1`, [KODE_A])).rows[0].n, 0);
    // Dashboard SPV: kunjungan NOO bernama tokonya.
    const spv = await jawab(await sebagai("u-spva", () => m.spv.GET(req(`/api/form-kontrol/spv-dashboard?date=${HARI_INI}`))));
    const v = (spv.body.rows as { salesCode: string; visits: { custCode: string; custName: string; luarRute: boolean }[] }[]).find((r) => r.salesCode === "M-SLA")!.visits
        .find((x) => x.custCode === KODE_A);
    assert.deepEqual([v?.custName, v?.luarRute], ["TOKO BARU A", true]);
});

test("kunjungi ulang: pemilik (menunggu/disetujui) hari ini, sama = baris sama, sesudah batal = baris baru; terdaftar/ditolak/orang lain ditolak", { skip: pgSkip }, async () => {
    const { f, id } = formNoo({ salesCode: "M-SLA", namaToko: "TOKO BARU D", nik: "7371040404040078", noHp: "081355556666" });
    assert.equal((await ajukan("u-sla", f)).status, 201);
    const kode = (await pool.query(`SELECT kode FROM noo_toko WHERE id = $1`, [id])).rows[0].kode as string;
    const sama = await aksi("u-sla", id, { aksi: "kunjungi", principle: "PRINCIPLE A" });
    assert.deepEqual([sama.status, sama.body.baru], [200, false]);
    const idK = (sama.body.row as { id: string }).id;
    const b = await jawab(await sebagai("u-sla", () => m.batal.POST(req("/api/form-kontrol/luar-rute/batal", "POST", { id: idK }))));
    assert.equal(b.status, 200, b.teks);
    const baru = await aksi("u-sla", id, { aksi: "kunjungi", principle: "PRINCIPLE A" });
    assert.deepEqual([baru.status, baru.body.baru], [201, true]);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM kunjungan_luar_rute WHERE cust_code = $1 AND dibatalkan_pada IS NULL`, [kode])).rows[0].n, 1);
    const g = (j: J) => [j.status, j.body.kode];
    assert.deepEqual(g(await aksi("u-sla", ID_A, { aksi: "kunjungi", principle: "PRINCIPLE A" })), [409, "SUDAH_TERDAFTAR"]);
    assert.deepEqual(g(await aksi("u-slb", ID_B, { aksi: "kunjungi", principle: "PRINCIPLE A" })), [409, "NOO_DITOLAK"]);
    assert.deepEqual(g(await aksi("u-slc", id, { aksi: "kunjungi", principle: "CABANG A" })), [404, "NOO_TIDAK_ADA"]);
    assert.deepEqual(g(await aksi("u-spva", id, { aksi: "kunjungi", principle: "PRINCIPLE A" })), [403, "BUKAN_PEMILIK"]);
    assert.deepEqual(g(await aksi("u-sla", id, { aksi: "kunjungi", principle: "PRINCIPLE Z" })), [403, "PRINCIPAL_LUAR_CAKUPAN"]);
});

test("serentak: dua pengajuan NIK sama -> satu 201, satu 409 NOO_DUPLIKAT (kunci advisory); berkas yang kalah dibuang", { skip: pgSkip }, async () => {
    const nik = "7371050505050090";
    const sebelum = (await pool.query(`SELECT count(*)::int n FROM noo_toko`)).rows[0].n;
    const berkasAwal = (await readdir(NOO_DIR)).length;
    const [x, y] = await Promise.all([
        ajukan("u-sla", formNoo({ namaToko: "TOKO SERENTAK 1", nik, noHp: "081366667777" }).f),
        ajukan("u-slc", formNoo({ salesCode: "M-SLC", principle: "CABANG A", namaToko: "TOKO SERENTAK 2", nik, noHp: "081388889999" }).f),
    ]);
    assert.deepEqual([x.status, y.status].sort(), [201, 409]);
    assert.equal((x.status === 409 ? x : y).body.kode, "NOO_DUPLIKAT");
    assert.equal((await pool.query(`SELECT count(*)::int n FROM noo_toko`)).rows[0].n, sebelum + 1);
    assert.equal((await readdir(NOO_DIR)).length, berkasAwal + 2, "hanya 2 foto pemenang yang tertinggal; foto pengajuan yang kalah di-unlink");
});

test("foto kedua gagal ditulis (ENOSPC) -> foto pertama yang sudah tertulis DIBUANG, tanpa baris/audit (peninjau A R2)", { skip: pgSkip }, async () => {
    const cek = m.aturan.periksaIsianNoo((k) => ({ ...ISIAN, nik: "7371060606060012", noHp: "081344445555" } as Record<string, string>)[k]);
    assert.ok("isian" in cek);
    const tertulis: string[] = [];
    let panggil = 0;
    const tulisRusak = async (isi: Buffer) => {
        if (++panggil === 2) throw Object.assign(new Error("ENOSPC tiruan"), { code: "ENOSPC" });
        const nama = `${randomUUID()}.jpg`;
        await writeFile(path.join(NOO_DIR, nama), isi, { flag: "wx" });
        tertulis.push(nama);
        return nama;
    };
    const id = randomUUID();
    await assert.rejects(m.lib.buatNoo({ id, salesCode: "M-SLA", salesName: "SALES A", principle: "PRINCIPLE A", tanggal: HARI_INI, branchId: 201,
        branchName: "CABANG A", isian: cek.isian, fotoToko: JPEG, fotoKtp: JPEG, duplikat: null, aktorId: "u-sla", aktorNama: "Sales A" }, tulisRusak), /ENOSPC/);
    assert.deepEqual([panggil, tertulis.length], [2, 1]);
    await assert.rejects(stat(path.join(NOO_DIR, tertulis[0])), "foto toko yang sudah tertulis dibuang");
    assert.equal((await pool.query(`SELECT count(*)::int n FROM noo_toko WHERE id = $1`, [id])).rows[0].n, 0);
    assert.equal(await nAudit("buat", id), 0);
});

test("antrean aktif TIDAK terpotong: 301 NOO selesai yang lebih baru tidak menyembunyikan NOO disetujui lama; selesai dibatasi 300 + selesaiTerpotong (peninjau A T1)", { skip: pgSkip }, async () => {
    const lama = randomUUID();
    await pool.query(`INSERT INTO noo_toko (id, kode, sales_code, principle, branch_id, branch_name, tanggal, nama_toko, nama_pemilik, alamat, no_hp, nik,
            nama_ktp, foto_ktp, foto_toko, lat, lng, akurasi, status, dibuat_oleh, dibuat_pada, diputuskan_oleh, diputuskan_pada)
        VALUES ($1, 'NOO-LAMA0001', 'M-SLA', 'PRINCIPLE A', 201, 'CABANG A', '2026-10-01', 'TOKO LAMA A', 'PEMILIK A', 'JL. CONTOH 9', '081377770001',
            '7371090909090001', 'PEMILIK A', gen_random_uuid() || '.jpg', gen_random_uuid() || '.jpg', -5.1, 119.4, 10, 'disetujui', 'u-sla',
            now() - interval '10 days', 'u-spva', now() - interval '9 days')`, [lama]);
    await pool.query(`INSERT INTO noo_toko (id, kode, sales_code, principle, branch_id, branch_name, tanggal, nama_toko, nama_pemilik, alamat, no_hp, nik,
            nama_ktp, foto_ktp, foto_toko, lat, lng, akurasi, status, dibuat_oleh, dibuat_pada, diputuskan_oleh, diputuskan_pada, alasan_tolak)
        SELECT gen_random_uuid(), 'NOO-T' || lpad(i::text, 7, '0'), 'M-SLA', 'PRINCIPLE A', 201, 'CABANG A', '2026-10-13', 'TOKO TOLAK ' || i, 'PEMILIK A',
            'JL. CONTOH 9', '0813' || lpad(i::text, 8, '0'), '73719' || lpad(i::text, 11, '0'), 'PEMILIK A', gen_random_uuid() || '.jpg',
            gen_random_uuid() || '.jpg', -5.1, 119.4, 10, 'ditolak', 'u-sla', now() + i * interval '1 second', 'u-spva', now(), 'Uji antrean.'
        FROM generate_series(1, 301) i`);
    try {
        for (const u of ["u-admin", "u-spva", "u-sla"]) {
            const d = await daftar(u);
            assert.equal(d.status, 200, d.teks);
            const rows = d.body.rows as { id: string; status: string }[];
            assert.ok(rows.some((r) => r.id === lama), `${u}: NOO disetujui lama tetap di antrean`);
            assert.equal(rows.filter((r) => r.status === "ditolak").length, 300, `${u}: selesai dibatasi 300`);
            assert.equal(d.body.selesaiTerpotong, true, `${u}: tanda terpotong`);
        }
        const aktif = await daftar("u-admin", "?status=menunggu_spv,disetujui");
        assert.equal(aktif.body.selesaiTerpotong, false);
        assert.ok((aktif.body.rows as { id: string }[]).some((r) => r.id === lama));
    } finally {
        await pool.query(`DELETE FROM noo_toko WHERE kode LIKE 'NOO-T%' OR id = $1`, [lama]);
    }
});

// =========================================================================== DDL / migrasi / RBAC

type Cek = { cek: string; ok: boolean | null };
const barisTerakhir = (hasil: unknown) => { const h = (Array.isArray(hasil) ? hasil : [hasil]) as { rows: Cek[] }[]; return h[h.length - 1].rows; };
async function skemaBaru(dasar: boolean) {
    const s = `uji_nood_${randomUUID().slice(0, 8)}`;
    await admin.query(`CREATE SCHEMA ${s}`);
    skemaLain.push(s);
    if (dasar) for (const t of ["kunjungan_luar_rute", "jks_master", "customer", "branch", "accurate_employee", "sales_profile", "kontrol_audit_log", "user"]) {
        await admin.query(`CREATE TABLE ${s}."${t}" (LIKE ${skema}."${t}" INCLUDING DEFAULTS)`);
    }
    return { skema: s, pool: new Pool({ connectionString: urlSkema(s), max: 2 }) };
}
async function katalog(p: Pool) {
    const kol = (await p.query(`SELECT a.attname AS c, format_type(a.atttypid, a.atttypmod) AS tipe, a.attnotnull AS wajib,
            pg_get_expr(d.adbin, d.adrelid) AS bawaan FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = to_regclass('noo_toko') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`)).rows;
    const cek = (await p.query(`SELECT conname, pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid = to_regclass('noo_toko') ORDER BY 1`)).rows;
    const idx = (await p.query(`SELECT indexname, regexp_replace(indexdef, ' ON [^ ]+ ', ' ON ') d FROM pg_indexes WHERE schemaname = current_schema()
        AND tablename = 'noo_toko' ORDER BY 1`)).rows;
    return { kol, cek, idx };
}

test("PG NOO: DDL_NOO dua kali idempoten + VERIFIKASI (+ sabotase hak/CHECK/indeks); migrate-pg OK->SKIP; = 0035 = Drizzle", { skip: pgSkip }, async () => {
    const PERAN_UJI = `uji_app_${randomUUID().slice(0, 8)}`;
    const ddl = (await berkas("../../docs/handover/DDL_NOO.sql")).replaceAll("accapi_app", PERAN_UJI);
    const { migrations } = await import(new URL("../../scripts/migrate-pg.mjs", import.meta.url).href) as { migrations: { nama: string; sudahAda: string; sql: string }[] };
    const entri = migrations.find((x) => x.nama === "noo_toko (NOO)");
    assert.ok(entri, "entri migrate-pg");
    const migrasi = async (p: Pool) => ((await p.query(entri.sudahAda)).rowCount ? "SKIP" : (await p.query(entri.sql), "OK"));

    const a = await skemaBaru(false);
    assert.equal(await migrasi(a.pool), "OK");
    assert.equal(await migrasi(a.pool), "SKIP", "sesudah tabel ada entri dilewati");
    const b = await skemaBaru(true);
    for (let i = 0; i < 2; i++) {
        const v = barisTerakhir(await b.pool.query(ddl));
        assert.equal(v.length, 11, "VERIFIKASI lengkap");
        for (const x of v) assert.notEqual(x.ok, false, `VERIFIKASI gagal: ${x.cek}`);
    }
    assert.equal(await migrasi(b.pool), "SKIP", "DDL manual sebelum image -> migrate-pg SKIP");
    const c = await skemaBaru(false);
    await c.pool.query(await berkas("../../db/migrations/0035_noo_toko.sql"));
    const [ka, kb, kc] = [await katalog(a.pool), await katalog(b.pool), await katalog(c.pool)];
    assert.equal(ka.kol.length, 35);
    assert.equal(ka.cek.length, 8, "PK + 7 CHECK");
    assert.equal(ka.idx.length, 7, "PK + 6 indeks");
    assert.deepEqual(kb, ka, "DDL = migrate-pg");
    assert.deepEqual(kc, ka, "0035 = migrate-pg");
    const cfg = getTableConfig(nooToko);
    assert.deepEqual(cfg.columns.map((x) => ({ c: x.name, tipe: x.getSQLType().replace("timestamp with time zone", "timestamptz"), wajib: x.notNull, bawaan: x.hasDefault })),
        ka.kol.map((x) => ({ c: x.c, tipe: String(x.tipe).replace("timestamp with time zone", "timestamptz"), wajib: x.wajib, bawaan: x.bawaan !== null })));
    assert.deepEqual(cfg.checks.map((x) => x.name).sort(), ka.cek.map((x) => x.conname).filter((n) => !n.endsWith("_pkey")).sort());
    assert.deepEqual(cfg.indexes.map((x) => x.config.name).sort(), ka.idx.map((x) => x.indexname).filter((n) => !n.endsWith("_pkey")).sort());
    for (const n of ["idx_noo_customer", "idx_noo_nik", "idx_noo_hp"]) assert.ok(cfg.indexes.find((x) => x.config.name === n)?.config.where, `${n} parsial juga di Drizzle`);

    // Sebagian: tabel ada tanpa indeks unik pelanggan -> sudahAda false -> entri melengkapi.
    const d = await skemaBaru(false);
    await d.pool.query(entri.sql);
    await d.pool.query("DROP INDEX idx_noo_customer");
    assert.equal(await migrasi(d.pool), "OK");
    assert.deepEqual(await katalog(d.pool), ka);

    const verif = ddl.slice(ddl.lastIndexOf("COMMIT;") + "COMMIT;".length);
    const k = await b.pool.connect();
    try {
        await k.query("BEGIN");
        await k.query(`CREATE ROLE ${PERAN_UJI} NOLOGIN`);
        await k.query(`GRANT USAGE ON SCHEMA ${b.skema} TO ${PERAN_UJI}`);
        await k.query(`GRANT SELECT, INSERT ON kunjungan_luar_rute TO ${PERAN_UJI}`);
        await k.query(`GRANT SELECT ON customer, branch, accurate_employee, sales_profile, jks_master TO ${PERAN_UJI}`);
        await k.query(`GRANT INSERT ON kontrol_audit_log TO ${PERAN_UJI}`);
        await k.query(`GRANT DELETE, TRUNCATE ON noo_toko TO ${PERAN_UJI}`); // default privileges L1g -> blok 2 mencabut
        await k.query(ddl.slice(ddl.indexOf("DO $$"), ddl.indexOf("END $$;") + "END $$;".length));
        for (const v of (await k.query(verif)).rows as Cek[]) assert.equal(v.ok, true, `hak penuh: ${v.cek}`);
        await k.query(`GRANT DELETE ON noo_toko TO ${PERAN_UJI}`);
        await k.query(`REVOKE INSERT ON kontrol_audit_log FROM ${PERAN_UJI}`);
        await k.query("ALTER TABLE noo_toko DROP CONSTRAINT noo_toko_duplikat");
        await k.query("ALTER TABLE noo_toko ADD CONSTRAINT noo_toko_duplikat CHECK (true)");
        await k.query("DROP INDEX idx_noo_nik");
        const kurang = (await k.query(verif)).rows as Cek[];
        const nilai = (awal: string) => kurang.find((v) => v.cek.startsWith(awal))?.ok;
        assert.equal(nilai(`${PERAN_UJI} tanpa DELETE`), false, "sabotase DELETE terbaca");
        assert.equal(nilai(`prasyarat: ${PERAN_UJI} boleh INSERT kontrol_audit_log`), false);
        assert.equal(nilai("CHECK status"), false, "CHECK dilemahkan terbaca");
        assert.equal(nilai("indeks idx_noo_sales"), false, "indeks hilang terbaca");
        assert.equal(kurang.filter((v) => v.ok === false).length, 4, "hanya yang disabotase");
    } finally {
        await k.query("ROLLBACK");
        k.release();
    }
    for (const x of [a, b, c, d]) await x.pool.end();
});

test("RBAC_PRESET_NOO: SPV/SM noo_setujui, Admin + noo_ktp + noo_tautkan; Admin Sales/Manager tidak; idempoten (jalan kedua 0/0); audit per grup", { skip: pgSkip }, async () => {
    const sql = await berkas("../../docs/handover/RBAC_PRESET_NOO.sql");
    const k = await pool.connect();
    try {
        await k.query("BEGIN");
        await k.query(`DELETE FROM group_permission WHERE permission_key LIKE 'form_kontrol.noo_%'`);
        const hasil = (r: unknown) => { const a = (Array.isArray(r) ? r : [r]) as { rows: Record<string, string>[] }[]; return a.find((x) => x.rows?.[0]?.izin_disisipkan !== undefined)!.rows[0]; };
        const satu = hasil(await k.query(sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "")));
        assert.deepEqual([Number(satu.izin_disisipkan), Number(satu.audit)], [5, 3]);
        const dua = hasil(await k.query(sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "")));
        assert.deepEqual([Number(dua.izin_disisipkan), Number(dua.audit)], [0, 0]);
        const kunci = (await k.query(`SELECT g.name, array_agg(p.permission_key ORDER BY p.permission_key) k FROM group_permission p JOIN access_group g ON g.id = p.group_id
            WHERE p.permission_key LIKE 'form_kontrol.noo_%' GROUP BY g.name ORDER BY g.name`)).rows;
        assert.deepEqual(kunci, [{ name: "Admin", k: ["form_kontrol.noo_ktp", "form_kontrol.noo_setujui", "form_kontrol.noo_tautkan"] }, { name: "SM", k: ["form_kontrol.noo_setujui"] },
            { name: "SPV", k: ["form_kontrol.noo_setujui"] }]);
    } finally {
        await k.query("ROLLBACK");
        k.release();
    }
});
