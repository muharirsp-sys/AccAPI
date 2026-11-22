/*
 * Tujuan: Stok gudang GD01 SATU barang langsung dari Accurate (item/get-stock.do) untuk kartu barang terpilih Order Sales & Order Baru.
 *   Angka hasil sync item_stock (4x sehari) bisa tertinggal beberapa jam — kasus 12 Nov 2026 MSM LERVIA GOAT: web 88 KRT 54 PCS,
 *   Accurate 87 KRT 16 PCS — jadi kartu meminta angka terkini; gagal = kartu tetap menampilkan angka sync dengan keterangannya.
 * Caller: components/order/PemilihBarang.tsx (lewat components/order/order-cabang-api bacaStokLive).
 * Dependensi: lib/accurate-session (kredensial sistem, sama dengan cron), lib/accurate-baca (jatah laju bersama + coba ulang 429),
 *   lib/order-cabang (GUDANG_STOK, cakupanCabang, jumlahGetStock, teksStok, rasioSatuan), db item, lib/rbac/resolve.
 * Main Functions: GET ?no=<kode barang>[&raw=1] -> { ok, no, gudangStok, quantity (satuan dasar), stok (teks bersatuan), per (ISO) }.
 *   `raw=1` menyertakan `d` Accurate apa adanya — untuk membuktikan bentuk jawaban get-stock.do (lihat jumlahGetStock).
 * Side Effects: 1 HTTP GET ke Accurate (baca saja). DB baca saja: angka live TIDAK ditulis ke `item` (sync tetap satu-satunya penulis).
 * Izin = /api/items/search (websales.create / order.create); salesman hanya barang cabangnya.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { item } from "@/db/schema";
import { resolveSyncCredentials } from "@/lib/accurate-session";
import { ambil } from "@/lib/accurate-baca";
import { GUDANG_STOK, cakupanCabang, jawabGalat, jumlahGetStock, rasioSatuan, teksStok, tolakCabangLain } from "@/lib/order-cabang";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

const galat = (status: number, kode: string, error: string) => NextResponse.json({ ok: false, kode, error }, { status });

export async function GET(request: NextRequest) {
    const gate = await resolveRequestPermissions(request);
    if (gate.response) return gate.response;
    if (!gate.perms?.has("websales.create") && !gate.perms?.has("order.create")) {
        return galat(403, "TIDAK_DIIZINKAN", "Akses master barang tidak diizinkan");
    }
    const no = (request.nextUrl.searchParams.get("no") ?? "").trim();
    if (!no || no.length > 60) return galat(400, "INPUT_TIDAK_VALID", "no (kode barang) wajib, maksimal 60 huruf");

    const scope = await cakupanCabang(String(gate.session?.user?.id ?? ""), gate.perms);
    if ("galat" in scope) return jawabGalat(scope.galat);
    const [b] = await db.select({
        no: item.no, branchId: item.branchId,
        unit1Name: item.unit1Name, unit2Name: item.unit2Name, unit3Name: item.unit3Name, unit4Name: item.unit4Name, unit5Name: item.unit5Name,
        ratio2: item.ratio2, ratio3: item.ratio3, ratio4: item.ratio4, ratio5: item.ratio5,
    }).from(item).where(eq(item.no, no)).limit(1);
    if (!b) return galat(404, "BARANG_TIDAK_ADA", `Barang ${no} tidak ada di master Accurate hasil sync.`);
    const luar = tolakCabangLain(scope.cakupan, b.branchId, `Barang ${no}`);
    if (luar) return jawabGalat(luar);

    const accurate = await resolveSyncCredentials();
    if (!accurate.creds) return galat(503, "SESI_ACCURATE", accurate.error);
    let d: unknown;
    try {
        d = (await ambil(accurate.creds, "/item/get-stock.do", { no: b.no, warehouseName: GUDANG_STOK })).d;
    } catch (e) {
        return galat(502, "STOK_GAGAL", `Stok ${GUDANG_STOK} dari Accurate gagal dibaca: ${e instanceof Error ? e.message : String(e)}`);
    }
    const raw = request.nextUrl.searchParams.get("raw") === "1" ? { raw: d } : {};
    const quantity = jumlahGetStock(d);
    if (quantity === null) {
        // Nama kunci saja (bukan nilainya) supaya bentuk jawaban yang belum dikenal terlihat di log tanpa membuka ?raw=1.
        console.warn(`[items/stok] bentuk get-stock.do tidak dikenal untuk ${b.no}: ${d && typeof d === "object" ? Object.keys(d).join(",") : typeof d}`);
        return NextResponse.json({ ok: false, kode: "STOK_TIDAK_TERBACA", error: `Jawaban stok Accurate untuk ${b.no} tidak terbaca.`, ...raw }, { status: 502 });
    }
    return NextResponse.json({ ok: true, no: b.no, gudangStok: GUDANG_STOK, quantity, stok: teksStok(quantity, rasioSatuan(b)), per: new Date().toISOString(), ...raw });
}
