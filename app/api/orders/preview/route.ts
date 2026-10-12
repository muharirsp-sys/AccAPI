/*
 * Tujuan: Pratinjau nilai order, promo, dan `sidik` dengan harga dari server (hasil sync Accurate) — SATU pratinjau untuk Order Sales
 *   dan Order Baru; angkanya = angka yang nanti disimpan/dibekukan (kontrak docs/handover/O1-KONTRAK-ORDER-CABANG.md §4).
 * Caller: Order Sales (sales) dan Order Baru (petugas internal).
 * Dependensi: lib/order-cabang (aturan cabang + harga per cabang pelanggan), lib/rbac/resolve, backend FastAPI /orders/preview
 *   (`hitung_promo`, fungsi hitung yang SAMA dengan simpan/tarik).
 * Izin: `order.create` (petugas internal) ATAU `websales.create` (sales). Sales HARUS melihat nilai transaksi dan promo; yang dilarang
 *   adalah klien MENENTUKAN harga — `price` per baris hanya diterima dari `order.create` (harga petugas Order Baru).
 * Main Functions: POST.
 * Side Effects: DB read-only; satu panggilan HTTP ke backend promo. Tidak menyimpan order.
 *
 * O1 (owner 12 Okt 2026): cabang harga = cabang PELANGGAN dibaca server. Pemeriksaannya SAMA dengan saat order disimpan
 * (lib/order-cabang periksaOrder): pelanggan wajib, salesman hanya cabangnya, barang beda cabang ditolak `BARANG_BEDA_CABANG`, harga
 * master hanya yang SAH (daftar harga cabang pelanggan/default, > 0). Putaran 1: `customer_no` diteruskan ke FastAPI (kelas outlet ikut
 * dihitung, dulu tidak -> pratinjau beda dengan simpan); jawaban membawa `sidik`, `sources`, `channel_masalah`.
 */
import { NextRequest, NextResponse } from "next/server";
import { cakupanCabang, jawabGalat, periksaBonus, periksaOrder, sumberHarga } from "@/lib/order-cabang";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

const MAX_LINES = 200;
const BACKEND = process.env.FASTAPI_BASE_URL || process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || "http://localhost:8000";

type IncomingLine = { code?: unknown; unit?: unknown; quantity?: unknown; price?: unknown };

type Body = { channel?: unknown; order_date?: unknown; lines?: unknown; customer_no?: unknown };

const galat = (status: number, kode: string, error: string) => NextResponse.json({ ok: false, kode, error }, { status });

export async function POST(request: NextRequest) {
    const gate = await resolveRequestPermissions(request);
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.create") && !gate.perms?.has("websales.create")) {
        return galat(403, "TIDAK_DIIZINKAN", "Akses pratinjau order tidak diizinkan");
    }

    let body: Body;
    try {
        body = await request.json();
    } catch {
        return galat(400, "INPUT_TIDAK_VALID", "Format permintaan tidak valid");
    }
    const channel = String(body.channel ?? "").trim().toUpperCase();
    const orderDate = String(body.order_date ?? "").trim();
    const incoming = Array.isArray(body.lines) ? (body.lines as IncomingLine[]) : [];
    if (!channel || !/^\d{4}-\d{2}-\d{2}$/.test(orderDate)) {
        return galat(400, "INPUT_TIDAK_VALID", "Channel dan tanggal order (YYYY-MM-DD) wajib diisi");
    }
    if (incoming.length < 1 || incoming.length > MAX_LINES) {
        return galat(400, "INPUT_TIDAK_VALID", `Isi 1–${MAX_LINES} baris`);
    }

    // Tidak ada default "PCS": item uji hanya punya harga KRT dan PACK, jadi satuan yang
    // ditebak membuat harga jatuh ke fallback standar dengan satuan yang salah.
    const wanted = incoming.map((line) => ({
        code: String(line.code ?? "").trim(),
        unit: String(line.unit ?? "").trim().toUpperCase(),
        quantity: String(line.quantity ?? "").trim(),
        price: line.price === undefined || line.price === null ? "" : String(line.price).trim(),
    }));
    if (wanted.some((line) => !line.code || !line.unit || !/^\d+$/.test(line.quantity) || Number(line.quantity) <= 0)) {
        return galat(400, "INPUT_TIDAK_VALID", "Setiap baris butuh kode barang, satuan, dan jumlah lebih dari nol");
    }
    // Harga dari klien hanya untuk petugas internal (Order Baru); sales tidak pernah menentukan harga — ditolak, bukan diabaikan diam-diam.
    if (!gate.perms.has("order.create") && wanted.some((line) => line.price !== "")) {
        return galat(400, "INPUT_TIDAK_VALID", "Harga tidak boleh dikirim dari Order Sales; harga dihitung server dari master Accurate.");
    }

    const scope = await cakupanCabang(String(gate.session?.user?.id ?? ""), gate.perms);
    if ("galat" in scope) return jawabGalat(scope.galat);
    // Harga master HANYA dari master hasil sync Accurate, per cabang pelanggan. Cabang yang dikirim klien diabaikan.
    const customerNo = String(body.customer_no ?? "").trim();
    const cek = await periksaOrder({ customerNo, orderDate, lines: wanted, cakupan: scope.cakupan });
    if (!cek.ok) return jawabGalat(cek);
    const resolved = cek.harga;

    // Harga yang DIPAKAI per baris (string), persis yang nanti dikirim /api/orders/harga ke FastAPI saat simpan — sidik bergantung padanya.
    const lines = wanted.map((line, index) => ({
        code: line.code, unit: line.unit, quantity: line.quantity,
        price: line.price !== "" ? line.price : String(resolved[index].price),
        sumber_harga: sumberHarga(resolved[index]),
    }));
    const priceInfo = resolved.map((row) => ({
        code: row.code, unit: row.unit, price: row.price, source: row.source,
        hargaMaster: row.source === "petugas" ? (row.hargaMaster ?? null) : row.price, hargaDefault: row.hargaDefault === true,
        priceCategoryName: row.priceCategoryName ?? null, branchName: row.branchName ?? null,
        effectiveDate: row.effectiveDate ?? null, knownUnits: row.knownUnits ?? null,
    }));
    const forwarded = request.headers.get("cookie");
    let upstream: Response;
    try {
        upstream = await fetch(`${BACKEND}/orders/preview`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(forwarded ? { cookie: forwarded } : {}),
                ...(request.headers.get("x-csrf-token") ? { "X-CSRF-Token": request.headers.get("x-csrf-token") as string } : {}),
            },
            body: JSON.stringify({ channel, order_date: orderDate, customer_no: cek.pelanggan.customerNo,
                lines: lines.map(({ code, unit, quantity, price }) => ({ code, unit, quantity, price })) }),
            signal: AbortSignal.timeout(20_000),
        });
    } catch {
        return galat(502, "LAYANAN_TIDAK_PASTI", "Layanan promo tidak dapat dihubungi");
    }
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
        return NextResponse.json({ ok: false, kode: String(data?.kode || "PRATINJAU_GAGAL"), error: String(data?.detail || data?.error || "Pratinjau gagal") },
            { status: upstream.status });
    }
    // Barang bonus hasil promo = syarat barang order (butir 7), keputusan SAMA dengan simpan/tarik (/api/orders/harga `bonus`).
    const bonusBuruk = await periksaBonus(cek.pelanggan, ((data.result?.bonuses ?? []) as Array<{ code?: string }>).map((b) => String(b.code ?? "")));
    if (bonusBuruk) return jawabGalat(bonusBuruk);
    return NextResponse.json({
        ok: true, lines, prices: priceInfo, result: data.result ?? null, suggestions: data.suggestions ?? [], sources: data.sources ?? [],
        channel_masalah: String(data.channel_masalah ?? ""), sidik: data.sidik ?? null,
        pelanggan: { customerNo: cek.pelanggan.customerNo, name: cek.pelanggan.name, branchId: cek.pelanggan.branchId, branchName: cek.pelanggan.branchName },
    });
}
