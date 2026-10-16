/*
 * Tujuan: Pemeriksa order per cabang + harga server untuk SIMPAN order (O1, owner 12 Okt 2026) — pasangan /api/orders/preview tanpa promo.
 * Caller: FastAPI python_backend/order_cabang.py lewat routers/orders `hitung_order`: `POST /websales/orders` (Order Sales; meneruskan
 *   cookie sesi sales -> cakupan cabang salesman), `POST /orders` (Order Baru) dan tarikan Web Sales (CRON_SECRET, layanan ke layanan ->
 *   semua cabang).
 * Dependensi: lib/order-cabang (cakupanCabang, periksaOrder), lib/api-security (requireCronSecret), lib/rbac/resolve.
 * Main Functions: POST.
 * Side Effects: DB read-only. Tidak menyimpan apa pun — harga yang dikembalikan DIBEKUKAN FastAPI pada order (faktur memakai harga beku
 *   itu, tidak menghitung ulang).
 *
 * Izin: CRON_SECRET (FastAPI, termasuk cron tarik Order Masuk yang tanpa cookie siapa pun — secret yang sama sudah dipercaya memicu sync
 * dan kirim faktur, dan endpoint ini hanya membaca), ATAU sesi dengan `websales.create`/`order.create` (sama dengan pratinjau).
 * Badan: { customer_no, order_date: YYYY-MM-DD, lines: [{code, unit, quantity?, price?}] }. `price` = harga PETUGAS (Order Baru) — hanya
 * layanan atau sesi `order.create`, HANYA untuk baris TANPA harga master sah (owner sesi 13; baris berharga master + `price` = 409
 * `HARGA_PETUGAS_TIDAK_DIIZINKAN`); dikembalikan APA ADANYA. Tanpa `price` = harga master SAH cabang pelanggan.
 * Jawaban 200: { ok, pelanggan: {customerNo, name, branchId, branchName}, lines: [{code, unit, quantity, price, sumber_harga, rasio}] } (urutan =
 * masukan; `sumber_harga` "master" | "master_default" | "petugas"). Galat: { ok:false, kode, error, ... } — kode di
 * docs/handover/O1-KONTRAK-ORDER-CABANG.md.
 * Putaran 2 (butir 7): `bonus: [kode]` (maks 50) = barang bonus promo yang diperiksa syarat order (cabang/suspended/bisa diorder) ->
 * 409 `BONUS_TIDAK_BISA_DIORDER`; dengan `bonus`, `lines` boleh kosong (FastAPI memanggilnya sesudah promo dihitung).
 */
import { NextRequest, NextResponse } from "next/server";
import { cakupanCabang, jawabGalat, periksaOrder, sumberHarga, type Cakupan } from "@/lib/order-cabang";
import { requireCronSecret } from "@/lib/api-security";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

const MAX_LINES = 500;

export async function POST(request: NextRequest) {
    let cakupan: Cakupan;
    let bolehHargaPetugas = true;
    if (!requireCronSecret(request).response) {
        cakupan = { semua: true };
    } else {
        const gate = await resolveRequestPermissions(request);
        if (gate.response) return gate.response;
        if (!gate.perms?.has("websales.create") && !gate.perms?.has("order.create")) {
            return NextResponse.json({ ok: false, kode: "TIDAK_DIIZINKAN", error: "Akses order tidak diizinkan" }, { status: 403 });
        }
        const scope = await cakupanCabang(String(gate.session?.user?.id ?? ""), gate.perms);
        if ("galat" in scope) return jawabGalat(scope.galat);
        cakupan = scope.cakupan;
        bolehHargaPetugas = gate.perms.has("order.create");
    }

    const body = await request.json().catch(() => null) as { customer_no?: unknown; order_date?: unknown; lines?: unknown; bonus?: unknown } | null;
    const bonus = Array.isArray(body?.bonus) ? (body!.bonus as unknown[]).map((c) => String(c ?? "").trim()).filter(Boolean) : [];
    const orderDate = String(body?.order_date ?? "").trim();
    const raw = Array.isArray(body?.lines) ? (body!.lines as Array<{ code?: unknown; unit?: unknown; quantity?: unknown; price?: unknown }>) : [];
    const lines = raw.map((l) => ({
        code: String(l?.code ?? "").trim(), unit: String(l?.unit ?? "").trim().toUpperCase(), quantity: String(l?.quantity ?? "").trim(),
        price: l?.price === undefined || l?.price === null ? "" : String(l.price).trim(),
    }));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate) || (lines.length < 1 && bonus.length < 1) || lines.length > MAX_LINES || bonus.length > 50
        || lines.some((l) => !l.code || !l.unit)) {
        return NextResponse.json({ ok: false, kode: "INPUT_TIDAK_VALID",
            error: `Tanggal order (YYYY-MM-DD) dan 1–${MAX_LINES} baris berkode barang + satuan wajib diisi` }, { status: 400 });
    }
    if (!bolehHargaPetugas && lines.some((l) => l.price !== "")) {
        return NextResponse.json({ ok: false, kode: "INPUT_TIDAK_VALID",
            error: "Harga tidak boleh dikirim dari Order Sales; harga dihitung server dari master Accurate." }, { status: 400 });
    }
    const cek = await periksaOrder({ customerNo: String(body?.customer_no ?? ""), orderDate, lines, cakupan, bonus });
    if (!cek.ok) return jawabGalat(cek);
    return NextResponse.json({
        ok: true,
        pelanggan: { customerNo: cek.pelanggan.customerNo, name: cek.pelanggan.name, branchId: cek.pelanggan.branchId, branchName: cek.pelanggan.branchName },
        lines: lines.map((l, i) => ({
            code: l.code, unit: l.unit, quantity: l.quantity,
            price: l.price !== "" ? l.price : String(cek.harga[i].price),
            sumber_harga: sumberHarga(cek.harga[i]),
            rasio: cek.harga[i].rasio ?? {},
        })),
        bonus,
    });
}
