/*
 * Tujuan: Kunjungan LUAR RUTE (FK-MSM2, owner 12 Okt 2026). GET = daftar kunjungan luar rute salesman (tanggal itu + yang masih menunggu
 *   keputusan JKS) untuk konfirmasi di akhir sesi; POST = tambah pelanggan Accurate cabang salesman ke kunjungan HARI INI.
 * Caller: app/(dashboard)/form-kontrol/tabs/LuarRute.tsx (Rute hari ini: tambah; Laporan harian: daftar + konfirmasi).
 * Dependensi: lib/form-kontrol (resolveScope, canAccessSales, getJksPrinciples, tambahLuarRute, daftarLuarRute), lib/order-cabang
 *   (cakupanCabang, jawabGalat), lib/beranda (witaToday), db customer.
 * Main Functions: GET ?salesCode=&date=, POST { salesCode, principle, date, customerNo }.
 * Side Effects: POST menulis kunjungan_luar_rute + kontrol_audit_log (lib/form-kontrol/luar-rute).
 *
 * Aturan POST (semua diperiksa server; galat = { ok:false, kode, error } berkalimat Indonesia):
 *   - izin form_kontrol.submit; HANYA akun salesman pemilik kode sales itu (SPV/admin baca-saja) → 403 BUKAN_PEMILIK;
 *   - tanggal = hari ini WITA menurut server (kunjungan luar rute tidak diisi mundur) → 400 TANGGAL_BUKAN_HARI_INI;
 *   - cabang = cakupan O1 (cabang karyawan Accurate salesman; galat tautan O1 diteruskan); pelanggan aktif di cabang itu, dicocokkan
 *     customerNo persis (tak peka huruf) → 404 PELANGGAN_TIDAK_DITEMUKAN;
 *   - principal = principal JKS aktif salesman; salesman TANPA JKS → nama cabang Accurate-nya → 403 PRINCIPAL_LUAR_CAKUPAN;
 *   - toko yang sudah di rute JKS hari ini → 409 SUDAH_DI_RUTE (tidak ganda); menambah ulang = baris yang sama.
 */
import { NextResponse } from "next/server";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { customer } from "@/db/schema";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { canAccessSales, daftarLuarRute, getJksPrinciples, resolveScope, tambahLuarRute } from "@/lib/form-kontrol";
import { cakupanCabang, jawabGalat } from "@/lib/order-cabang";
import { witaToday } from "@/lib/beranda";

const TANGGAL = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
    const gate = await requirePermissionH("form_kontrol.view");
    if (gate.response) return gate.response;
    try {
        const { searchParams } = new URL(req.url);
        const salesCode = searchParams.get("salesCode") ?? "";
        const date = searchParams.get("date") || witaToday();
        if (!salesCode || !TANGGAL.test(date)) return jawabGalat({ status: 400, kode: "INPUT_TIDAK_VALID", error: "Kode sales dan tanggal (YYYY-MM-DD) wajib." });
        if (!canAccessSales(await resolveScope(gate.session), salesCode)) return jawabGalat({ status: 403, kode: "LUAR_CAKUPAN", error: "Kode sales ini di luar cakupan Anda." });
        return NextResponse.json({ ok: true, rows: await daftarLuarRute(salesCode, date), date });
    } catch {
        return NextResponse.json({ ok: false, error: "Internal server error" }, { status: 500 });
    }
}

export async function POST(req: Request) {
    const gate = await requirePermissionH("form_kontrol.submit");
    if (gate.response) return gate.response;
    const session = gate.session;
    try {
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        const teks = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string).trim() : "");
        const salesCode = teks("salesCode"), principle = teks("principle"), date = teks("date"), customerNo = teks("customerNo");
        if (!salesCode || !principle || !TANGGAL.test(date) || !customerNo || customerNo.length > 80) {
            return jawabGalat({ status: 400, kode: "INPUT_TIDAK_VALID", error: "Kode sales, principal, tanggal, dan kode pelanggan wajib." });
        }
        const scope = await resolveScope(session);
        if (scope.salesCode !== salesCode) {
            return jawabGalat({ status: 403, kode: "BUKAN_PEMILIK", error: "Kunjungan luar rute hanya ditambahkan oleh salesman pemilik rute dari akunnya sendiri." });
        }
        const hariIni = witaToday();
        if (date !== hariIni) {
            return jawabGalat({ status: 400, kode: "TANGGAL_BUKAN_HARI_INI", error: `Kunjungan luar rute hanya untuk hari ini (${hariIni}); muat ulang Rute hari ini.` });
        }
        const c = await cakupanCabang(String(session.user.id), gate.perms!);
        if ("galat" in c) return jawabGalat(c.galat);
        const cakupan = c.cakupan;
        const jks = await getJksPrinciples([salesCode]);
        const boleh = jks.length ? jks : !cakupan.semua && cakupan.branchName ? [cakupan.branchName] : [];
        if (!boleh.includes(principle)) {
            return jawabGalat({ status: 403, kode: "PRINCIPAL_LUAR_CAKUPAN",
                error: `Principal ${principle} bukan principal Anda (${boleh.join(", ") || "belum ada JKS maupun cabang Accurate"}).` });
        }
        const rows = await db.select({ id: customer.id, customerNo: customer.customerNo, name: customer.name, alamat: customer.alamat })
            .from(customer).where(and(sql`upper(trim(${customer.customerNo})) = ${customerNo.toUpperCase()}`, eq(customer.suspended, false),
                isNotNull(customer.branchId), cakupan.semua ? undefined : eq(customer.branchId, cakupan.branchId))).limit(2);
        if (rows.length !== 1) {
            return jawabGalat({ status: 404, kode: "PELANGGAN_TIDAK_DITEMUKAN",
                error: `Pelanggan ${customerNo} tidak ditemukan sebagai pelanggan aktif${cakupan.semua ? "" : ` cabang Anda (${cakupan.branchName || cakupan.branchId})`}.` });
        }
        const hasil = await tambahLuarRute({ salesCode, principle, tanggal: date, pelanggan: { ...rows[0], id: Number(rows[0].id) },
            aktorId: String(session.user.id), aktorNama: session.user.name ?? null });
        if ("galat" in hasil) return jawabGalat(hasil.galat);
        return NextResponse.json({ ok: true, baru: hasil.baru, row: hasil.row }, { status: hasil.baru ? 201 : 200 });
    } catch {
        return NextResponse.json({ ok: false, error: "Internal server error" }, { status: 500 });
    }
}
