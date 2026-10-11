/*
 * Tujuan: SATU penjaga BL-61 + transaksi bersama untuk SEMUA tulisan otorisasi (user, grup, anggota, izin) — S7-1.
 *   Admin = user AKTIF (tidak banned / ban kedaluwarsa) yang memegang `users.manage` EFEKTIF (sama dengan getUserPermissions:
 *   ≥1 grup -> gabungan kunci grup; tanpa grup -> preset role lama). Penjaga dihitung DI DALAM transaksi sesudah perubahan,
 *   di bawah satu advisory lock, sehingga dua admin yang saling mencabut bersamaan tidak bisa sama-sama lolos.
 *   BL-63: grup utama efektif (bintang / satu-satunya grup) + penurunan user.role dari grup preset, di transaksi yang sama.
 * Caller: app/api/admin/** (groups, groups/[id], groups/[id]/members, users/**), lib/rbac/resolve.ts (getPrimaryGroup).
 * Dependensi: db (Drizzle node-postgres), lib/rbac (preset legacy), schema user_group.
 * Side Effects: transaksi DB + pg_advisory_xact_lock; tidak ada I/O lain.
 * Kontrak: docs/handover/S7-KONTRAK-ADMIN-API.md §2-§3.
 */
import { NextResponse } from "next/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accessGroup, session, user, userGroup } from "@/db/schema";
import { defaultRole, permissionMapForUser } from "@/lib/rbac";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Galat berkode untuk jawaban `{ ok:false, code, error }`. Dilempar di dalam transaksi -> rollback. */
export class GalatOtorisasi extends Error {
    constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
        super(message);
    }
}

export const galat = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
    NextResponse.json({ ok: false, code, error: message, ...extra }, { status });

const UNIK: Record<string, [string, string]> = {
    uq_user_group_primary: ["BINTANG_BENTROK", "Grup utama sedang diubah bersamaan. Ulangi."],
    access_group_name_unique: ["NAMA_GRUP_TERPAKAI", "Nama grup sudah dipakai."],
    user_email_unique: ["EMAIL_TERPAKAI", "Email sudah terdaftar."],
};

/** Galat -> jawaban. 23505 yang dikenal -> 409 berkode; selain itu 500 GAGAL_SIMPAN. Log hanya kode/constraint (pesan
 * DrizzleQueryError memuat parameter kueri — jangan dicetak). */
export function jawabGalat(e: unknown): NextResponse {
    if (e instanceof GalatOtorisasi) return galat(e.status, e.code, e.message, e.extra);
    for (const x of [e, (e as { cause?: unknown } | null)?.cause]) {
        const pg = x as { code?: string; constraint?: string } | null;
        if (pg?.code === "23505" && pg.constraint && UNIK[pg.constraint]) {
            const [code, message] = UNIK[pg.constraint];
            return galat(409, code, message);
        }
    }
    const pg = ((e as { cause?: unknown } | null)?.cause ?? e) as { code?: string; constraint?: string } | null;
    console.error("[admin-otorisasi] gagal simpan:", pg?.code ?? "", pg?.constraint ?? "");
    return galat(500, "GAGAL_SIMPAN", "Gagal menyimpan; tidak ada yang berubah.");
}

type BarisAdmin = { id: string; role: string | null; permissions: string | null; punya_grup: boolean; grup_kelola: boolean };

/** Murni: id admin dari baris user aktif. Punya grup -> hanya kunci grup; tanpa grup -> preset role lama (resolve.ts). */
export function adminDariBaris(rows: readonly BarisAdmin[]): Set<string> {
    return new Set(rows.filter((r) => (r.punya_grup ? r.grup_kelola : Boolean(permissionMapForUser(r.role, r.permissions).users?.includes("manage")))).map((r) => r.id));
}

/** Admin aktif saat ini, dibaca dalam transaksi `tx`. */
export async function adminAktif(tx: Tx): Promise<Set<string>> {
    const res = await tx.execute(sql`
        SELECT u.id, u.role, u.permissions,
               EXISTS (SELECT 1 FROM user_group ug WHERE ug.user_id = u.id) AS punya_grup,
               EXISTS (SELECT 1 FROM user_group ug JOIN group_permission gp ON gp.group_id = ug.group_id
                       WHERE ug.user_id = u.id AND gp.permission_key = 'users.manage') AS grup_kelola
        FROM "user" u
        WHERE NOT (COALESCE(u.banned, false) AND (u."banExpires" IS NULL OR u."banExpires" > now()))`);
    return adminDariBaris(res.rows as BarisAdmin[]);
}

/** Murni: putusan penjaga dari himpunan admin sebelum/sesudah perubahan. */
export function evaluasiPenjaga(sebelum: ReadonlySet<string>, sesudah: ReadonlySet<string>, aktorId: string | null): GalatOtorisasi | null {
    if (aktorId && sebelum.has(aktorId) && !sesudah.has(aktorId)) {
        return new GalatOtorisasi(409, "AKSES_SENDIRI", "Anda tidak bisa mencabut akses kelola user milik Anda sendiri.");
    }
    if (sebelum.size > 0 && sesudah.size === 0) {
        return new GalatOtorisasi(409, "ADMIN_TERAKHIR", "Ditolak: tidak akan tersisa user aktif yang bisa mengelola user (users.manage).");
    }
    return null;
}

// ponytail: SATU kunci global untuk semua tulisan otorisasi (operasi admin jarang, ms). Batas: semua tulisan user/grup
// berurutan; upgrade bila perlu = isolasi SERIALIZABLE + ulang otomatis.
const KUNCI = sql`SELECT pg_advisory_xact_lock(hashtext('accapi:otorisasi'))`;

/**
 * Transaksi tulisan otorisasi: kunci global -> admin sebelum -> `fn` -> admin sesudah -> penjaga BL-61.
 * Aktor yang sudah bukan admin saat kunci didapat (dicabut admin lain sesaat sebelumnya) -> 403 IZIN_BERUBAH.
 * Aktor bypass lokal (bukan baris user) dilewati pemeriksaan aktor.
 */
export async function transaksiOtorisasi<T>(aktorId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
        await tx.execute(KUNCI);
        const sebelum = await adminAktif(tx);
        if (aktorId && !sebelum.has(aktorId)) {
            const [ada] = await tx.select({ id: user.id }).from(user).where(eq(user.id, aktorId)).limit(1);
            if (ada) throw new GalatOtorisasi(403, "IZIN_BERUBAH", "Izin Anda berubah sejak permintaan dibuat. Muat ulang halaman.");
        }
        const hasil = await fn(tx);
        const putusan = evaluasiPenjaga(sebelum, await adminAktif(tx), aktorId);
        if (putusan) throw putusan;
        return hasil;
    });
}

/** User yang hanya punya grup `groupId` (keluar/hapus grup itu = user tanpa grup -> fallback role lama). */
export async function anggotaTunggal(tx: Tx, groupId: string, userIds?: readonly string[]): Promise<Array<{ id: string; name: string }>> {
    const res = await tx.execute(sql`
        SELECT u.id, u.name FROM user_group ug JOIN "user" u ON u.id = ug.user_id
        WHERE ug.group_id = ${groupId}
          AND NOT EXISTS (SELECT 1 FROM user_group o WHERE o.user_id = ug.user_id AND o.group_id <> ${groupId})
        ORDER BY u.name`);
    const rows = res.rows as Array<{ id: string; name: string }>;
    return userIds ? rows.filter((r) => userIds.includes(r.id)) : rows;
}

export function tolakGrupTerakhir(users: Array<{ id: string; name: string }>) {
    if (users.length) {
        throw new GalatOtorisasi(409, "GRUP_TERAKHIR", "Ditolak: user tidak boleh tanpa grup (akan jatuh ke akses role lama). Nonaktifkan user untuk mencabut akses.", { users });
    }
}

/** Keanggotaan ada? (dibaca dalam transaksi). */
export async function anggota(tx: Tx, userId: string, groupId: string): Promise<boolean> {
    const [r] = await tx.select({ u: userGroup.userId }).from(userGroup).where(and(eq(userGroup.userId, userId), eq(userGroup.groupId, groupId))).limit(1);
    return Boolean(r);
}

/** Batas sandi = konfigurasi Better Auth server (min 6, maks 128). Pesan TIDAK pernah memuat sandinya. */
export function periksaSandi(password: unknown, min: number, max: number): GalatOtorisasi | null {
    if (typeof password !== "string" || password.length < min) return new GalatOtorisasi(400, "SANDI_TERLALU_PENDEK", `Sandi minimal ${min} karakter.`);
    if (password.length > max) return new GalatOtorisasi(400, "SANDI_TERLALU_PANJANG", `Sandi maksimal ${max} karakter.`);
    return null;
}

/** Cabut SEMUA sesi user (tabel session Better Auth; tanpa cookie cache/secondary storage -> berlaku seketika). */
export async function cabutSesi(tx: Tx, userId: string): Promise<number> {
    return (await tx.delete(session).where(eq(session.userId, userId)).returning({ id: session.id })).length;
}

/** Baris user target dibaca dalam transaksi; tidak ada -> 404 berkode. */
export async function userTarget(tx: Tx, userId: string) {
    const [u] = await tx.select({ id: user.id, name: user.name, email: user.email, role: user.role, banned: user.banned, banExpires: user.banExpires })
        .from(user).where(eq(user.id, userId)).limit(1);
    if (!u) throw new GalatOtorisasi(404, "USER_TIDAK_ADA", "User tidak ditemukan");
    return u;
}

// ---------------- BL-63: grup utama (bintang) + penurunan user.role (owner 11 Okt; kontrak §4) ----------------

/** Nama grup PRESET -> role identitas lama (dipindah dari users/[id]/group; cermin ROLE_TO_GROUP seed-rbac-presets.ts). */
export const GROUP_NAME_TO_ROLE: Readonly<Record<string, string>> = {
    Admin: "admin", Manager: "manager", Finance: "finance", Staff: "staff", Viewer: "viewer",
    SPV: "spv", SM: "sm", Claim: "claim", OM: "om", Salesman: "salesman", "Admin Sales": "admin_sales",
};

export type GrupUser = { groupId: string; name: string; isPreset: boolean; isPrimary: boolean };

/** Murni: grup utama EFEKTIF = berbintang; tanpa bintang & tepat 1 grup -> grup itu; selain itu null. */
export function pilihUtama<T extends { isPrimary: boolean }>(rows: readonly T[]): T | null {
    return rows.find((r) => r.isPrimary) ?? (rows.length === 1 ? rows[0] : null);
}

/** Murni: role dari grup (hanya grup PRESET bernama di peta; custom / preset tanpa peta -> null). */
export function roleDariGrup(g: Pick<GrupUser, "name" | "isPreset"> | null): string | null {
    return g?.isPreset ? GROUP_NAME_TO_ROLE[g.name] ?? null : null;
}

/**
 * Murni: role baru bila grup utama efektif BERUBAH (null = role tidak diubah).
 * Utama baru preset berpeta -> petanya. Selain itu role tetap, KECUALI role sekarang turunan utama lama -> bawaan `viewer`
 * (agar `admin` tidak tertinggal sesudah keluar dari grup Admin; peninjau S7-0 #2). Utama tidak berubah -> null.
 */
export function roleTurunan(lama: GrupUser | null, baru: GrupUser | null, roleSekarang: string | null): string | null {
    if ((lama?.groupId ?? null) === (baru?.groupId ?? null)) return null;
    const rb = roleDariGrup(baru);
    if (rb) return rb === roleSekarang ? null : rb;
    const rl = roleDariGrup(lama);
    if (rl && rl === roleSekarang && roleSekarang !== defaultRole) return defaultRole;
    return null;
}

async function grupUser(tx: Tx, userId: string): Promise<GrupUser[]> {
    return tx.select({ groupId: userGroup.groupId, name: accessGroup.name, isPreset: accessGroup.isPreset, isPrimary: userGroup.isPrimary })
        .from(userGroup).innerJoin(accessGroup, eq(accessGroup.id, userGroup.groupId))
        .where(eq(userGroup.userId, userId)).orderBy(asc(accessGroup.name));
}

/** User tepat 1 grup tanpa bintang -> bintangi (aturan owner "1 grup = otomatis utama", sama dengan backfill DDL_S7_0). */
async function sematkanTunggal(tx: Tx, userId: string, rows: GrupUser[]) {
    if (rows.length === 1 && !rows[0].isPrimary) {
        await tx.update(userGroup).set({ isPrimary: true }).where(and(eq(userGroup.userId, userId), eq(userGroup.groupId, rows[0].groupId)));
        rows[0].isPrimary = true;
    }
}

/** Panggil SEBELUM mengubah keanggotaan/bintang user: menormalkan data lalu mengembalikan utama efektif lama. */
export async function mulaiUtama(tx: Tx, userId: string): Promise<GrupUser | null> {
    const rows = await grupUser(tx, userId);
    await sematkanTunggal(tx, userId, rows);
    return pilihUtama(rows);
}

export type HasilUtama = { primaryGroupId: string | null; primaryGroupName: string | null; roleBefore: string | null; roleAfter: string | null; roleChanged: boolean };

/** Panggil SESUDAH perubahan (transaksi sama): normalkan 1 grup, hitung utama baru, turunkan role bila utama berubah. */
export async function selesaiUtama(tx: Tx, userId: string, lama: GrupUser | null): Promise<HasilUtama> {
    const rows = await grupUser(tx, userId);
    await sematkanTunggal(tx, userId, rows);
    const baru = pilihUtama(rows);
    const [u] = await tx.select({ role: user.role }).from(user).where(eq(user.id, userId));
    const roleBefore = u?.role ?? null;
    const r = roleTurunan(lama, baru, roleBefore);
    if (r) await tx.update(user).set({ role: r, updatedAt: new Date() }).where(eq(user.id, userId));
    return { primaryGroupId: baru?.groupId ?? null, primaryGroupName: baru?.name ?? null, roleBefore, roleAfter: r ?? roleBefore, roleChanged: Boolean(r) };
}

/** Bintang = DUA langkah (lepas semua, lalu pasang): satu UPDATE `is_primary = (group_id = $g)` bisa 23505 tergantung urutan
 * fisik baris (peninjau S7-0 #1). groupId null = lepas saja. */
export async function pasangBintang(tx: Tx, userId: string, groupId: string | null) {
    await tx.update(userGroup).set({ isPrimary: false }).where(and(eq(userGroup.userId, userId), eq(userGroup.isPrimary, true)));
    if (groupId) await tx.update(userGroup).set({ isPrimary: true }).where(and(eq(userGroup.userId, userId), eq(userGroup.groupId, groupId)));
}

/** Detail audit grup utama/role (hanya bila berubah). */
export function detailUtama(lama: GrupUser | null, h: HasilUtama) {
    return {
        ...((lama?.groupId ?? null) !== h.primaryGroupId ? { primaryBefore: lama?.groupId ?? null, primaryAfter: h.primaryGroupId } : {}),
        ...(h.roleChanged ? { roleBefore: h.roleBefore, roleAfter: h.roleAfter } : {}),
    };
}
