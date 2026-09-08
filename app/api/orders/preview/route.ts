/*
 * Tujuan: Pratinjau nilai order dan saran promo dengan harga dari server (hasil sync Accurate).
 * Caller: halaman Order Masuk dan aplikasi Web Sales; klien TIDAK pernah mengirim harga.
 * Dependensi: lib/item-price (harga bertingkat + fallback), lib/rbac/resolve, backend FastAPI /orders/preview.
 * Main Functions: POST.
 * Side Effects: DB read-only; satu panggilan HTTP ke backend promo. Tidak menyimpan order.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolvePrices } from "@/lib/item-price";
import { requirePermissionH } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

const MAX_LINES = 200;
const BACKEND = process.env.FASTAPI_BASE_URL || process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || "http://localhost:8000";

type IncomingLine = { code?: unknown; unit?: unknown; quantity?: unknown };

// Harga bertingkat butuh identitas pelanggan Accurate; tanpa itu jatuh ke harga standar.
type Body = { channel?: unknown; order_date?: unknown; lines?: unknown; customer_no?: unknown; branch_id?: unknown };

export async function POST(request: NextRequest) {
    const gate = await requirePermissionH("order.create");
    if (gate.response) return gate.response;

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

    // Harga HANYA dari master hasil sync Accurate. Harga yang dikirim klien diabaikan.
    const customerNo = String(body.customer_no ?? "").trim();
    const branchId = Number(body.branch_id);
    const resolved = await resolvePrices(wanted, {
        orderDate,
        customerNo: customerNo || undefined,
        branchId: Number.isFinite(branchId) ? branchId : undefined,
    });
    // Satuan di luar master DITOLAK, bukan dihitung dengan harga standar: selisih satuan pada
    // satu item bisa 72x (BAG 15.900 vs KRT 1.144.800).
    const wrongUnit = resolved.filter((row) => row.knownUnits?.length);
    if (wrongUnit.length) {
        return NextResponse.json({
            ok: false,
            error: wrongUnit.slice(0, 3)
                .map((row) => `Satuan ${row.unit} tidak ada di master untuk ${row.code} (tersedia: ${row.knownUnits!.join(", ")})`)
                .join("; "),
            wrong_unit: wrongUnit.map((row) => ({ code: row.code, unit: row.unit, known_units: row.knownUnits })),
        }, { status: 409 });
    }

    const missing = resolved.filter((row) => row.price === null).map((row) => row.code);
    if (missing.length) {
        return NextResponse.json({
            ok: false,
            error: `Harga belum tersedia dari Accurate untuk: ${[...new Set(missing)].slice(0, 5).join(", ")}`,
            missing,
        }, { status: 409 });
    }

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
    return NextResponse.json({ ok: true, lines, prices: priceInfo, result: data.result, suggestions: data.suggestions ?? [] });
}
