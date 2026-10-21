/*
 * Tujuan: Laporan Top 30 (tab "Top 30" /laporan-sales): 30 produk dan 30 pelanggan teratas sebulan menurut nilai (DPP) atau qty (setara KRT),
 *   dari SQLite History Penjualan (hanya faktur INV; padanan "Top 30" EskaLink DMS3SFA). Satuan dibaca dari master barang Accurate (Postgres `item`).
 * Caller: app/api/laporan-sales/top30/route.ts; uji lib/laporan-sales/top30.test.ts.
 * Dependensi: lib/sales-history/db (SQLite), lib/db + db/schema (item) + lib/order-cabang (rasioSatuan) — SEMUA dimuat dinamis di
 *   laporanTop30/petaRasio supaya fungsi murni bisa diuji tanpa membuka DB; tipe lib/laporan-sales/kontrak.
 * Main Functions: batasBulan, konversi, agregasi, peringkat, sqlTop30 (murni); laporanTop30 (kueri).
 * Side Effects: DB read-only (sales-history-inv.db + Postgres `item`). Tidak menulis.
 * Rumus: bulan = [awal bulan, awal bulan berikut) pada sales_history_item.tanggal (ISO, = tanggal faktur); nilai = Σ dpp; faktur = COUNT DISTINCT
 *   referensi. Produk = kode_objek (nama = MAX(nama_produk): ganti nama di tengah bulan tidak memecah baris); pelanggan = invoice_map.kode_cust
 *   (nama dari customer_map, cadangan customer_nama faktur). Principal = principal FAKTUR (invoice_map.principal), bukan principal barang.
 * Qty: tiap baris (kode_objek, satuan) dikonversi lewat master barang (unit1 = dasar, ratio2..5 = kelipatan unit1) ke KRT: qty × isi(satuan) ÷ isi(KRT).
 *   Barang tanpa satuan KRT dikonversi ke satuan dasar; satuan/barang yang tak dikenal dibiarkan apa adanya. Baris (produk/pelanggan) yang SEMUA
 *   barisnya setara KRT = `setaraKrt` dan hanya itu yang ikut urut Qty; sisanya dihitung di `tidakSetaraKrt` (strip UI).
 */
import type { BarisTop30, JawabanTop30 } from "@/lib/laporan-sales/kontrak";

export const BATAS = 30;
const KRT = "KRT";

/** Kontrak + `satuan` (daftar satuan hasil konversi) + `setaraKrt` (tambahan murni; JawabanTop30 tetap bisa membacanya). */
export type BarisTop30Satuan = BarisTop30 & { satuan: string[]; setaraKrt: boolean };
export type JawabanTop30Satuan = Omit<JawabanTop30, "produk" | "pelanggan"> & {
    produk: BarisTop30Satuan[]; pelanggan: BarisTop30Satuan[];
    /** Jumlah produk / pelanggan sebulan (bukan hanya 30 teratas) yang tidak setara KRT → tidak ikut urut Qty. */
    tidakSetaraKrt: { produk: number; pelanggan: number };
};

/** kode_objek → { SATUAN_HURUF_BESAR: isi dalam satuan dasar } (hasil rasioSatuan master barang). */
export type Rasio = ReadonlyMap<string, Record<string, number>>;
/** Satu kelompok SQL (pelanggan × kode_objek × satuan mentah). */
export type Detail = { cust: string; kode: string; sat: string; nilai: number; qty: number };
export type Info = ReadonlyMap<string, { nama: string; faktur: number }>;
export type Mentah = { kode: string; nama: string; nilai: number; qty: number; faktur: number; satuan: string[]; setaraKrt: boolean };

/** `2026-12` → [`2026-12-01`, `2027-01-01`): batas bawah termasuk, batas atas tidak. */
export function batasBulan(bulan: string): [string, string] {
    const [t, b] = bulan.split("-").map(Number);
    const p2 = (n: number) => String(n).padStart(2, "0");
    return [`${t}-${p2(b)}-01`, b === 12 ? `${t + 1}-01-01` : `${t}-${p2(b + 1)}-01`];
}

/**
 * Satu baris (qty, satuan) → qty di satuan tujuan. Punya KRT → KRT (`krt` true); tanpa KRT → satuan dasar (isi 1);
 * barang/satuan tak dikenal atau tak ada satuan dasar → apa adanya (tidak pernah menebak rasio).
 */
export function konversi(qty: number, satuan: string, rasio: Record<string, number> | undefined): { satuan: string; qty: number; krt: boolean } {
    const s = satuan.trim().toUpperCase();
    const apaAdanya = { satuan: s || "(kosong)", qty, krt: false };
    const isi = rasio?.[s] ?? 0;
    if (!rasio || !(isi > 0)) return apaAdanya;
    if (rasio[KRT] > 0) return { satuan: KRT, qty: (qty * isi) / rasio[KRT], krt: true };
    const dasar = Object.keys(rasio).find((u) => rasio[u] === 1);
    return dasar ? { satuan: dasar, qty: qty * isi, krt: false } : apaAdanya;
}

/**
 * Gabungkan kelompok SQL per `kunci` (produk = kode_objek, pelanggan = cust). qty = jumlah di satuan tujuan bila hanya satu satuan hasil;
 * bila beberapa (tak setara) = Σ mentah yang tidak boleh dibaca sebagai jumlah (UI menulis "campur"). `setaraKrt` = SEMUA baris terkonversi ke KRT.
 */
export function agregasi(detail: Detail[], rasio: Rasio, kunci: "kode" | "cust", info: Info): Mentah[] {
    const grup = new Map<string, { nilai: number; mentah: number; per: Map<string, number>; krt: boolean }>();
    for (const d of detail) {
        const k = d[kunci];
        const g = grup.get(k) ?? { nilai: 0, mentah: 0, per: new Map<string, number>(), krt: true };
        const c = konversi(d.qty, d.sat, rasio.get(d.kode));
        g.nilai += d.nilai; g.mentah += d.qty; g.krt &&= c.krt;
        g.per.set(c.satuan, (g.per.get(c.satuan) ?? 0) + c.qty);
        grup.set(k, g);
    }
    return [...grup].map(([kode, g]) => ({
        kode, nama: info.get(kode)?.nama ?? kode, nilai: g.nilai, faktur: info.get(kode)?.faktur ?? 0,
        qty: g.per.size === 1 ? [...g.per.values()][0] : g.mentah, satuan: [...g.per.keys()].sort(), setaraKrt: g.krt,
    }));
}

const urutTeks = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Urutkan menurun menurut `urut`, seri ditentukan metrik satunya lalu kode lalu nama (hasil tidak bergantung urutan masukan),
 * ambil `batas` teratas, beri peringkat 1..N. Urut Qty hanya memuat baris `setaraKrt` (qty satuan berbeda tidak sebanding).
 * Pembulatan SESUDAH urut: nilai ke rupiah, qty ke 3 desimal (buang sisa float).
 */
export function peringkat(mentah: Mentah[], urut: "nilai" | "qty", batas = BATAS): BarisTop30Satuan[] {
    const lain = urut === "nilai" ? "qty" : "nilai";
    return (urut === "qty" ? mentah.filter((m) => m.setaraKrt) : [...mentah])
        .sort((a, b) => b[urut] - a[urut] || b[lain] - a[lain] || urutTeks(a.kode, b.kode) || urutTeks(a.nama, b.nama))
        .slice(0, batas)
        .map((m, i) => ({ peringkat: i + 1, kode: m.kode, nama: m.nama, nilai: Math.round(m.nilai), qty: Math.round(m.qty * 1000) / 1000, faktur: m.faktur, satuan: m.satuan, setaraKrt: m.setaraKrt }));
}

/**
 * SQL Top 30 (tiga pindaian bulan: detail untuk nilai+qty, faktur+nama produk, faktur+nama pelanggan). Dipisah supaya teksnya teruji.
 * ponytail: `+im.principal` (unary plus) WAJIB: tanpa itu SQLite memilih idx_im_principal_* dan menyapu semua faktur principal itu sepanjang
 *   tahun (HEINZ ABC: pelanggan 94–184 dtk, dan libsql sinkron ⇒ seluruh proses Next membeku). Dengan plus, penggerak tetap idx_shi_tanggal
 *   (rentang tanggal) lalu invoice_map lewat PK. Jangan "dirapikan" — ada uji yang menjaganya.
 */
export function sqlTop30(principle: string | null) {
    const dari = "FROM sales_history_item shi JOIN invoice_map im ON im.referensi = shi.referensi";
    const syarat = `WHERE shi.tanggal >= ? AND shi.tanggal < ? AND shi.referensi LIKE 'INV/%'${principle ? " AND +im.principal = ?" : ""}`;
    return {
        detail: `SELECT im.kode_cust AS cust, shi.kode_objek AS kode, shi.satuan AS sat, SUM(shi.dpp) AS nilai, SUM(shi.qty) AS qty ${dari} ${syarat} GROUP BY im.kode_cust, shi.kode_objek, shi.satuan`,
        produk: `SELECT shi.kode_objek AS kode, MAX(shi.nama_produk) AS nama, COUNT(DISTINCT shi.referensi) AS faktur ${dari} ${syarat} GROUP BY shi.kode_objek`,
        pelanggan: `SELECT im.kode_cust AS kode, COALESCE(MAX(cm.nama), MIN(shi.customer_nama), im.kode_cust) AS nama, COUNT(DISTINCT shi.referensi) AS faktur
                    ${dari} LEFT JOIN customer_map cm ON cm.kode = im.kode_cust ${syarat} GROUP BY im.kode_cust`,
    };
}

/** Satuan master barang untuk kode yang muncul bulan itu: SATU kueri `item` (server-only). Kode ganda `no` memakai baris dengan satuan terlengkap. */
async function petaRasio(kodes: string[]): Promise<Map<string, Record<string, number>>> {
    const peta = new Map<string, Record<string, number>>();
    if (kodes.length === 0) return peta;
    const [{ db }, { item }, { inArray }, { rasioSatuan }] = await Promise.all([import("@/lib/db"), import("@/db/schema"), import("drizzle-orm"), import("@/lib/order-cabang")]);
    const baris = await db.select({
        no: item.no, unit1Name: item.unit1Name, unit2Name: item.unit2Name, unit3Name: item.unit3Name, unit4Name: item.unit4Name, unit5Name: item.unit5Name,
        ratio2: item.ratio2, ratio3: item.ratio3, ratio4: item.ratio4, ratio5: item.ratio5,
    }).from(item).where(inArray(item.no, kodes));
    for (const b of baris) {
        const r = rasioSatuan(b);
        if (Object.keys(r).length > Object.keys(peta.get(b.no) ?? {}).length) peta.set(b.no, r);
    }
    return peta;
}

// ponytail: tiga pindaian sebulan berjalan BERURUTAN dan SINKRON (libsql lokal, satu proses node): memblokir proses selama kueri, dan
// mengganti "Urut" mengulang pindaian yang sama (hanya sort JS yang beda). Terukur Mei 2026, DB lokal 2,8 GB, cache hangat: tanpa principal
// ±1,9–3,2 dtk (detail 97 rb baris 1,0 + produk 0,4 + pelanggan 0,5; peninjau 3,2), HEINZ ABC ±0,9 dtk. PRODUKSI 21 Okt (container, Okt 2026):
// tanpa principal 1,5–2,1 dtk, HEINZ 0,4 dtk. Ceiling: beberapa pengguna bersamaan / VPS 2 core / bulan
// lebih besar. Jalan naik: memo agregasi (detail+info+rasio) per (bulan, principal) ±60 dtk dalam Map, atau kueri di worker/proses sendiri.
export async function laporanTop30(bulan: string, principle: string | null, urut: "nilai" | "qty"): Promise<JawabanTop30Satuan> {
    const { ensureSalesHistorySchema, salesClient } = await import("@/lib/sales-history/db");
    await ensureSalesHistorySchema();
    const [awal, akhir] = batasBulan(bulan);
    const q = sqlTop30(principle);
    const args = principle ? [awal, akhir, principle] : [awal, akhir];
    const [detail, produk, pelanggan, daftar] = await Promise.all([
        salesClient.execute({ sql: q.detail, args }),
        salesClient.execute({ sql: q.produk, args }),
        salesClient.execute({ sql: q.pelanggan, args }),
        salesClient.execute({ sql: `SELECT DISTINCT principal FROM invoice_map WHERE referensi LIKE 'INV/%' AND tanggal >= ? AND tanggal < ? ORDER BY principal`, args: [awal, akhir] }),
    ]);
    const rows: Detail[] = detail.rows.map((r) => ({ cust: String(r.cust ?? ""), kode: String(r.kode ?? ""), sat: String(r.sat ?? ""), nilai: Number(r.nilai ?? 0), qty: Number(r.qty ?? 0) }));
    const info = (hasil: typeof produk): Info => new Map(hasil.rows.map((r) => [String(r.kode ?? ""), { nama: String(r.nama ?? ""), faktur: Number(r.faktur ?? 0) }]));
    const rasio = await petaRasio([...new Set(rows.map((r) => r.kode))]);
    const mProduk = agregasi(rows, rasio, "kode", info(produk));
    const mPelanggan = agregasi(rows, rasio, "cust", info(pelanggan));
    return {
        bulan, principle, urut,
        pilihanPrincipal: daftar.rows.map((r) => String(r.principal)),
        produk: peringkat(mProduk, urut),
        pelanggan: peringkat(mPelanggan, urut),
        tidakSetaraKrt: { produk: mProduk.filter((m) => !m.setaraKrt).length, pelanggan: mPelanggan.filter((m) => !m.setaraKrt).length },
    };
}
