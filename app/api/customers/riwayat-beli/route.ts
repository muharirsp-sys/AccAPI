/*
 * Tujuan: Riwayat beli SATU toko (O3, owner 12 Okt 2026 sesi 13) untuk panel "Biasa diambil toko ini" di Order Sales & Order Baru:
 *   per barang + satuan — total qty dalam jendela, rata-rata per bulan, jumlah faktur, tanggal beli terakhir, dan apakah barang itu KINI
 *   bisa diorder untuk pelanggan ini; plus ringkasan (faktur dalam jendela, berapa tanpa rincian barang, tanggal data paling awal toko itu).
 * Caller: components/order/RiwayatBeli.tsx.
 * Dependensi: db sales_invoice (cache faktur Accurate; rincian baris HANYA ada untuk faktur yang masuk lewat detail.do/webhook),
 *   customer/branch/item, lib/order-cabang (cakupanCabang, tolakCabangLain, alasanBonus), lib/riwayat-beli (murni), lib/rbac/resolve.
 * Main Functions: GET ?customerNo=&bulan= (customerNo = kode pelanggan Accurate LENGKAP; bulan 1–12, bawaan 3 = 90 hari).
 * Side Effects: DB read-only. Tidak menulis ke Accurate.
 *
 * Izin = /api/customers/search: `websales.create` (Order Sales) ATAU `order.create` (Order Baru). Salesman HANYA pelanggan cabangnya
 * (cakupanCabang O1; cabang lain 403 CABANG_DI_LUAR_CAKUPAN, faktur tidak dibaca); petugas internal (`order.view`) semua cabang. Galat DB =
 * 500 `RIWAYAT_GAGAL`, bukan daftar kosong. Performa: SATU kueri faktur per pelanggan (indeks customer_no); raw_data hanya dibuka untuk
 * faktur DI DALAM jendela, dan yang keluar dari DB hanya kolom kecil per baris barang (bukan faktur utuh).
 * Definisi rata-rata: lib/riwayat-beli `bulanTeramati`.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { branch, customer, item } from "@/db/schema";
import { alasanBonus, angkaQuery, cakupanCabang, jawabGalat, tolakCabangLain } from "@/lib/order-cabang";
import { todayWita } from "@/lib/insentif-payment-date";
import { BULAN_BAWAAN, jendelaRiwayat, ringkasRiwayat } from "@/lib/riwayat-beli";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

const galat = (status: number, kode: string, error: string) => NextResponse.json({ ok: false, kode, error }, { status });

type BarisSql = { paling_awal: string | null; faktur: string | null; tanggal: string | null; ada_rincian: boolean | null;
    code: string | null; nama: string | null; satuan: string | null; qty: string | null; harga: string | null };

export async function GET(request: NextRequest) {
    const gate = await resolveRequestPermissions(request);
    if (gate.response) return gate.response;
    if (!gate.perms?.has("websales.create") && !gate.perms?.has("order.create")) {
        return galat(403, "TIDAK_DIIZINKAN", "Akses riwayat beli pelanggan tidak diizinkan");
    }
    const p = request.nextUrl.searchParams;
    const customerNo = (p.get("customerNo") ?? "").trim();
    // `?? bawaan` saja akan menelan "bulan=x" (angkaQuery -> undefined = TIDAK valid), jadi null (kosong) dibedakan dari tidak valid.
    const bulanQ = angkaQuery(p.get("bulan"));
    const bulan = bulanQ === null ? BULAN_BAWAAN : bulanQ;
    if (!customerNo || customerNo.length > 80 || bulan === undefined || bulan < 1 || bulan > 12) {
        return galat(400, "INPUT_TIDAK_VALID", "customerNo wajib (kode pelanggan Accurate); bulan 1–12");
    }

    try {
        const scope = await cakupanCabang(String(gate.session?.user?.id ?? ""), gate.perms);
        if ("galat" in scope) return jawabGalat(scope.galat);
        const [pel] = await db.select({
            customerNo: customer.customerNo, name: customer.name, branchId: customer.branchId,
            branchName: sql<string | null>`coalesce(${branch.name}, ${customer.branchName})`, suspended: customer.suspended,
        }).from(customer).leftJoin(branch, eq(branch.id, customer.branchId)).where(eq(customer.customerNo, customerNo)).limit(1);
        if (!pel) return galat(409, "PELANGGAN_TIDAK_ADA", `Pelanggan ${customerNo} tidak ada di master Accurate hasil sync.`);
        if (pel.branchId === null) return galat(409, "PELANGGAN_TANPA_CABANG", `Pelanggan ${customerNo} belum punya cabang di Accurate.`);
        const cabang = pel.branchId;
        const luar = tolakCabangLain(scope.cakupan, cabang, `Pelanggan ${customerNo}`);
        if (luar) return jawabGalat(luar);
        if (pel.suspended) return galat(409, "PELANGGAN_SUSPENDED", `Pelanggan ${customerNo} (${pel.name}) nonaktif (suspended) di Accurate; tidak bisa diorder.`);

        const jendela = jendelaRiwayat(todayWita(new Date()), bulan);
        // `f` = semua faktur toko (hanya id + tanggal, untuk tanggal data paling awal); raw_data dibuka hanya untuk faktur di jendela (`w`).
        // `trans_date` TEKS dd/MM/yyyy dari Accurate; bentuk lain dilewati (to_date tidak dipanggil padanya). raw_data = STRING JSON di kolom
        // jsonb (lib/sync) -> `#>> '{}'` lalu ::jsonb (objek juga terbaca). Satu baris per baris barang; faktur tanpa `detailItem` (list.do)
        // = satu baris ber-`code` null; tak ada faktur di jendela = satu baris `faktur` null (tetap membawa `paling_awal`).
        const res = await db.execute(sql`
            WITH f AS (
                SELECT id, to_date(trans_date, 'DD/MM/YYYY') AS tgl FROM sales_invoice
                WHERE customer_no = ${pel.customerNo} AND trans_date ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
            ), w AS (
                SELECT f.id, f.tgl, (s.raw_data #>> '{}')::jsonb -> 'detailItem' AS rinci
                FROM f JOIN sales_invoice s ON s.id = f.id
                WHERE f.tgl BETWEEN ${jendela.dari}::date AND ${jendela.sampai}::date
            )
            SELECT (SELECT min(tgl) FROM f)::text AS paling_awal, w.id::text AS faktur, w.tgl::text AS tanggal,
                coalesce(jsonb_typeof(w.rinci) = 'array', false) AS ada_rincian, d.code, d.nama, d.satuan, d.qty, d.harga
            FROM (SELECT 1) AS satu
            LEFT JOIN w ON true
            LEFT JOIN LATERAL (
                SELECT coalesce(x -> 'item' ->> 'no', x ->> 'itemNo') AS code, coalesce(x -> 'item' ->> 'name', x ->> 'detailName') AS nama,
                    x -> 'itemUnit' ->> 'name' AS satuan, x ->> 'quantity' AS qty, x ->> 'unitPrice' AS harga
                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.rinci) = 'array' THEN w.rinci ELSE '[]'::jsonb END) AS x
            ) AS d ON true`);
        const rows = res.rows as BarisSql[];
        const hasil = ringkasRiwayat(rows.map((r) => ({ faktur: r.faktur, tanggal: r.tanggal, adaRincian: r.ada_rincian === true,
            code: r.code, nama: r.nama, satuan: r.satuan, qty: r.qty, harga: r.harga })), { ...jendela, bulan, palingAwal: rows[0]?.paling_awal ?? null });

        // Barang yang KINI tak bisa diorder (tidak ada / suspended / tanpa cabang = non-jual / cabang lain) tetap tampil, bertanda: aturan
        // SAMA dengan barang order (alasanBonus = syarat barang order O1, dipakai juga untuk bonus promo).
        const kode = [...new Set(hasil.items.map((x) => x.code))];
        const master = kode.length ? await db.select({
            no: item.no, name: item.name, branchId: item.branchId, suspended: item.suspended, tag: item.charField2, branchName: branch.name,
        }).from(item).leftJoin(branch, eq(branch.id, item.branchId)).where(inArray(item.no, kode)) : [];
        const ada = new Map(master.map((r) => [r.no, r]));
        return NextResponse.json({
            ok: true,
            pelanggan: { customerNo: pel.customerNo, name: pel.name, branchId: cabang, branchName: pel.branchName ?? "" },
            jendela: hasil.jendela, ringkasan: hasil.ringkasan,
            items: hasil.items.map((x) => {
                const alasan = alasanBonus(ada.get(x.code), cabang);
                return { ...x, name: ada.get(x.code)?.name || x.name, bisaDiorder: alasan === null, alasan };
            }),
        });
    } catch (e) {
        console.error("[riwayat-beli] gagal membaca riwayat:", e instanceof Error ? e.message : e);
        return galat(500, "RIWAYAT_GAGAL", "Riwayat beli toko gagal dibaca dari database (bukan berarti toko belum pernah beli). Coba lagi.");
    }
}
