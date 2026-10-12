/*
 * Tujuan: Pratinjau nilai order dan saran promo dengan harga dari server (hasil sync Accurate).
 * Caller: halaman Order Masuk dan aplikasi Web Sales; klien TIDAK pernah mengirim harga.
 * Dependensi: lib/order-cabang (aturan cabang + harga per cabang pelanggan), lib/rbac/resolve, backend FastAPI /orders/preview.
 * Izin: `order.create` (petugas internal) ATAU `websales.create` (sales). Sales HARUS melihat
 * nilai transaksi dan promo; yang dilarang adalah klien MENENTUKAN harga.
 * Main Functions: POST.
 * Side Effects: DB read-only; satu panggilan HTTP ke backend promo. Tidak menyimpan order.
 *
 * O1 (owner 12 Okt 2026): cabang harga = cabang PELANGGAN dibaca server (dulu `branch_id` dari badan permintaan yang tak pernah dikirim
 * layar mana pun -> harga jatuh ke cabang default). Pemeriksaannya SAMA dengan saat order disimpan (lib/order-cabang periksaOrder):
 * pelanggan wajib, salesman hanya cabangnya, barang beda cabang ditolak `BARANG_BEDA_CABANG`.
 */
import { NextRequest, NextResponse } from "next/server";
import { cakupanCabang, jawabGalat, periksaOrder } from "@/lib/order-cabang";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

const MAX_LINES = 200;
const BACKEND = process.env.FASTAPI_BASE_URL || process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || "http://localhost:8000";

type IncomingLine = { code?: unknown; unit?: unknown; quantity?: unknown };

type Body = { channel?: unknown; order_date?: unknown; lines?: unknown; customer_no?: unknown };

export async function POST(request: NextRequest) {
    const gate = await resolveRequestPermissions(request);
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.create") && !gate.perms?.has("websales.create")) {
        return NextResponse.json({ ok: false, error: "Akses pratinjau order tidak diizinkan" }, { status: 403 });
    }

    let body: Body;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ ok: false, error: "Format permintaan tidak valid" }, { status: 400 });
    }
    const channel = String(body.channel ?? "").trim().toUpperCase();
    const orderDate = String(body.order_date ?? "").trim();
    const incoming = Array.isArray(body.lines) ? (body.lines as IncomingLine[]) : [];
    if (!channel || !/^\d{4}-\d{2}-\d{2}$/.test(orderDate)) {
        return NextResponse.json({ ok: false, error: "Channel dan tanggal order (YYYY-MM-DD) wajib diisi" }, { status: 400 });
    }
    if (incoming.length < 1 || incoming.length > MAX_LINES) {
        return NextResponse.json({ ok: false, error: `Isi 1–${MAX_LINES} baris` }, { status: 400 });
    }

    // Tidak ada default "PCS": item uji hanya punya harga KRT dan PACK, jadi satuan yang
    // ditebak membuat harga jatuh ke fallback standar dengan satuan yang salah.
    const wanted = incoming.map((line) => ({
        code: String(line.code ?? "").trim(),
        unit: String(line.unit ?? "").trim().toUpperCase(),
        quantity: String(line.quantity ?? "").trim(),
    }));
    if (wanted.some((line) => !line.code || !line.unit || !/^\d+$/.test(line.quantity) || Number(line.quantity) <= 0)) {
        return NextResponse.json({ ok: false, error: "Setiap baris butuh kode barang, satuan, dan jumlah lebih dari nol" }, { status: 400 });
    }

    const scope = await cakupanCabang(String(gate.session?.user?.id ?? ""), gate.perms);
    if ("galat" in scope) return jawabGalat(scope.galat);
    // Harga HANYA dari master hasil sync Accurate, per cabang pelanggan. Harga/cabang yang dikirim klien diabaikan.
    const cek = await periksaOrder({ customerNo: String(body.customer_no ?? ""), orderDate, lines: wanted, cakupan: scope.cakupan });
    if (!cek.ok) return jawabGalat(cek);
    const resolved = cek.harga;

    const lines = wanted.map((line, index) => ({ ...line, price: String(resolved[index].price) }));
    const priceInfo = resolved.map((row) => ({
        code: row.code, unit: row.unit, price: row.price, source: row.source,
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
            body: JSON.stringify({ channel, order_date: orderDate, lines }),
            signal: AbortSignal.timeout(20_000),
        });
    } catch {
        return NextResponse.json({ ok: false, error: "Layanan promo tidak dapat dihubungi" }, { status: 502 });
    }
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
        return NextResponse.json({ ok: false, error: String(data?.detail || data?.error || "Pratinjau gagal") }, { status: upstream.status });
    }
    return NextResponse.json({
        ok: true, lines, prices: priceInfo, result: data.result, suggestions: data.suggestions ?? [],
        pelanggan: { customerNo: cek.pelanggan.customerNo, name: cek.pelanggan.name, branchId: cek.pelanggan.branchId, branchName: cek.pelanggan.branchName },
    });
}
