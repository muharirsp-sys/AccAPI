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
    return { db, pool, auth, adminAktif, grup, grupId, anggota, userGrup };
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
    const q = (s: string) => m.pool.query(s, [`${awalan}%`]);
    await q(`DELETE FROM session WHERE "userId" LIKE $1`);
    await q(`DELETE FROM account WHERE "userId" LIKE $1`);
    await q(`DELETE FROM user_group WHERE user_id LIKE $1 OR group_id LIKE $1`);
    await q(`DELETE FROM group_permission WHERE group_id LIKE $1`);
    await q(`DELETE FROM access_group WHERE id LIKE $1`);
    await q(`DELETE FROM permission_audit_log WHERE actor_user_id LIKE $1 OR target_user_id LIKE $1 OR target_group_id LIKE $1`);
    await q(`DELETE FROM "user" WHERE id LIKE $1`);
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
            WHERE actor_user_id LIKE $1 OR target_user_id LIKE $1 OR target_group_id LIKE $1 ORDER BY created_at, id`, [`${p}%`])).rows,
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

test("celah 1 (route lama users/[id]/group): ganti grup sendiri ke grup tanpa users.manage -> AKSES_SENDIRI, semua tulisan batal", { skip: pgSkip }, async () => {
    await dunia(async (w) => {
        const adm = await w.grup("kelola", ["users.manage"]);
        const gv = await w.grup("lihat", ["dashboard.view"]);
        const a = await w.user("a");
        await w.masuk(a, adm);
        assert.deepEqual(await kode(await panggil(m.userGrup.POST, a, "POST", a, { groupId: gv })), { status: 409, code: "AKSES_SENDIRI" });
        assert.deepEqual(await w.grupUser(a), [adm]);
        assert.deepEqual(await w.audit(), []);
    });
});

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
