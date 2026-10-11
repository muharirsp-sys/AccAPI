/*
 * Tujuan: BL-62 buat user internal (menggantikan plugin `/api/auth/admin/create-user` dari browser) — S7-1.
 * Caller: UI admin user (`app/(dashboard)/admin/users`).
 * Dependensi: Better Auth `auth.api.createUser` (server-side, tanpa sesi), lib/rbac/otorisasi (transaksi + penjaga).
 * Main Functions: POST.
 * Side Effects: tulis user + akun credential (Better Auth), user_group + audit `user.create` (transaksi app).
 * Urutan aman (Better Auth di luar transaksi app): validasi -> createUser BANNED "sedang disiapkan" -> transaksi app (grup,
 *   bintang, buka ban, audit) -> gagal (juga Better Auth gagal di tengah): kompensasi hapus user; kompensasi gagal pun user
 *   tetap banned (tidak bisa masuk) dan jawaban jujur 500 USER_SETENGAH_JADI + userId.
 * Kontrak: docs/handover/S7-KONTRAK-ADMIN-API.md §5.2.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { defaultRole } from "@/lib/rbac";
import { account, accessGroup, permissionAuditLog, session, user, userGroup } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";
import { galat, GalatOtorisasi, jawabGalat, periksaSandi, selesaiUtama, transaksiOtorisasi } from "@/lib/rbac/otorisasi";

const DISIAPKAN = "sedang disiapkan (S7-1)";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Kompensasi: hapus user setengah jadi — HANYA bila masih dalam keadaan "sedang disiapkan". true = bersih (atau tidak ada). */
async function hapusSetengahJadi(id: string): Promise<boolean> {
    try {
        await db.transaction(async (tx) => {
            const [u] = await tx.select({ id: user.id }).from(user).where(and(eq(user.id, id), eq(user.banReason, DISIAPKAN))).for("update");
            if (!u) return;
            await tx.delete(session).where(eq(session.userId, id));
            await tx.delete(account).where(eq(account.userId, id));
            await tx.delete(userGroup).where(eq(userGroup.userId, id));
            await tx.delete(user).where(eq(user.id, id));
        });
        return true;
    } catch (e) {
        console.error("[admin-users] kompensasi gagal; user tetap banned 'sedang disiapkan':", id, (e as { cause?: { code?: string } })?.cause?.code ?? "");
        return false;
    }
}

/** Kompensasi gagal = jawaban JUJUR (bukan "tidak ada yang berubah"): user ada tetapi nonaktif dan tidak bisa masuk. */
const setengahJadi = (id: string) => galat(500, "USER_SETENGAH_JADI",
    "User terbuat sebagian dan dibiarkan NONAKTIF (\"sedang disiapkan\", tidak bisa masuk). Minta IT Support menghapusnya, lalu ulangi.", { userId: id });

export async function POST(request: NextRequest) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;
    const actor = gate.session!.user;

    const body = await request.json().catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const groupIds = Array.isArray(body?.groupIds) ? [...new Set((body.groupIds as unknown[]).filter((g): g is string => typeof g === "string" && g.trim() !== "").map((g) => g.trim()))] : [];
    const primaryGroupId = typeof body?.primaryGroupId === "string" && body.primaryGroupId.trim() ? body.primaryGroupId.trim() : null;

    if (!name || name.length > 100) return galat(400, "INPUT_TIDAK_VALID", "Nama wajib diisi (maks. 100 karakter).");
    if (!EMAIL.test(email) || email.length > 254) return galat(400, "EMAIL_TIDAK_VALID", "Format email tidak valid.");
    const ctx = await auth.$context;
    const sandiSalah = periksaSandi(body?.password, ctx.password.config.minPasswordLength, ctx.password.config.maxPasswordLength);
    if (sandiSalah) return galat(sandiSalah.status, sandiSalah.code, sandiSalah.message);
    const password = body.password as string;
    if (groupIds.length === 0 || groupIds.length > 20) return galat(400, "INPUT_TIDAK_VALID", "Pilih 1–20 grup akses (groupIds).");
    if (primaryGroupId && !groupIds.includes(primaryGroupId)) return galat(400, "INPUT_TIDAK_VALID", "primaryGroupId harus salah satu dari groupIds.");

    // Cek awal grup (tanpa membuat apa pun); dicek ulang di dalam transaksi.
    const ada = new Set((await db.select({ id: accessGroup.id }).from(accessGroup).where(inArray(accessGroup.id, groupIds))).map((g) => g.id));
    const hilang = groupIds.filter((g) => !ada.has(g));
    if (hilang.length) return galat(404, "GRUP_TIDAK_ADA", "Grup tidak ditemukan.", { missing: hilang });

    let id: string;
    try {
        // Tanpa headers = panggilan server (tanpa sesi Better Auth): gerbang users.manage di atas yang berlaku.
        const created = await auth.api.createUser({
            body: { name, email, password, role: defaultRole, data: { emailVerified: true, banned: true, banReason: DISIAPKAN } },
        });
        id = created.user.id;
    } catch (e) {
        const code = (e as { body?: { code?: string } })?.body?.code ?? "";
        if (code.startsWith("USER_ALREADY_EXISTS")) return galat(409, "EMAIL_TERPAKAI", "Email sudah terdaftar.");
        if (code === "INVALID_EMAIL") return galat(400, "EMAIL_TIDAK_VALID", "Format email tidak valid.");
        // Better Auth bisa gagal DI TENGAH (user tersimpan, akun/sandi gagal): cari user setengah jadi lewat email + penanda.
        const [sisa] = await db.select({ id: user.id }).from(user).where(and(eq(user.email, email), eq(user.banReason, DISIAPKAN))).limit(1).catch(() => [undefined]);
        console.error("[admin-users] createUser gagal:", code, sisa ? `user setengah jadi ${sisa.id}` : "");
        if (sisa && !(await hapusSetengahJadi(sisa.id))) return setengahJadi(sisa.id);
        return galat(500, "GAGAL_SIMPAN", "Gagal membuat user; tidak ada yang berubah.");
    }

    const now = new Date();
    try {
        const utama = primaryGroupId ?? (groupIds.length === 1 ? groupIds[0] : null);
        const hasil = await transaksiOtorisasi(actor.id, async (tx) => {
            const grup = await tx.select({ id: accessGroup.id, name: accessGroup.name }).from(accessGroup).where(inArray(accessGroup.id, groupIds));
            if (grup.length !== groupIds.length) throw new GalatOtorisasi(404, "GRUP_TIDAK_ADA", "Grup tidak ditemukan.");
            await tx.insert(userGroup).values(groupIds.map((groupId) => ({ userId: id, groupId, assignedBy: actor.id, assignedAt: now, isPrimary: groupId === utama })));
            await tx.update(user).set({ banned: false, banReason: null, banExpires: null, updatedAt: now }).where(eq(user.id, id));
            // BL-63: grup utama preset -> user.role (Better Auth hanya menerima role AppRole; peta grup diterapkan di sini).
            const h = await selesaiUtama(tx, id, null);
            await tx.insert(permissionAuditLog).values({
                id: randomUUID(), actorUserId: actor.id, actorName: actor.name, action: "user.create", targetUserId: id,
                targetGroupId: h.primaryGroupId, createdAt: now,
                detail: { name, email, groupIds, groupNames: groupIds.map((g) => grup.find((x) => x.id === g)?.name), primaryGroupId: h.primaryGroupId, role: h.roleAfter },
            });
            return { role: h.roleAfter, primaryGroupId: h.primaryGroupId };
        });
        return NextResponse.json({ ok: true, user: { id, name, email, role: hasil.role, groupIds, primaryGroupId: hasil.primaryGroupId } }, { status: 201 });
    } catch (e) {
        if (!(await hapusSetengahJadi(id))) return setengahJadi(id);
        return jawabGalat(e);
    }
}
