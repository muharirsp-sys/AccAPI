/*
 * Tujuan: Tautan akun salesman <-> karyawan salesman Accurate (O1, owner 12 Okt 2026: cabang salesman = `accurate_employee.branch_id`).
 * Caller: layar User admin (O2). Kontrak: docs/handover/O1-KONTRAK-ORDER-CABANG.md §Tautan salesman.
 * Dependensi: db sales_profile/accurate_employee/branch/user, lib/rbac/otorisasi (transaksi + kunci + galat berkode), permission_audit_log.
 * Main Functions: GET (tautan user + daftar karyawan salesman aktif), PUT {employeeNumber} (tetapkan), DELETE (lepas).
 * Side Effects: PUT/DELETE menulis sales_profile + permission_audit_log (`salesman.link` / `salesman.unlink`) dalam SATU transaksi
 *   di bawah kunci otorisasi global (dua admin tak bisa menautkan satu karyawan ke dua akun bersamaan).
 *
 * Penyimpan tautan = `sales_profile.sales_code` (kode salesman internal = nomor karyawan Accurate, dibuktikan 2026-09-12; dipakai juga
 * Form Kontrol sebagai identitas akun salesman) + `sales_profile.accurate_linked` (tautan aktif). Satu karyawan <-> satu akun:
 * sales_code UNIK (constraint lama, diperiksa DDL_O1 VERIFIKASI) + penolakan 409.
 * PUT pada akun yang sudah punya profil MENGGANTI sales_code/sales_name profil itu (spv/sm/principle tetap) dan menyalakan tautan;
 * nilai lama di audit. Kode BERGANTI sementara laporan Form Kontrol tercatat atas kode lama (laporan harian, AO, merchandising, JKS)
 * = 409 `KODE_DIPAKAI_FORM_KONTROL` (+hitungan) — riwayat itu akan terputus dari akunnya — kecuali `konfirmasiGantiKode: true`
 * (hitungan ikut di audit). Butir 12, O1 putaran 1.
 * DELETE MELEPAS tautan (`accurate_linked` = false): baris sales_profile, kode, dan hierarki Form Kontrol (lib/form-kontrol/db.ts:
 * ack SPV, cakupan SPV/SM, getScopeForUser) TETAP — dulu barisnya dihapus dan hierarki ikut hilang.
 * `accurate_branch_id` tidak diisi (lihat lib/order-cabang cakupanCabang).
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, asc, eq, ne, sql, type AnyColumn } from "drizzle-orm";
import { db } from "@/lib/db";
import { accurateEmployee, branch, permissionAuditLog, salesProfile, user } from "@/db/schema";
import { requirePermission, resolveRequestPermissions } from "@/lib/rbac/resolve";
import { galat, GalatOtorisasi, jawabGalat, transaksiOtorisasi, userTarget, type Tx } from "@/lib/rbac/otorisasi";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

const samaKode = (kolom: AnyColumn, kode: string) =>
    sql`upper(trim(${kolom})) = ${kode}`;

async function tautanUser(userId: string) {
    return db.select({
        salesCode: salesProfile.salesCode, salesName: salesProfile.salesName,
        employeeId: accurateEmployee.id, employeeName: accurateEmployee.name, branchId: accurateEmployee.branchId, branchName: branch.name,
        salesman: accurateEmployee.salesman, suspended: accurateEmployee.suspended, terhubung: salesProfile.accurateLinked,
    }).from(salesProfile)
        .leftJoin(accurateEmployee, sql`upper(trim(${accurateEmployee.number})) = upper(trim(${salesProfile.salesCode}))`)
        .leftJoin(branch, eq(branch.id, accurateEmployee.branchId))
        .where(eq(salesProfile.userId, userId));
}

/** Catatan Form Kontrol atas satu kode sales (pencocokan PERSIS, sama dengan lib/form-kontrol): yang akan terputus bila kodenya diganti. */
async function laporanFormKontrol(tx: Tx, salesCode: string) {
    const r = await tx.execute(sql`SELECT
        (SELECT count(*) FROM salesman_daily_report WHERE sales_code = ${salesCode})::int AS laporan_harian,
        (SELECT count(*) FROM ao_control_daily WHERE sales_code = ${salesCode})::int AS ao,
        (SELECT count(*) FROM merchandising_check WHERE sales_code = ${salesCode})::int AS merchandising,
        (SELECT count(*) FROM jks_master WHERE sales_code = ${salesCode})::int AS jks`);
    const b = (r.rows[0] ?? {}) as { laporan_harian?: number; ao?: number; merchandising?: number; jks?: number };
    const n = { laporanHarian: Number(b.laporan_harian ?? 0), ao: Number(b.ao ?? 0), merchandising: Number(b.merchandising ?? 0), jks: Number(b.jks ?? 0) };
    return { ...n, total: n.laporanHarian + n.ao + n.merchandising + n.jks };
}

export async function GET(request: NextRequest, context: Context) {
    const gate = await resolveRequestPermissions(request);
    if (gate.response) return gate.response;
    if (!gate.perms!.has("users.manage") && !gate.perms!.has("users.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const { id } = await context.params;
    const tautan = await tautanUser(id);
    const pilihan = await db.select({
        id: accurateEmployee.id, number: accurateEmployee.number, name: accurateEmployee.name,
        branchId: accurateEmployee.branchId, branchName: branch.name,
        terhubungUserId: salesProfile.userId, terhubungNama: user.name, terhubungEmail: user.email, terhubungAktif: salesProfile.accurateLinked,
    }).from(accurateEmployee)
        .leftJoin(branch, eq(branch.id, accurateEmployee.branchId))
        .leftJoin(salesProfile, sql`upper(trim(${salesProfile.salesCode})) = upper(trim(${accurateEmployee.number}))`)
        .leftJoin(user, eq(user.id, salesProfile.userId))
        .where(and(eq(accurateEmployee.salesman, true), eq(accurateEmployee.suspended, false), sql`trim(${accurateEmployee.number}) <> ''`))
        .orderBy(asc(branch.name), asc(accurateEmployee.name));
    return NextResponse.json({
        ok: true,
        tautan: tautan.map((t) => ({ ...t, aktif: t.terhubung === true && t.salesman === true && t.suspended === false && t.branchId !== null })),
        // `terhubungKe.terhubung` false = kode dipegang profil Form Kontrol akun lain yang tautannya dilepas (tetap menghalangi: kode unik).
        pilihan: pilihan.map(({ terhubungUserId, terhubungNama, terhubungEmail, terhubungAktif, ...e }) => ({
            ...e, terhubungKe: terhubungUserId ? { userId: terhubungUserId, name: terhubungNama, email: terhubungEmail, terhubung: terhubungAktif === true } : null,
        })),
    });
}

export async function PUT(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;
    const actor = gate.session!.user;
    const { id } = await context.params;
    const body = await request.json().catch(() => null) as { employeeNumber?: unknown; konfirmasiGantiKode?: unknown } | null;
    const kode = typeof body?.employeeNumber === "string" ? body.employeeNumber.trim().toUpperCase() : "";
    const konfirmasiGantiKode = body?.konfirmasiGantiKode === true;
    if (!kode) return galat(400, "INPUT_TIDAK_VALID", "employeeNumber (nomor karyawan Accurate) wajib diisi");
    const now = new Date();
    try {
        const h = await transaksiOtorisasi(actor.id, async (tx) => {
            const t = await userTarget(tx, id);
            const pegawai = await tx.select({ id: accurateEmployee.id, number: accurateEmployee.number, name: accurateEmployee.name,
                branchId: accurateEmployee.branchId, salesman: accurateEmployee.salesman, suspended: accurateEmployee.suspended })
                .from(accurateEmployee).where(samaKode(accurateEmployee.number, kode));
            if (pegawai.length === 0) throw new GalatOtorisasi(404, "KARYAWAN_TIDAK_ADA", `Karyawan Accurate ${kode} tidak ada di master hasil sync.`);
            if (pegawai.length > 1) throw new GalatOtorisasi(409, "KARYAWAN_GANDA", `Lebih dari satu karyawan Accurate bernomor ${kode}; betulkan di Accurate.`);
            const e = pegawai[0];
            if (!e.salesman || e.suspended) {
                throw new GalatOtorisasi(409, "KARYAWAN_BUKAN_SALESMAN_AKTIF", `Karyawan ${kode} ${e.suspended ? "nonaktif (suspended)" : "bukan salesman"} di Accurate.`);
            }
            if (e.branchId === null) throw new GalatOtorisasi(409, "KARYAWAN_TANPA_CABANG", `Karyawan ${kode} belum punya cabang di Accurate.`);
            const [lain] = await tx.select({ userId: salesProfile.userId, name: user.name, terhubung: salesProfile.accurateLinked }).from(salesProfile)
                .leftJoin(user, eq(user.id, salesProfile.userId))
                .where(and(samaKode(salesProfile.salesCode, kode), ne(salesProfile.userId, id))).limit(1);
            if (lain?.terhubung) {
                throw new GalatOtorisasi(409, "KARYAWAN_SUDAH_TERHUBUNG", `Karyawan ${kode} sudah tertaut ke akun ${lain.name ?? lain.userId}. Lepas dulu dari akun itu.`,
                    { terhubungKe: { userId: lain.userId, name: lain.name } });
            }
            if (lain) {
                // Kode UNIK: profil Form Kontrol akun lain (tautan dilepas) masih memegangnya — riwayatnya milik akun itu, tidak dipindah diam-diam.
                throw new GalatOtorisasi(409, "KODE_DIPAKAI_PROFIL_LAIN", `Kode ${kode} masih dipegang profil Form Kontrol akun ${lain.name ?? lain.userId} `
                    + "(tautan Accurate-nya sudah dilepas). Ganti/rapikan profil akun itu dulu.", { terhubungKe: { userId: lain.userId, name: lain.name } });
            }
            const milik = await tx.select().from(salesProfile).where(eq(salesProfile.userId, id));
            if (milik.length > 1) {
                throw new GalatOtorisasi(409, "PROFIL_GANDA", `Akun ini punya ${milik.length} profil sales (${milik.map((m) => m.salesCode).join(", ")}). Lepas dulu, lalu tautkan ulang.`);
            }
            const [b] = await tx.select({ name: branch.name }).from(branch).where(eq(branch.id, e.branchId)).limit(1);
            const branchName = b?.name ?? "";
            const lama = milik[0] ?? null;
            const gantiKode = Boolean(lama && lama.salesCode !== e.number);
            const laporanKodeLama = gantiKode ? await laporanFormKontrol(tx, lama!.salesCode) : null;
            if (laporanKodeLama && laporanKodeLama.total > 0 && !konfirmasiGantiKode) {
                throw new GalatOtorisasi(409, "KODE_DIPAKAI_FORM_KONTROL", `Kode sales lama ${lama!.salesCode} punya ${laporanKodeLama.total} catatan Form Kontrol `
                    + `(laporan harian ${laporanKodeLama.laporanHarian}, AO ${laporanKodeLama.ao}, merchandising ${laporanKodeLama.merchandising}, JKS ${laporanKodeLama.jks}). `
                    + `Mengganti ke ${e.number} memutus riwayat itu dari akun ini. Kirim ulang dengan konfirmasiGantiKode bila memang disengaja.`,
                { laporan: laporanKodeLama });
            }
            const changed = !lama || gantiKode || lama.salesName !== e.name || lama.accurateLinked !== true;
            if (lama && changed) {
                await tx.update(salesProfile).set({ salesCode: e.number, salesName: e.name, accurateLinked: true, updatedAt: now })
                    .where(eq(salesProfile.id, lama.id));
            } else if (!lama) {
                // principle/branch NOT NULL warisan modul insentif: diisi nama cabang Accurate (cabang = divisi principal).
                await tx.insert(salesProfile).values({ id: randomUUID(), userId: id, salesCode: e.number, salesName: e.name,
                    principle: branchName, branch: branchName, accurateLinked: true, createdAt: now, updatedAt: now });
            }
            if (changed) await tx.insert(permissionAuditLog).values({
                id: randomUUID(), actorUserId: actor.id, actorName: actor.name, action: "salesman.link", targetUserId: id,
                detail: { userName: t.name, sebelum: lama ? { salesCode: lama.salesCode, salesName: lama.salesName, terhubung: lama.accurateLinked } : null,
                    sesudah: { salesCode: e.number, salesName: e.name, employeeId: e.id, branchId: e.branchId, branchName },
                    ...(laporanKodeLama && laporanKodeLama.total > 0 ? { laporanKodeLama, konfirmasiGantiKode: true } : {}) },
                createdAt: now,
            });
            return { changed, tautan: { salesCode: e.number, employeeName: e.name, employeeId: e.id, branchId: e.branchId, branchName } };
        });
        return NextResponse.json({ ok: true, ...h });
    } catch (e) {
        return jawabGalat(e);
    }
}

export async function DELETE(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;
    const actor = gate.session!.user;
    const { id } = await context.params;
    const now = new Date();
    try {
        const h = await transaksiOtorisasi(actor.id, async (tx) => {
            const t = await userTarget(tx, id);
            // LEPAS, bukan hapus: baris + hierarki Form Kontrol tetap (butir 12).
            const dilepas = await tx.update(salesProfile).set({ accurateLinked: false, updatedAt: now })
                .where(and(eq(salesProfile.userId, id), eq(salesProfile.accurateLinked, true)))
                .returning({ id: salesProfile.id, salesCode: salesProfile.salesCode, salesName: salesProfile.salesName });
            if (dilepas.length) await tx.insert(permissionAuditLog).values({
                id: randomUUID(), actorUserId: actor.id, actorName: actor.name, action: "salesman.unlink", targetUserId: id,
                detail: { userName: t.name, dilepas }, createdAt: now,
            });
            return { changed: dilepas.length > 0 };
        });
        return NextResponse.json({ ok: true, ...h });
    } catch (e) {
        return jawabGalat(e);
    }
}
