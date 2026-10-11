/*
 * Tujuan: SATU penjaga BL-61 + transaksi bersama untuk SEMUA tulisan otorisasi (user, grup, anggota, izin) — S7-1.
 *   Admin = user AKTIF (tidak banned / ban kedaluwarsa) yang memegang `users.manage` EFEKTIF (sama dengan getUserPermissions:
 *   ≥1 grup -> gabungan kunci grup; tanpa grup -> preset role lama). Penjaga dihitung DI DALAM transaksi sesudah perubahan,
 *   di bawah satu advisory lock, sehingga dua admin yang saling mencabut bersamaan tidak bisa sama-sama lolos.
 * Caller: app/api/admin/** (groups, groups/[id], groups/[id]/members, users/**).
 * Dependensi: db (Drizzle node-postgres), lib/rbac (preset legacy), schema user_group.
 * Side Effects: transaksi DB + pg_advisory_xact_lock; tidak ada I/O lain.
 * Kontrak: docs/handover/S7-KONTRAK-ADMIN-API.md §2-§3.
 */
import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { user, userGroup } from "@/db/schema";
import { permissionMapForUser } from "@/lib/rbac";

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
