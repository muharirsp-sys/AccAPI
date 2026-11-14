/*
 * Tujuan: Simpan halaman order kunjungan (owner 14 Nov 2026, dua alur order salesman) — POST { salesCode, custCode, principle, date, itemSuper,
 *   stok, selesai? { ref, nomorOrderPrincipal? } }. Item super (saran wajib dihitung ulang server, semua harus dijawab) + stok toko ditulis
 *   bersama; `selesai` menandai langkah Order kunjungan selesai: salesman input di AccAPI membawa ref `websales:<id>` dari order yang SUDAH
 *   terkirim ke antrean Web Sales; salesman input di sistem principal membawa ref `principal` ("Sudah input order").
 * Caller: app/(dashboard)/form-kontrol/visit/[custCode]/order/OrderKunjungan.tsx.
 * Dependensi: lib/form-kontrol (resolveScope, canAccessSales, simpanOrderKunjungan), lib/form-kontrol/item-super(-db) (periksaTawaran,
 *   muatSaranKunjungan), lib/form-kontrol/order-kunjungan (periksaStok, periksaRefOrder), db sales_profile (sumber_order), lib/order-cabang jawabGalat.
 * Side Effects: upsert tawaran_item_super + stok_toko_kunjungan, UPDATE ao_control_daily.order_ref/order_dicatat_pada(/invoice_number).
 *   TIDAK menulis ke Accurate dan TIDAK membuat order (order Web Sales dikirim layar ke FastAPI /websales/orders sebelum `selesai`).
 *   Idempoten per kunjungan: kirim ulang sesudah jawaban tidak pasti tidak membuat baris dobel (ref yang sama tidak ditambah dua kali).
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { db } from "@/lib/db";
import { salesProfile } from "@/db/schema";
import { canAccessSales, resolveScope, simpanOrderKunjungan } from "@/lib/form-kontrol";
import { muatSaranKunjungan } from "@/lib/form-kontrol/item-super-db";
import { periksaTawaran } from "@/lib/form-kontrol/item-super";
import { periksaRefOrder, periksaStok } from "@/lib/form-kontrol/order-kunjungan";
import { cocokKodeRute, jawabGalat } from "@/lib/order-cabang";
import { witaToday } from "@/lib/beranda";

const tolak = (status: number, kode: string, error: string) => NextResponse.json({ kode, error }, { status });
const BACKEND = process.env.FASTAPI_BASE_URL || process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || "http://localhost:8000";

/**
 * Ref websales:<id> HARUS permintaan Order Sales nyata milik akun ini (FastAPI GET /websales/orders memakai sesi yang sama, cookie diteruskan
 * seperti /api/orders/preview), untuk toko kunjungan ini (customer_no = kode JKS persis atau + akhiran cabang), bertanggal kunjungan, dan tidak
 * ditolak petugas. Kembali = kalimat penolakan (status) atau null. Antrean tidak terbaca = 503 (tidak pasti; layar menawarkan catat ulang).
 */
async function periksaPermintaan(req: Request, id: string, custCode: string, date: string): Promise<{ status: number; kode: string; error: string } | null> {
    let data: { requests?: { id?: unknown; customer_no?: unknown; order_date?: unknown; status?: unknown }[] } | null = null;
    try {
        const cookie = req.headers.get("cookie");
        const r = await fetch(`${BACKEND}/websales/orders`, { headers: cookie ? { cookie } : {}, cache: "no-store", signal: AbortSignal.timeout(15_000) });
        data = r.ok ? await r.json().catch(() => null) : null;
    } catch { data = null; }
    if (!data || !Array.isArray(data.requests)) {
        return { status: 503, kode: "ANTREAN_TIDAK_TERBACA", error: "Antrean Order Sales belum bisa dibaca untuk memastikan order ini. Order Anda tidak dikirim ulang; coba catat lagi sebentar lagi." };
    }
    const p = data.requests.find((x) => String(x.id ?? "") === id);
    if (!p) return { status: 409, kode: "ORDER_TIDAK_DITEMUKAN", error: "Nomor permintaan ini tidak ada di order Anda, jadi tidak dicatat ke kunjungan." };
    if (!cocokKodeRute(custCode, String(p.customer_no ?? ""))) {
        return { status: 409, kode: "ORDER_TOKO_LAIN", error: `Order ini untuk pelanggan ${String(p.customer_no ?? "-")}, bukan toko kunjungan ${custCode}.` };
    }
    if (String(p.order_date ?? "") !== date) return { status: 409, kode: "ORDER_TANGGAL_LAIN", error: "Tanggal order ini bukan tanggal kunjungan, jadi tidak dicatat." };
    if (p.status === "rejected") return { status: 409, kode: "ORDER_DITOLAK", error: "Order ini sudah ditolak petugas; kirim order baru untuk kunjungan ini." };
    return null;
}

export async function POST(req: Request) {
    const gate = await requirePermissionH("form_kontrol.submit");
    if (gate.response) return gate.response;
    const session = gate.session;
    try {
        const body = await req.json().catch(() => null) as Record<string, unknown> | null;
        const teks = (v: unknown) => (typeof v === "string" ? v.trim() : "");
        const salesCode = teks(body?.salesCode), custCode = teks(body?.custCode), principle = teks(body?.principle), date = teks(body?.date);
        if (!body || !salesCode || !custCode || !principle || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return tolak(400, "INPUT_TIDAK_VALID", "salesCode, custCode, principle, dan date wajib.");
        }
        const scope = await resolveScope(session);
        if (!canAccessSales(scope, salesCode)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

        const saran = await muatSaranKunjungan({ salesCode, custCode, principle, tanggal: date });
        const cek = periksaTawaran(body.itemSuper ?? null, saran);
        if ("error" in cek) return tolak(400, "ITEM_SUPER_BELUM_LENGKAP", cek.error);
        const stok = periksaStok(body.stok ?? null);
        if ("error" in stok) return tolak(400, "STOK_TIDAK_VALID", stok.error);

        let selesai: { ref: string; nomorOrderPrincipal?: string | null } | null = null;
        const s = body.selesai as Record<string, unknown> | null | undefined;
        if (s != null) {
            const [profil] = await db.select({ sumberOrder: salesProfile.sumberOrder }).from(salesProfile).where(eq(salesProfile.salesCode, salesCode)).limit(1);
            const sumber = profil?.sumberOrder === "principal" ? "principal" : "accapi";
            const salah = periksaRefOrder(s.ref, sumber);
            if (salah) return tolak(409, "REF_ORDER_TIDAK_SESUAI", salah);
            selesai = { ref: teks(s.ref) };
            if (sumber === "accapi") {
                const g = await periksaPermintaan(req, selesai.ref.slice("websales:".length), custCode, date);
                if (g) return tolak(g.status, g.kode, g.error);
            }
            // Nomor order sistem principal (opsional, tipe principal saja): kunci tidak dikirim = tidak diubah.
            if (sumber === "principal" && "nomorOrderPrincipal" in s) selesai.nomorOrderPrincipal = teks(s.nomorOrderPrincipal).slice(0, 60) || null;
        }

        const namaBarang = new Map([...saran.wajib, ...saran.lain].map((x) => [x.kodeBarang, x.namaBarang]));
        const hasil = await simpanOrderKunjungan({
            salesCode, custCode, principle, date, penulis: { pemilik: scope.salesCode === salesCode, hariIni: witaToday() },
            tawaran: cek.baris.map((b) => ({ ...b, namaBarang: namaBarang.get(b.kodeBarang) ?? b.kodeBarang })),
            stok: stok.baris, dibuatOleh: session.user.id, selesai,
        });
        if ("galat" in hasil) return jawabGalat(hasil.galat);
        return NextResponse.json({ success: true, id: hasil.id });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
