/*
 * Tujuan: Laporan Top 30 (tab "Top 30" /laporan-sales): 30 produk dan 30 pelanggan teratas sebulan menurut nilai (DPP) atau qty,
 *   dari SQLite History Penjualan (hanya faktur INV; padanan "Top 30" EskaLink DMS3SFA).
 * Caller: app/api/laporan-sales/top30/route.ts; uji lib/laporan-sales/top30.test.ts.
 * Dependensi: lib/sales-history/db (salesClient, dimuat dinamis supaya fungsi murni bisa diuji tanpa membuka berkas DB),
 *   tipe lib/laporan-sales/kontrak.
 * Main Functions: batasBulan, peringkat (murni); laporanTop30 (kueri).
 * Side Effects: DB read-only sales-history-inv.db (ensureSalesHistorySchema idempotent). Tidak menulis.
 * Rumus: bulan = [awal bulan, awal bulan berikut) pada sales_history_item.tanggal (ISO, = tanggal faktur); nilai = Σ dpp;
 *   qty = Σ qty; faktur = COUNT DISTINCT referensi. Produk = (kode_objek, nama_produk); pelanggan = invoice_map.kode_cust
 *   (nama dari customer_map, cadangan customer_nama faktur). Principal disaring lewat invoice_map.principal (sama dengan service).
 * Satuan: satu produk/pelanggan hampir selalu memuat beberapa satuan (KRT, PCS, SCH …) dan tidak ada tabel konversi di sini, jadi
 *   Σ qty LINTAS satuan tidak bermakna. Setiap baris membawa `satuan` (daftar satuan yang muncul): qty hanya layak dibaca bila satunya satu.
 */
import type { BarisTop30, JawabanTop30 } from "@/lib/laporan-sales/kontrak";

export const BATAS = 30;

/** Kontrak + `satuan` (tambahan murni; JawabanTop30 tetap bisa membacanya). Lebih dari satu = campur → qty tidak boleh dibaca sebagai jumlah. */
export type BarisTop30Satuan = BarisTop30 & { satuan: string[] };
export type JawabanTop30Satuan = Omit<JawabanTop30, "produk" | "pelanggan"> & { produk: BarisTop30Satuan[]; pelanggan: BarisTop30Satuan[] };

/** Satu kelompok hasil SQL. `satuan` = GROUP_CONCAT(DISTINCT satuan) apa adanya (koma). */
export type Mentah = { kode: string; nama: string; nilai: number; qty: number; faktur: number; satuan: string };

/** `2026-12` → [`2026-12-01`, `2027-01-01`): batas bawah termasuk, batas atas tidak. */
export function batasBulan(bulan: string): [string, string] {
    const [t, b] = bulan.split("-").map(Number);
    const p2 = (n: number) => String(n).padStart(2, "0");
    return [`${t}-${p2(b)}-01`, b === 12 ? `${t + 1}-01-01` : `${t}-${p2(b + 1)}-01`];
}

const urutTeks = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Urutkan menurun menurut `urut`, seri ditentukan metrik satunya lalu kode lalu nama (hasil tidak bergantung urutan masukan),
 * ambil `batas` teratas, beri peringkat 1..N. Pembulatan SESUDAH urut: nilai ke rupiah, qty ke 3 desimal (buang sisa float).
 */
export function peringkat(mentah: Mentah[], urut: "nilai" | "qty", batas = BATAS): BarisTop30Satuan[] {
    const lain = urut === "nilai" ? "qty" : "nilai";
    return [...mentah]
        .sort((a, b) => b[urut] - a[urut] || b[lain] - a[lain] || urutTeks(a.kode, b.kode) || urutTeks(a.nama, b.nama))
        .slice(0, batas)
        .map((m, i) => ({
            peringkat: i + 1, kode: m.kode, nama: m.nama, nilai: Math.round(m.nilai), qty: Math.round(m.qty * 1000) / 1000, faktur: m.faktur,
            satuan: m.satuan.split(",").map((s) => s.trim()).filter(Boolean).sort(),
        }));
}

const SATUAN = "GROUP_CONCAT(DISTINCT COALESCE(NULLIF(shi.satuan, ''), '(kosong)'))";
const METRIK = `SUM(shi.dpp) AS nilai, SUM(shi.qty) AS qty, COUNT(DISTINCT shi.referensi) AS faktur, ${SATUAN} AS satuan`;
const baca = (r: Record<string, unknown>): Mentah => ({
    kode: String(r.kode ?? ""), nama: String(r.nama ?? ""), nilai: Number(r.nilai ?? 0), qty: Number(r.qty ?? 0), faktur: Number(r.faktur ?? 0), satuan: String(r.satuan ?? ""),
});

// ponytail: semua kelompok sebulan ditarik lalu diurut di JS (Mei 2026: 2.371 produk, 4.314 pelanggan; kueri 1,1 dtk dan 3,3 dtk pada DB lokal 2,8 GB).
// Batas: bila satu bulan melewati puluhan ribu pelanggan, pindahkan ORDER BY + LIMIT ke SQL (peringkat() tetap dipakai sebagai pengurut akhir).
export async function laporanTop30(bulan: string, principle: string | null, urut: "nilai" | "qty"): Promise<JawabanTop30Satuan> {
    const { ensureSalesHistorySchema, salesClient } = await import("@/lib/sales-history/db");
    await ensureSalesHistorySchema();
    const [awal, akhir] = batasBulan(bulan);
    // Penggerak = idx_shi_tanggal (rentang tanggal), lalu cari invoice_map lewat PK: 3,7 dtk vs 7,2 dtk bila digerakkan idx_im_tanggal
    // (DB lokal 2,8 GB, produk Mei 2026). Tanggal item = tanggal faktur (0 selisih dari 116.937 baris Mei 2026).
    const dari = `FROM sales_history_item shi JOIN invoice_map im ON im.referensi = shi.referensi`;
    const syarat = `WHERE shi.tanggal >= ? AND shi.tanggal < ? AND shi.referensi LIKE 'INV/%'${principle ? " AND im.principal = ?" : ""}`;
    const args = principle ? [awal, akhir, principle] : [awal, akhir];
    const [produk, pelanggan, daftar] = await Promise.all([
        salesClient.execute({ sql: `SELECT shi.kode_objek AS kode, shi.nama_produk AS nama, ${METRIK} ${dari} ${syarat} GROUP BY shi.kode_objek, shi.nama_produk`, args }),
        salesClient.execute({
            sql: `SELECT im.kode_cust AS kode, COALESCE(MAX(cm.nama), MIN(shi.customer_nama), im.kode_cust) AS nama, ${METRIK}
                  ${dari} LEFT JOIN customer_map cm ON cm.kode = im.kode_cust ${syarat} GROUP BY im.kode_cust`,
            args,
        }),
        salesClient.execute({ sql: `SELECT DISTINCT principal FROM invoice_map WHERE referensi LIKE 'INV/%' AND tanggal >= ? AND tanggal < ? ORDER BY principal`, args: [awal, akhir] }),
    ]);
    return {
        bulan, principle, urut,
        pilihanPrincipal: daftar.rows.map((r) => String(r.principal)),
        produk: peringkat(produk.rows.map(baca), urut),
        pelanggan: peringkat(pelanggan.rows.map(baca), urut),
    };
}
