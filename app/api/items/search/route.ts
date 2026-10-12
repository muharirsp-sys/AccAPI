/*
 * Tujuan: Cari barang (kode/nama) PER CABANG untuk pemilih barang Order Sales & Order Baru (O1, owner 12 Okt 2026), dengan satuan sah
 *   dan — bila `customerId` diberikan — harga per cabang pelanggan (resolvePrices yang sama dengan pratinjau).
 * Caller: app/(dashboard)/sales/OrderSales.tsx, app/(dashboard)/orders/OrderBaru.tsx (O2).
 * Dependensi: db item/customer/branch (hasil sync), lib/order-cabang, lib/item-price (itemUnits, resolvePrices), lib/rbac/resolve.
 * Main Functions: GET ?q=&branchId=&customerId=&tanggal=YYYY-MM-DD&limit= (limit 1–50, bawaan 20; tanggal bawaan hari ini WITA).
 * Side Effects: DB read-only.
 *
 * Owner 12 Okt: pelanggan cabang X hanya boleh dipesankan barang ber-cabang X -> dengan `customerId` cabangnya = cabang pelanggan
 * (`branchId` lain = 400). Salesman hanya cabangnya (`branchId`/pelanggan cabang lain = 403). Tanpa barang suspended dan tanpa barang
 * bercabang kosong (non-jual / tag tak dikenal). Izin = /api/items/units. Galat DB = 500, bukan daftar kosong.
 * Putaran 1 (12 Okt): harga satuan = HANYA harga master SAH untuk order (lib/order-cabang hargaSah: daftar harga cabang pelanggan/default,
 * > 0) — harga standar/0/cabang lain tampil `price: null` (tidak bisa dipilih tanpa harga petugas), sama dengan penolakan pratinjau.
 * `cabangTanpaBarang: true` = cabang itu memang tidak punya barang yang bisa diorder (bukan "tidak cocok dengan pencarian") — layar
 * menjelaskan (sync barang belum jalan / cabang tanpa tag divisi).
 */
import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, ilike, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { branch, customer, item } from "@/db/schema";
import { angkaQuery, cakupanCabang, hargaSah, jawabGalat, polaLike, tolakCabangLain } from "@/lib/order-cabang";
import { itemUnits, resolvePrices } from "@/lib/item-price";
import { todayWita } from "@/lib/insentif-payment-date";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

const galat = (status: number, kode: string, error: string) => NextResponse.json({ ok: false, kode, error }, { status });

export async function GET(request: NextRequest) {
    const gate = await resolveRequestPermissions(request);
    if (gate.response) return gate.response;
    if (!gate.perms?.has("websales.create") && !gate.perms?.has("order.create")) {
        return galat(403, "TIDAK_DIIZINKAN", "Akses master barang tidak diizinkan");
    }
    const p = request.nextUrl.searchParams;
    const q = (p.get("q") ?? "").trim().slice(0, 80);
    const branchId = angkaQuery(p.get("branchId"));
    const customerId = angkaQuery(p.get("customerId"));
    const limit = angkaQuery(p.get("limit")) ?? 20;
    const tanggal = (p.get("tanggal") ?? "").trim() || todayWita(new Date());
    if (branchId === undefined || customerId === undefined || limit === undefined || limit < 1 || limit > 50 || !/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) {
        return galat(400, "INPUT_TIDAK_VALID", "branchId/customerId harus angka; limit 1–50; tanggal YYYY-MM-DD");
    }

    const scope = await cakupanCabang(String(gate.session?.user?.id ?? ""), gate.perms);
    if ("galat" in scope) return jawabGalat(scope.galat);
    const cakupan = scope.cakupan;

    let cabang: number | null = cakupan.semua ? branchId : cakupan.branchId;
    let pelanggan: { customerNo: string; branchId: number } | null = null;
    if (customerId !== null) {
        const [c] = await db.select({ customerNo: customer.customerNo, branchId: customer.branchId, suspended: customer.suspended })
            .from(customer).where(eq(customer.id, customerId)).limit(1);
        if (!c) return galat(409, "PELANGGAN_TIDAK_ADA", `Pelanggan id ${customerId} tidak ada di master Accurate hasil sync.`);
        if (c.suspended) return galat(409, "PELANGGAN_SUSPENDED", `Pelanggan ${c.customerNo} nonaktif (suspended) di Accurate; tidak bisa diorder.`);
        if (c.branchId === null) return galat(409, "PELANGGAN_TANPA_CABANG", `Pelanggan ${c.customerNo} belum punya cabang di Accurate.`);
        const luar = tolakCabangLain(cakupan, c.branchId, `Pelanggan ${c.customerNo}`);
        if (luar) return jawabGalat(luar);
        if (branchId !== null && branchId !== c.branchId) {
            return galat(400, "INPUT_TIDAK_VALID", `branchId ${branchId} bukan cabang pelanggan ${c.customerNo}; barang mengikuti cabang pelanggan.`);
        }
        cabang = c.branchId;
        pelanggan = { customerNo: c.customerNo, branchId: c.branchId };
    } else {
        const luar = tolakCabangLain(cakupan, branchId, `Cabang ${branchId}`);
        if (luar) return jawabGalat(luar);
    }

    const syarat: SQL[] = [eq(item.suspended, false), isNotNull(item.branchId)];
    if (cabang !== null) syarat.push(eq(item.branchId, cabang));
    if (q) syarat.push(or(ilike(item.no, polaLike(q)), ilike(item.name, polaLike(q)))!);
    const rows = await db.select({ id: item.id, no: item.no, name: item.name, branchId: item.branchId, branchName: branch.name, tag: item.charField2 })
        .from(item).leftJoin(branch, eq(branch.id, item.branchId)).where(and(...syarat))
        .orderBy(sql`(upper(${item.no}) = upper(${q})) desc`, asc(item.name), asc(item.no))
        .limit(limit);

    // Satuan sah = satuan yang punya baris harga di item_selling_price (lib/item-price). Kosong = belum ada daftar harga.
    const units = await itemUnits(rows.map((r) => r.no));
    const pasangan = rows.flatMap((r) => (units.get(r.no) ?? []).map((unit) => ({ code: r.no, unit })));
    const harga = pelanggan && pasangan.length
        ? await resolvePrices(pasangan, { orderDate: tanggal, customerNo: pelanggan.customerNo, branchId: pelanggan.branchId })
        : [];
    const hargaDari = new Map(harga.map((h) => [`${h.code}|${h.unit}`, h]));
    // Kosong karena cabangnya memang tanpa barang orderan, atau karena pencarian tidak cocok? Hanya ditanyakan saat kosong.
    const cabangTanpaBarang = rows.length === 0 && cabang !== null
        ? (await db.select({ id: item.id }).from(item).where(and(eq(item.branchId, cabang), eq(item.suspended, false))).limit(1)).length === 0
        : false;
    return NextResponse.json({
        ok: true, tanggal, branchId: cabang, cabangTanpaBarang,
        items: rows.map((r) => ({
            ...r,
            units: (units.get(r.no) ?? []).map((unit) => {
                const h = hargaDari.get(`${r.no}|${unit}`);
                return pelanggan
                    ? { unit, price: h && hargaSah(h, pelanggan.branchId) ? h.price : null, source: h?.source ?? "missing",
                        branchName: h?.branchName ?? null, effectiveDate: h?.effectiveDate ?? null }
                    : { unit };
            }),
        })),
    });
}
