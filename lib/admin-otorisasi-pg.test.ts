/* S7-1 (BL-61/62/63) dengan Postgres EVALUASI (AM040_DATABASE_URL, DB sekali-pakai — BUKAN produksi): route ASLI /api/admin/**,
 * hanya sesi Better Auth yang dipalsukan (aktor dari header uji). Penjaga BL-61 per celah S7-EKSPLORASI §4.3, atomik (409 = tidak
 * ada perubahan + tidak ada audit), balapan dua admin saling mencabut. DB harus TANPA admin lain (DB sekali-pakai milik uji ini);
 * semua baris uji berawalan "s71-" dan dihapus di akhir. Tanpa env dilewati dengan sebabnya. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";
if (PG_URL) process.env.DATABASE_URL = PG_URL;

type H = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type Modul = Awaited<ReturnType<typeof muat>>;

async function muat() {
    const { db, pool } = await import("./db.ts");
    const { auth } = await import("./auth.ts");
    const { adminAktif } = await import("./rbac/otorisasi.ts");
    const grup = await import("../app/api/admin/groups/route.ts");
    const grupId = await import("../app/api/admin/groups/[id]/route.ts");
    const anggota = await import("../app/api/admin/groups/[id]/members/route.ts");
    const userGrup = await import("../app/api/admin/users/[id]/group/route.ts");
    const users = await import("../app/api/admin/users/route.ts");
    const sandi = await import("../app/api/admin/users/[id]/password/route.ts");
    const status = await import("../app/api/admin/users/[id]/status/route.ts");
    const bootstrap = await import("../app/api/admin/bootstrap/route.ts");
    const bintang = await import("../app/api/admin/users/[id]/primary-group/route.ts");
    const daftar = await import("../app/api/admin/users/permissions/route.ts");
    return { db, pool, auth, adminAktif, grup, grupId, anggota, userGrup, users, sandi, status, bootstrap, bintang, daftar };
}

let m: Modul;
let savedSes: PropertyDescriptor | undefined;
const savedEnv = { bypass: process.env.LOCAL_AUTH_BYPASS, node: process.env.NODE_ENV };

before(async () => {
    if (!PG_URL) return;
    m = await muat();
    delete process.env.LOCAL_AUTH_BYPASS;
    savedSes = Object.getOwnPropertyDescriptor(m.auth.api, "getSession");
    // Sesi palsu: aktor = header x-uji-aktor (baris user nyata); tanpa header = tanpa sesi.
    Object.defineProperty(m.auth.api, "getSession", { configurable: true, value: async ({ headers }: { headers: Headers }) => {
        const id = headers.get("x-uji-aktor");
        if (!id) return null;
        const u = (await m.pool.query(`SELECT id, name, email, role FROM "user" WHERE id = $1`, [id])).rows[0];
        return u ? { user: u, session: { id: `s-${id}` } } : null;
    } });
    const lain = [...await m.db.transaction((tx) => m.adminAktif(tx))].filter((id) => !id.startsWith("s71-"));
    assert.deepEqual(lain, [], "DB uji harus tanpa admin lain (penjaga 0-admin dihitung global)");
});

after(async () => {
    if (!PG_URL) return;
    await bersihkan("s71-");
    if (savedSes) Object.defineProperty(m.auth.api, "getSession", savedSes);
    if (savedEnv.bypass !== undefined) process.env.LOCAL_AUTH_BYPASS = savedEnv.bypass;
    await m.pool.end();
});

async function bersihkan(awalan: string) {
    // User buatan Better Auth ber-id acak -> dikenali lewat email berawalan sama.
    const ids = (await m.pool.query(`SELECT id FROM "user" WHERE id LIKE $1 OR email LIKE $1`, [`${awalan}%`])).rows.map((r) => r.id as string);
    const q = (s: string, v: unknown[]) => m.pool.query(s, v);
    await q(`DELETE FROM session WHERE "userId" = ANY($1)`, [ids]);
    await q(`DELETE FROM account WHERE "userId" = ANY($1)`, [ids]);
    await q(`DELETE FROM user_group WHERE user_id = ANY($1) OR group_id LIKE $2`, [ids, `${awalan}%`]);
    await q(`DELETE FROM group_permission WHERE group_id LIKE $1`, [`${awalan}%`]);
    await q(`DELETE FROM access_group WHERE id LIKE $1`, [`${awalan}%`]);
    await q(`DELETE FROM permission_audit_log WHERE actor_user_id = ANY($1) OR target_user_id = ANY($1) OR target_group_id LIKE $2`, [ids, `${awalan}%`]);
    await q(`DELETE FROM "user" WHERE id = ANY($1)`, [ids]);
}

/** Dunia uji dengan awalan unik; dibersihkan sesudahnya. */
async function dunia(fn: (w: ReturnType<typeof alat>) => Promise<void>) {
    const w = alat(`s71-${randomUUID().slice(0, 6)}`);
    try { await fn(w); } finally { await bersihkan(w.p); }
}

function alat(p: string) {
    const q = (s: string, v: unknown[] = []) => m.pool.query(s, v);
    return {
        p,
        user: async (n: string, o: { role?: string; banned?: boolean } = {}) => {
            await q(`INSERT INTO "user" (id, name, email, "emailVerified", role, banned, "createdAt", "updatedAt") VALUES ($1, $2, $3, true, $4, $5, now(), now())`,
                [`${p}-${n}`, `Uji ${n}`, `${p}-${n}@s71.test`, o.role ?? "viewer", o.banned ?? false]);
            return `${p}-${n}`;
        },
        grup: async (n: string, keys: string[], o: { preset?: boolean; nama?: string } = {}) => {
            const id = `${p}-g-${n}`;
            await q(`INSERT INTO access_group (id, name, description, is_preset, created_at, updated_at) VALUES ($1, $2, '', $3, now(), now())`, [id, o.nama ?? `${p} ${n}`, o.preset ?? false]);
            for (const k of keys) await q(`INSERT INTO group_permission (group_id, permission_key) VALUES ($1, $2)`, [id, k]);
            return id;
        },
        masuk: async (userId: string, groupId: string, primary = false) =>
            q(`INSERT INTO user_group (user_id, group_id, assigned_at, is_primary) VALUES ($1, $2, now(), $3)`, [userId, groupId, primary]),
        grupUser: async (userId: string) => (await q(`SELECT group_id FROM user_group WHERE user_id = $1 ORDER BY group_id`, [userId])).rows.map((r) => r.group_id as string),
        audit: async () => (await q(`SELECT action, actor_user_id, target_user_id, target_group_id, detail FROM permission_audit_log
            WHERE actor_user_id LIKE $1 OR target_group_id LIKE $1
               OR target_user_id IN (SELECT id FROM "user" WHERE id LIKE $1 OR email LIKE $1) ORDER BY created_at, id`, [`${p}%`])).rows,
        admin: async () => [...await m.db.transaction((tx) => m.adminAktif(tx))].filter((id) => id.startsWith(p)).sort(),
    };
}

const panggil = (h: H, aktor: string | null, method: string, id: string, body?: unknown, extra: Record<string, string> = {}) =>
    h(new NextRequest(`http://localhost/api/admin/x/${id}`, {
        method, headers: { "content-type": "application/json", host: "app.test", ...(aktor ? { "x-uji-aktor": aktor } : {}), ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { params: Promise.resolve({ id }) });

const kode = async (res: Response) => ({ status: res.status, code: ((await res.json()) as { code?: string }).code });

/** Aktor bypass lokal (bukan baris user) — satu-satunya cara mencapai ADMIN_TERAKHIR tanpa AKSES_SENDIRI (aktor admin selalu ikut terhitung). */
async function bypass<T>(fn: () => Promise<T>): Promise<T> {
    process.env.LOCAL_AUTH_BYPASS = "true";
    (process.env as Record<string, string>).NODE_ENV = "development";
    try { return await fn(); } finally {
        delete process.env.LOCAL_AUTH_BYPASS;
        (process.env as Record<string, string | undefined>).NODE_ENV = savedEnv.node;
    }
}
const lokal = { host: "localhost" };

test("celah 2 (members DELETE): keluar sendiri dari grup pemberi users.manage -> 409 AKSES_SENDIRI tanpa perubahan/audit; keluarkan admin lain boleh", { skip: pgSkip }, async () => {
    await dunia(async (w) => {
        const ga = await w.grup("kelola", ["users.manage", "dashboard.view"]);
        const gv = await w.grup("lihat", ["dashboard.view"]);
        const a = await w.user("a"), b = await w.user("b");
        for (const u of [a, b]) { await w.masuk(u, ga); await w.masuk(u, gv); }
        assert.deepEqual(await w.admin(), [a, b]);

        assert.deepEqual(await kode(await panggil(m.anggota.DELETE, a, "DELETE", ga, { userId: a })), { status: 409, code: "AKSES_SENDIRI" });
        assert.deepEqual(await w.grupUser(a), [ga, gv].sort(), "keanggotaan utuh");
        assert.deepEqual(await w.audit(), [], "tidak ada audit palsu");

        assert.equal((await panggil(m.anggota.DELETE, a, "DELETE", ga, { userId: b })).status, 200);
        assert.deepEqual(await w.admin(), [a]);
        assert.deepEqual((await w.audit()).map((r) => [r.action, r.target_user_id]), [["user_group.remove", b]]);
        // Bukan anggota lagi -> 404 berkode.
        assert.deepEqual(await kode(await panggil(m.anggota.DELETE, a, "DELETE", ga, { userId: b })), { status: 404, code: "BUKAN_ANGGOTA" });
    });
});

test("0 admin (aktor bypass, bukan baris user): keluarkan admin terakhir -> 409 ADMIN_TERAKHIR; admin banned tidak dihitung", { skip: pgSkip }, async () => {
    await dunia(async (w) => {
        const ga = await w.grup("kelola", ["users.manage"]);
        const gv = await w.grup("lihat", ["dashboard.view"]);
        const a = await w.user("a"), z = await w.user("z", { banned: true });
        for (const u of [a, z]) { await w.masuk(u, ga); await w.masuk(u, gv); }
        assert.deepEqual(await w.admin(), [a], "banned bukan admin");
        const res = await bypass(() => panggil(m.anggota.DELETE, null, "DELETE", ga, { userId: a }, lokal));
        assert.deepEqual(await kode(res), { status: 409, code: "ADMIN_TERAKHIR" });
        assert.deepEqual(await w.grupUser(a), [ga, gv].sort());
    });
});

test("celah 6 (definisi tunggal): admin role lama tanpa grup dihitung; masuk grup tanpa users.manage membuang fallback -> AKSES_SENDIRI", { skip: pgSkip }, async () => {
    await dunia(async (w) => {
        const gv = await w.grup("lihat", ["dashboard.view"]);
        const l = await w.user("lama", { role: "admin" });
        assert.deepEqual(await w.admin(), [l]);
        assert.deepEqual(await kode(await panggil(m.anggota.POST, l, "POST", gv, { userId: l })), { status: 409, code: "AKSES_SENDIRI" });
        assert.deepEqual(await w.grupUser(l), []);
        // Menambah user lain: boleh; sudah anggota -> added:false tanpa audit kedua.
        const u = await w.user("u");
        const r1 = await panggil(m.anggota.POST, l, "POST", gv, { userId: u });
        assert.equal(r1.status, 200);
        assert.equal(((await r1.json()) as { added: boolean }).added, true);
        assert.equal(((await (await panggil(m.anggota.POST, l, "POST", gv, { userId: u })).json()) as { added: boolean }).added, false);
        assert.equal((await w.audit()).filter((r) => r.action === "user_group.assign").length, 1);
        assert.deepEqual(await kode(await panggil(m.anggota.POST, l, "POST", gv, { userId: `${w.p}-tidak-ada` })), { status: 404, code: "USER_TIDAK_ADA" });
        assert.deepEqual(await kode(await panggil(m.anggota.POST, l, "POST", `${w.p}-g-tidak-ada`, { userId: u })), { status: 404, code: "GRUP_TIDAK_ADA" });
    });
});

test("celah 3+4 (PATCH grup): cabut users.manage preset Admin -> ADMIN_PRESET_TERKUNCI; dari grup custom aktor -> AKSES_SENDIRI; nama preset terkunci; nama+izin satu transaksi", { skip: pgSkip }, async () => {
    await dunia(async (w) => {
        const adm = await w.grup("admin", ["users.manage", "dashboard.view"], { preset: true, nama: "Admin" });
        const it = await w.grup("it", ["users.manage"]);
        const a = await w.user("a"), b = await w.user("b");
        await w.masuk(a, adm); await w.masuk(a, it); await w.masuk(b, it);

        assert.deepEqual(await kode(await panggil(m.grupId.PATCH, a, "PATCH", adm, { permissions: ["dashboard.view"] })), { status: 409, code: "ADMIN_PRESET_TERKUNCI" });
        assert.deepEqual(await kode(await panggil(m.grupId.PATCH, a, "PATCH", adm, { name: "Super" })), { status: 409, code: "PRESET_NAMA_TERKUNCI" });
        assert.equal((await panggil(m.grupId.PATCH, a, "PATCH", adm, { description: "Akses penuh" })).status, 200, "deskripsi preset boleh");

        // a keluar dari Admin dulu (masih punya IT) -> lalu cabut users.manage dari IT = mencabut diri sendiri. Nama ikut batal.
        assert.equal((await panggil(m.anggota.DELETE, a, "DELETE", adm, { userId: a })).status, 200);
        const sebelum = (await w.audit()).length;
        assert.deepEqual(await kode(await panggil(m.grupId.PATCH, a, "PATCH", it, { name: `${w.p} IT baru`, permissions: ["dashboard.view"] })), { status: 409, code: "AKSES_SENDIRI" });
        const g = (await m.pool.query(`SELECT name FROM access_group WHERE id = $1`, [it])).rows[0];
        assert.equal(g.name, `${w.p} it`, "nama tidak tersimpan bila izin ditolak (satu transaksi)");
        assert.deepEqual((await m.pool.query(`SELECT permission_key FROM group_permission WHERE group_id = $1`, [it])).rows.map((r) => r.permission_key), ["users.manage"]);
        assert.equal((await w.audit()).length, sebelum, "tanpa audit palsu");
        // Nama bentrok -> 409 berkode (bukan 500).
        assert.deepEqual(await kode(await panggil(m.grupId.PATCH, a, "PATCH", it, { name: "Admin" })), { status: 409, code: "NAMA_GRUP_TERPAKAI" });
        assert.deepEqual(await kode(await panggil(m.grup.POST as unknown as H, a, "POST", "", { name: "Admin" })), { status: 409, code: "NAMA_GRUP_TERPAKAI" });
        assert.deepEqual(await kode(await panggil(m.grupId.DELETE, a, "DELETE", adm)), { status: 409, code: "PRESET_TIDAK_BISA_DIHAPUS" });
    });
});

test("GRUP_TERAKHIR + DELETE grup: keluarkan dari satu-satunya grup / hapus grup satu-satunya -> 409 + daftar; hapus grup pemberi akses aktor -> AKSES_SENDIRI; atomik", { skip: pgSkip }, async () => {
    await dunia(async (w) => {
        const adm = await w.grup("kelola", ["users.manage"]);
        const tim = await w.grup("tim", ["dashboard.view"]);
        const a = await w.user("a"), u = await w.user("u");
        await w.masuk(a, adm); await w.masuk(a, tim); await w.masuk(u, tim);

        const r = await panggil(m.anggota.DELETE, a, "DELETE", tim, { userId: u });
        assert.equal(r.status, 409);
        const j = await r.json() as { code: string; users: Array<{ id: string }> };
        assert.equal(j.code, "GRUP_TERAKHIR");
        assert.deepEqual(j.users.map((x) => x.id), [u]);
        assert.deepEqual(await kode(await panggil(m.grupId.DELETE, a, "DELETE", tim)), { status: 409, code: "GRUP_TERAKHIR" });
        assert.deepEqual(await w.grupUser(u), [tim]);

        // a punya dua grup; hapus grup kelola (custom) = a kehilangan users.manage -> AKSES_SENDIRI, grup & izin utuh.
        assert.deepEqual(await kode(await panggil(m.grupId.DELETE, a, "DELETE", adm)), { status: 409, code: "AKSES_SENDIRI" });
        assert.equal((await m.pool.query(`SELECT count(*)::int AS n FROM group_permission WHERE group_id = $1`, [adm])).rows[0].n, 1);
        assert.deepEqual(await w.audit(), []);
    });
});

// Celah 1 (route lama "ganti semua" users/[id]/group): ditutup dengan PENSIUN semantik — lihat uji BL-63 "route lama".

test("balapan: dua admin saling mencabut BERSAMAAN -> tepat satu berhasil, tersisa satu admin (kunci global dalam transaksi)", { skip: pgSkip }, async () => {
    await dunia(async (w) => {
        const ga = await w.grup("kelola", ["users.manage"]);
        const gv = await w.grup("lihat", ["dashboard.view"]);
        const a = await w.user("race-a"), b = await w.user("race-b");
        for (const u of [a, b]) { await w.masuk(u, ga); await w.masuk(u, gv); }
        // Jendela balapan dilebarkan: DELETE user_group milik uji ini tidur 0,4 dtk sebelum penjaga menghitung.
        await m.pool.query(`CREATE OR REPLACE FUNCTION s71_lambat() RETURNS trigger LANGUAGE plpgsql AS $f$
            BEGIN IF OLD.user_id LIKE '${w.p}-race-%' THEN PERFORM pg_sleep(0.4); END IF; RETURN OLD; END $f$`);
        await m.pool.query(`DROP TRIGGER IF EXISTS s71_lambat ON user_group`);
        await m.pool.query(`CREATE TRIGGER s71_lambat AFTER DELETE ON user_group FOR EACH ROW EXECUTE FUNCTION s71_lambat()`);
        try {
            const [ra, rb] = await Promise.all([
                panggil(m.anggota.DELETE, a, "DELETE", ga, { userId: b }),
                panggil(m.anggota.DELETE, b, "DELETE", ga, { userId: a }),
            ]);
            const hasil = [await kode(ra), await kode(rb)].sort((x, y) => x.status - y.status);
            assert.equal(hasil[0].status, 200, JSON.stringify(hasil));
            assert.ok(["IZIN_BERUBAH", "ADMIN_TERAKHIR"].includes(String(hasil[1].code)), JSON.stringify(hasil));
            assert.equal((await w.admin()).length, 1, "tepat satu admin tersisa");
        } finally {
            await m.pool.query(`DROP TRIGGER IF EXISTS s71_lambat ON user_group`);
            await m.pool.query(`DROP FUNCTION IF EXISTS s71_lambat()`);
        }
    });
});

// ---------------- BL-62: buat user, atur sandi, aktif/nonaktif (Better Auth server-side + transaksi app) ----------------

const masukDengan = (email: string, password: string) => m.auth.api.signInEmail({ body: { email, password } });

/** Tangkap console.* selama fn (sandi tidak boleh muncul di log). */
async function tangkapLog<T>(fn: () => Promise<T>): Promise<{ hasil: T; log: string }> {
    const keys = ["log", "info", "warn", "error", "debug"] as const;
    const asli = keys.map((k) => console[k]);
    const buf: string[] = [];
    keys.forEach((k) => { console[k] = (...a: unknown[]) => { buf.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" ")); }; });
    try { return { hasil: await fn(), log: buf.join("\n") }; } finally { keys.forEach((k, i) => { console[k] = asli[i]; }); }
}

/** Trigger uji: INSERT audit dengan aksi + penanda tertentu GAGAL (meniru galat di tengah transaksi, sesudah tulisan lain). */
async function auditGagal<T>(aksi: string, penanda: string, fn: () => Promise<T>): Promise<T> {
    await m.pool.query(`CREATE OR REPLACE FUNCTION s71_gagal() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN IF NEW.action = '${aksi}' AND (NEW.detail::text LIKE '%${penanda}%' OR NEW.target_user_id LIKE '%${penanda}%') THEN
            RAISE EXCEPTION 'uji s71: audit gagal'; END IF; RETURN NEW; END $f$`);
    await m.pool.query(`DROP TRIGGER IF EXISTS s71_gagal ON permission_audit_log`);
    await m.pool.query(`CREATE TRIGGER s71_gagal BEFORE INSERT ON permission_audit_log FOR EACH ROW EXECUTE FUNCTION s71_gagal()`);
    try { return await fn(); } finally {
        await m.pool.query(`DROP TRIGGER IF EXISTS s71_gagal ON permission_audit_log`);
        await m.pool.query(`DROP FUNCTION IF EXISTS s71_gagal()`);
    }
}

const PW = "Sandi-Rahasia-71a";
const PW2 = "Sandi-Baru-71b";
const buat = (aktor: string, body: unknown) => panggil(m.users.POST as unknown as H, aktor, "POST", "", body);

test("BL-62 buat user: 201, emailVerified, tanpa ban, grup + bintang (1 grup), audit TANPA sandi, sandi bisa dipakai masuk; 409 email; 404 grup tanpa user Better Auth", { skip: pgSkip }, async () => {
    await dunia(async (w) => {
        const ga = await w.grup("kelola", ["users.manage"]);
        const gv = await w.grup("lihat", ["dashboard.view"]);
        const a = await w.user("a");
        await w.masuk(a, ga);
        const email = `${w.p}-baru@s71.test`;
        const { hasil: res, log } = await tangkapLog(() => buat(a, { name: "User Baru", email, password: PW, groupIds: [gv] }));
        const teks = await res.text();
        assert.equal(res.status, 201, teks);
        const j = JSON.parse(teks) as { user: { id: string; primaryGroupId: string } };
        assert.equal(j.user.primaryGroupId, gv);
        const u = (await m.pool.query(`SELECT id, role, banned, "banReason", "emailVerified" FROM "user" WHERE email = $1`, [email])).rows[0];
        assert.deepEqual({ role: u.role, banned: u.banned, banReason: u.banReason, emailVerified: u.emailVerified }, { role: "viewer", banned: false, banReason: null, emailVerified: true });
        assert.deepEqual((await m.pool.query(`SELECT group_id, is_primary FROM user_group WHERE user_id = $1`, [u.id])).rows, [{ group_id: gv, is_primary: true }]);
        assert.equal((await w.audit()).filter((r) => r.action === "user.create").length, 1);
        assert.ok(!(JSON.stringify(await w.audit()) + teks + log).includes(PW), "sandi bocor ke audit/jawaban/log");
        assert.ok((await masukDengan(email, PW)).token, "sandi dapat dipakai masuk");

        assert.deepEqual(await kode(await buat(a, { name: "Lagi", email, password: PW, groupIds: [gv] })), { status: 409, code: "EMAIL_TERPAKAI" });
        const email2 = `${w.p}-tanpagrup@s71.test`;
        assert.deepEqual(await kode(await buat(a, { name: "X", email: email2, password: PW, groupIds: [`${w.p}-g-hilang`] })), { status: 404, code: "GRUP_TIDAK_ADA" });
        assert.deepEqual(await kode(await buat(a, { name: "X", email: email2, password: "12345", groupIds: [gv] })), { status: 400, code: "SANDI_TERLALU_PENDEK" });
        assert.deepEqual(await kode(await buat(a, { name: "X", email: email2, password: PW, groupIds: [] })), { status: 400, code: "INPUT_TIDAK_VALID" });
        assert.deepEqual(await kode(await buat(a, { name: "X", email: "bukan-email", password: PW, groupIds: [gv] })), { status: 400, code: "EMAIL_TIDAK_VALID" });
        assert.equal((await m.pool.query(`SELECT count(*)::int AS n FROM "user" WHERE email = $1`, [email2])).rows[0].n, 0);
    });
});

test("BL-62 buat user ATOMIK: galat di tengah transaksi app -> 500, user Better Auth dikompensasi (tidak ada user/grup/audit)", { skip: pgSkip }, async () => {
    await dunia(async (w) => {
        const ga = await w.grup("kelola", ["users.manage"]);
        const a = await w.user("a");
        await w.masuk(a, ga);
        const email = `${w.p}-gagal@s71.test`;
        const res = await auditGagal("user.create", `${w.p}-gagal`, () => buat(a, { name: "Gagal", email, password: PW, groupIds: [ga] }));
        assert.deepEqual(await kode(res), { status: 500, code: "GAGAL_SIMPAN" });
        assert.equal((await m.pool.query(`SELECT count(*)::int AS n FROM "user" WHERE email = $1`, [email])).rows[0].n, 0, "user dikompensasi");
        assert.equal((await m.pool.query(`SELECT count(*)::int AS n FROM permission_audit_log WHERE detail->>'email' = $1`, [email])).rows[0].n, 0);
        assert.deepEqual(await w.grupUser(a), [ga]);
    });
});

test("BL-62 atur sandi: 400 pendek; galat di tengah -> sandi & sesi utuh; 200 cabut SEMUA sesi, sandi lama ditolak/baru masuk, sandi tak bocor", { skip: pgSkip }, async () => {
    await dunia(async (w) => {
        const ga = await w.grup("kelola", ["users.manage"]);
        const gv = await w.grup("lihat", ["dashboard.view"]);
        const a = await w.user("a");
        await w.masuk(a, ga);
        const email = `${w.p}-sandi@s71.test`;
        const uid = ((await (await buat(a, { name: "Sandi", email, password: PW, groupIds: [gv] })).json()) as { user: { id: string } }).user.id;
        const sesi = async () => (await m.pool.query(`SELECT count(*)::int AS n FROM session WHERE "userId" = $1`, [uid])).rows[0].n as number;
        await masukDengan(email, PW); await masukDengan(email, PW);
        assert.equal(await sesi(), 2);

        assert.deepEqual(await kode(await panggil(m.sandi.POST, a, "POST", uid, { password: "12345" })), { status: 400, code: "SANDI_TERLALU_PENDEK" });
        const gagal = await auditGagal("user.password_set", uid, () => panggil(m.sandi.POST, a, "POST", uid, { password: PW2 }));
        assert.deepEqual(await kode(gagal), { status: 500, code: "GAGAL_SIMPAN" });
        assert.equal(await sesi(), 2, "sesi utuh");
        assert.ok((await masukDengan(email, PW)).token, "sandi lama masih berlaku");
        assert.equal(await sesi(), 3);

        const { hasil: ok, log } = await tangkapLog(() => panggil(m.sandi.POST, a, "POST", uid, { password: PW2 }));
        const teks = await ok.text();
        assert.equal(ok.status, 200, teks);
        assert.deepEqual(JSON.parse(teks), { ok: true, sessionsRevoked: 3 });
        assert.equal(await sesi(), 0, "semua sesi dicabut");
        await assert.rejects(masukDengan(email, PW), "sandi lama ditolak");
        assert.ok((await masukDengan(email, PW2)).token);
        const audit = await w.audit();
        assert.deepEqual(audit.filter((x) => x.action === "user.password_set").map((x) => x.detail), [{ userName: "Sandi", sessionsRevoked: 3 }]);
        assert.ok(!(JSON.stringify(audit) + teks + log).includes(PW2), "sandi bocor");
        assert.deepEqual(await kode(await panggil(m.sandi.POST, a, "POST", `${w.p}-tidak-ada`, { password: PW2 })), { status: 404, code: "USER_TIDAK_ADA" });
    });
});

test("BL-62 aktif/nonaktif: nonaktif = ban + cabut sesi (tidak dihapus), masuk ditolak; diri sendiri -> AKSES_SENDIRI; ulang = changed:false tanpa audit; aktifkan lagi", { skip: pgSkip }, async () => {
    await dunia(async (w) => {
        const ga = await w.grup("kelola", ["users.manage"]);
        const gv = await w.grup("lihat", ["dashboard.view"]);
        const a = await w.user("a");
        await w.masuk(a, ga);
        const email = `${w.p}-status@s71.test`;
        const uid = ((await (await buat(a, { name: "Status", email, password: PW, groupIds: [gv] })).json()) as { user: { id: string } }).user.id;
        await masukDengan(email, PW);

        const off = await panggil(m.status.POST, a, "POST", uid, { active: false, reason: "Cuti panjang" });
        assert.deepEqual(await off.json(), { ok: true, active: false, changed: true, sessionsRevoked: 1 });
        assert.deepEqual((await m.pool.query(`SELECT banned, "banReason" FROM "user" WHERE id = $1`, [uid])).rows[0], { banned: true, banReason: "Cuti panjang" });
        await assert.rejects(masukDengan(email, PW), (e: { body?: { code?: string } }) => e.body?.code === "BANNED_USER");
        const n = (await w.audit()).length;
        assert.deepEqual(await (await panggil(m.status.POST, a, "POST", uid, { active: false })).json(), { ok: true, active: false, changed: false, sessionsRevoked: 0 });
        assert.equal((await w.audit()).length, n, "tanpa perubahan = tanpa audit");

        assert.deepEqual(await kode(await panggil(m.status.POST, a, "POST", a, { active: false })), { status: 409, code: "AKSES_SENDIRI" });
        assert.equal((await m.pool.query(`SELECT banned FROM "user" WHERE id = $1`, [a])).rows[0].banned, false);
        assert.deepEqual(await kode(await panggil(m.status.POST, a, "POST", uid, { active: "ya" })), { status: 400, code: "INPUT_TIDAK_VALID" });

        assert.equal((await panggil(m.status.POST, a, "POST", uid, { active: true })).status, 200);
        assert.ok((await masukDengan(email, PW)).token, "aktif lagi bisa masuk");
        assert.deepEqual((await w.audit()).filter((x) => x.target_user_id === uid).map((x) => x.action), ["user.create", "user.deactivate", "user.activate"]);
    });
});

test("disabledPaths tidak mematikan auth.api server-side: bootstrap/route.ts (createUser tanpa sesi) tetap membuat user", { skip: pgSkip }, async () => {
    await dunia(async (w) => {
        const email = `${w.p}-boot@s71.test`;
        const savedSel = Object.getOwnPropertyDescriptor(m.db, "select");
        const realSelect = m.db.select.bind(m.db);
        const token = process.env.ADMIN_SETUP_TOKEN;
        process.env.ADMIN_SETUP_TOKEN = "token-uji-s71";
        // Hanya hitung user (syarat "belum ada user") yang dipalsukan 0; createUser menulis ke DB nyata.
        Object.defineProperty(m.db, "select", { configurable: true, value: (f?: Record<string, unknown>) => (f && "value" in f ? { from: async () => [{ value: 0 }] } : realSelect(f as never)) });
        try {
            const res = await m.bootstrap.POST(new NextRequest("http://localhost/api/admin/bootstrap", {
                method: "POST", headers: { "content-type": "application/json", "x-admin-setup-token": "token-uji-s71" },
                body: JSON.stringify({ name: "Boot", email, password: PW, role: "viewer" }),
            }));
            assert.equal(res.status, 200, await res.clone().text());
            assert.equal((await m.pool.query(`SELECT count(*)::int AS n FROM "user" WHERE email = $1 AND "emailVerified"`, [email])).rows[0].n, 1);
        } finally {
            if (savedSel) Object.defineProperty(m.db, "select", savedSel); else delete (m.db as unknown as Record<string, unknown>).select;
            if (token === undefined) delete process.env.ADMIN_SETUP_TOKEN; else process.env.ADMIN_SETUP_TOKEN = token;
        }
    });
});

test("lupa sandi: reset lewat tautan (token Better Auth) mencabut SEMUA sesi lama user itu (revokeSessionsOnPasswordReset)", { skip: pgSkip }, async () => {
    await dunia(async (w) => {
        const ga = await w.grup("kelola", ["users.manage"]);
        const gv = await w.grup("lihat", ["dashboard.view"]);
        const a = await w.user("a");
        await w.masuk(a, ga);
        const email = `${w.p}-reset@s71.test`;
        const uid = ((await (await buat(a, { name: "Reset", email, password: PW, groupIds: [gv] })).json()) as { user: { id: string } }).user.id;
        await masukDengan(email, PW); await masukDengan(email, PW);
        const sesi = async () => (await m.pool.query(`SELECT count(*)::int AS n FROM session WHERE "userId" = $1`, [uid])).rows[0].n as number;
        assert.equal(await sesi(), 2);
        // Token = yang dibuat /request-password-reset (tanpa kirim surel): identifier "reset-password:<token>", value = userId.
        const ctx = await m.auth.$context;
        const token = `${w.p}-tok`;
        await ctx.internalAdapter.createVerificationValue({ identifier: `reset-password:${token}`, value: uid, expiresAt: new Date(Date.now() + 3_600_000) });
        await m.auth.api.resetPassword({ body: { newPassword: PW2, token } });
        assert.equal(await sesi(), 0, "sesi lama wajib dicabut sesudah reset sandi");
        assert.ok((await masukDengan(email, PW2)).token);
    });
});

// ---------------- BL-63: bintang grup utama + user.role (owner 11 Okt; peninjau S7-0 #1-#3) ----------------

const role = async (id: string) => (await m.pool.query(`SELECT role FROM "user" WHERE id = $1`, [id])).rows[0].role as string;
const bintangDb = async (id: string) => (await m.pool.query(`SELECT group_id FROM user_group WHERE user_id = $1 AND is_primary`, [id])).rows.map((r) => r.group_id as string);

/** Grup preset bernama asli (unik global): dibuat per uji, dihapus oleh bersihkan(awalan). */
async function preset(w: ReturnType<typeof alat>, nama: string, keys: string[] = ["dashboard.view"]) {
    return w.grup(nama.toLowerCase().replace(/\s+/g, "-"), keys, { preset: true, nama });
}

test("BL-63 bintang: preset -> role turun; tukar bintang dua langkah dua arah (indeks unik tidak 23505); custom tidak mengubah role kecuali role turunan utama lama -> viewer; 404 bukan anggota", { skip: pgSkip }, async () => {
    await dunia(async (w) => {
        const ga = await w.grup("kelola", ["users.manage"]);
        const a = await w.user("a");
        await w.masuk(a, ga);
        const mgr = await preset(w, "Manager"), fin = await preset(w, "Finance"), cus = await w.grup("promo", ["dashboard.view"]);
        const u = await w.user("u", { role: "staff" });
        await w.masuk(u, mgr); await w.masuk(u, fin); await w.masuk(u, cus);
        const put = (gid: string) => panggil(m.bintang.PUT, a, "PUT", u, { groupId: gid });

        assert.deepEqual(await (await put(mgr)).json(), { ok: true, primaryGroupId: mgr, role: "manager", roleChanged: true });
        assert.deepEqual(await bintangDb(u), [mgr]);
        for (const [gid, r] of [[fin, "finance"], [mgr, "manager"], [fin, "finance"]]) {
            const res = await put(gid);
            assert.equal(res.status, 200, await res.clone().text());
            assert.deepEqual(await bintangDb(u), [gid], "tepat satu bintang");
            assert.equal(await role(u), r);
        }
        // Ke grup custom: role "finance" adalah turunan utama lama (Finance) -> viewer, bukan tertinggal.
        assert.deepEqual(await (await put(cus)).json(), { ok: true, primaryGroupId: cus, role: "viewer", roleChanged: true });
        // Lepas bintang (3 grup) -> tanpa utama; role tetap (bukan turunan).
        assert.deepEqual(await (await panggil(m.bintang.DELETE, a, "DELETE", u)).json(), { ok: true, primaryGroupId: null, role: "viewer", roleChanged: false });
        assert.deepEqual(await bintangDb(u), []);
        assert.deepEqual(await kode(await put(ga)), { status: 404, code: "BUKAN_ANGGOTA" });
        assert.deepEqual(await kode(await panggil(m.bintang.PUT, a, "PUT", u, {})), { status: 400, code: "INPUT_TIDAK_VALID" });
        const aksi = (await w.audit()).filter((r) => r.target_user_id === u).map((r) => r.action);
        assert.deepEqual(aksi, ["user_group.star", "user_group.star", "user_group.star", "user_group.star", "user_group.star", "user_group.unstar"]);
        const pertama = (await w.audit()).find((r) => r.target_user_id === u)!.detail as Record<string, unknown>;
        assert.deepEqual({ ...pertama, userName: undefined }, { userName: undefined, primaryBefore: null, primaryAfter: mgr, roleBefore: "staff", roleAfter: "manager" });
    });
});

test("BL-63 1 grup = otomatis utama (dibaca tanpa backfill; dijaga saat tulis): getPrimaryGroup, keluarkan dari grup berbintang -> bintang hilang -> sisa 1 grup utama + role", { skip: pgSkip }, async () => {
    await dunia(async (w) => {
        const ga = await w.grup("kelola", ["users.manage"]);
        const a = await w.user("a");
        await w.masuk(a, ga);
        const adm = await preset(w, "Admin", ["users.manage", "dashboard.view"]), mgr = await preset(w, "Manager");
        const { getPrimaryGroup } = await import("./rbac/resolve.ts");

        // Data pra-backfill: 1 grup TANPA bintang -> tetap utama saat dibaca.
        const u = await w.user("u", { role: "manager" });
        await w.masuk(u, mgr);
        assert.deepEqual(await bintangDb(u), []);
        assert.equal((await getPrimaryGroup(u))?.id, mgr);
        // Tambah grup kedua: grup tunggal lama DIBINTANGI dulu (aturan owner) -> utama tetap, role tidak berubah.
        const r = await panggil(m.anggota.POST, a, "POST", adm, { userId: u });
        assert.deepEqual(await r.json(), { ok: true, added: true, primaryGroupId: mgr, role: "manager" });
        assert.deepEqual(await bintangDb(u), [mgr]);

        // Admin berbintang + Manager; keluarkan dari Admin -> bintang hilang -> Manager satu-satunya -> utama + role manager.
        const v = await w.user("v", { role: "staff" });
        await w.masuk(v, adm, true); await w.masuk(v, mgr);
        await m.pool.query(`UPDATE "user" SET role = 'admin' WHERE id = $1`, [v]);
        assert.equal((await getPrimaryGroup(v))?.id, adm);
        const d = await panggil(m.anggota.DELETE, a, "DELETE", adm, { userId: v });
        assert.deepEqual(await d.json(), { ok: true, primaryGroupId: mgr, role: "manager" });
        assert.deepEqual(await bintangDb(v), [mgr], "aturan 1 grup tertulis");
        const det = (await w.audit()).find((x) => x.action === "user_group.remove" && x.target_user_id === v)!.detail as Record<string, unknown>;
        assert.deepEqual([det.primaryBefore, det.primaryAfter, det.roleBefore, det.roleAfter], [adm, mgr, "admin", "manager"]);

        // >1 grup tanpa bintang -> tidak ada utama.
        const x = await w.user("x");
        await w.masuk(x, mgr); await w.masuk(x, ga);
        assert.equal(await getPrimaryGroup(x), null);
    });
});

test("BL-63 hapus grup custom: SEMUA anggota dihitung ulang (utama + role) dalam transaksi yang sama, audit per anggota", { skip: pgSkip }, async () => {
    await dunia(async (w) => {
        const ga = await w.grup("kelola", ["users.manage"]);
        const a = await w.user("a");
        await w.masuk(a, ga);
        const fin = await preset(w, "Finance"), cus = await w.grup("promo", ["dashboard.view"]);
        const u = await w.user("u", { role: "staff" }), v = await w.user("v", { role: "staff" });
        await w.masuk(u, cus, true); await w.masuk(u, fin);
        await w.masuk(v, cus); await w.masuk(v, fin, true);
        assert.equal((await panggil(m.grupId.DELETE, a, "DELETE", cus)).status, 200);
        assert.deepEqual([await bintangDb(u), await role(u)], [[fin], "finance"], "utama pindah ke grup tunggal Finance -> role finance");
        assert.deepEqual([await bintangDb(v), await role(v)], [[fin], "staff"], "utama tidak berubah -> role tidak disentuh");
        const per = (await w.audit()).filter((x) => x.action === "user_group.remove").map((x) => [x.target_user_id, (x.detail as { via: string }).via]);
        assert.deepEqual(per.sort(), [[u, "group.delete"], [v, "group.delete"]].sort());
    });
});

test("BL-63 route lama users/[id]/group DIPENSIUNKAN: tambah + bintang (grup lain tetap), role preset turun; aktor admin tidak terkunci", { skip: pgSkip }, async () => {
    await dunia(async (w) => {
        const adm = await w.grup("kelola", ["users.manage"]);
        const gv = await w.grup("lihat", ["dashboard.view"]);
        const mgr = await preset(w, "Manager");
        const a = await w.user("a");
        await w.masuk(a, adm);
        // Dulu (celah 1): "ganti semua" mengeluarkan aktor dari grup kelola. Kini grup lain tetap -> 200, aktor tetap admin.
        assert.deepEqual(await (await panggil(m.userGrup.POST, a, "POST", a, { groupId: gv })).json(), { ok: true, role: "viewer", primaryGroupId: gv });
        assert.deepEqual(await w.grupUser(a), [adm, gv].sort());
        assert.deepEqual(await w.admin(), [a]);
        const u = await w.user("u");
        await w.masuk(u, gv);
        assert.deepEqual(await (await panggil(m.userGrup.POST, a, "POST", u, { groupId: mgr })).json(), { ok: true, role: "manager", primaryGroupId: mgr });
        assert.deepEqual(await w.grupUser(u), [gv, mgr].sort());
        assert.deepEqual(await bintangDb(u), [mgr]);
    });
});

test("BL-63 buat user: grup utama preset menurunkan role; >1 grup tanpa primaryGroupId = tanpa bintang (role bawaan)", { skip: pgSkip }, async () => {
    await dunia(async (w) => {
        const ga = await w.grup("kelola", ["users.manage"]);
        const a = await w.user("a");
        await w.masuk(a, ga);
        const fin = await preset(w, "Finance"), cus = await w.grup("promo", ["dashboard.view"]);
        const r1 = (await (await buat(a, { name: "Fin", email: `${w.p}-fin@s71.test`, password: PW, groupIds: [cus, fin], primaryGroupId: fin })).json()) as { user: { role: string; primaryGroupId: string } };
        assert.deepEqual([r1.user.role, r1.user.primaryGroupId], ["finance", fin]);
        const r2 = (await (await buat(a, { name: "Dua", email: `${w.p}-dua@s71.test`, password: PW, groupIds: [cus, fin] })).json()) as { user: { id: string; role: string; primaryGroupId: string | null } };
        assert.deepEqual([r2.user.role, r2.user.primaryGroupId], ["viewer", null]);
        assert.deepEqual(await bintangDb(r2.user.id), []);
    });
});

test("BL-63 daftar user: semua grup + utama efektif + field lama (groupId) untuk Beranda; users.view cukup", { skip: pgSkip }, async () => {
    await dunia(async (w) => {
        const gview = await w.grup("baca", ["users.view"]);
        const viewer = await w.user("pembaca");
        await w.masuk(viewer, gview);
        const mgr = await preset(w, "Manager"), cus = await w.grup("promo", ["dashboard.view"]);
        const u = await w.user("u");
        await w.masuk(u, cus); await w.masuk(u, mgr, true);
        const v = await w.user("v");
        await w.masuk(v, cus); await w.masuk(v, mgr);
        const res = await m.daftar.GET(new NextRequest("http://localhost/api/admin/users/permissions", { headers: { host: "app.test", "x-uji-aktor": viewer } }));
        assert.equal(res.status, 200);
        const users = ((await res.json()) as { users: Array<Record<string, unknown>> }).users;
        const cari = (id: string) => users.find((x) => x.id === id)!;
        const urut = (gs: unknown) => [...(gs as Array<{ id: string }>)].sort((x, y) => x.id.localeCompare(y.id));
        assert.deepEqual(urut(cari(u).groups), urut([{ id: mgr, name: "Manager", isPreset: true, isPrimary: true }, { id: cus, name: `${w.p} promo`, isPreset: false, isPrimary: false }]));
        assert.deepEqual([cari(u).primaryGroupId, cari(u).groupId], [mgr, mgr]);
        const gv = cari(v).groups as Array<{ id: string }>;
        assert.deepEqual([cari(v).primaryGroupId, cari(v).groupId], [null, gv[0].id], "tanpa bintang: groupId lama = grup pertama (urut nama)");
        assert.equal(gv.length, 2);
    });
});
