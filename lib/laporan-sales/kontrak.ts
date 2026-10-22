/*
 * Tujuan: Kontrak bersama layar /laporan-sales (owner 20 Okt 2026: 6 laporan murah padanan EskaLink DMS3SFA, peta
 *   scratch/eskalink-dms3sfa/PETA-LAYAR-2026-10-20.md). Satu tab = satu slice; tab, izin, rute API, dan bentuk jawaban dikunci di sini.
 * Caller: app/(dashboard)/laporan-sales/* (halaman + tab), app/api/laporan-sales/<tab>/route.ts, lib/laporan-sales/<tab>.ts.
 * Dependensi: tidak ada (murni).
 * Main Functions: TAB, tabTerlihat, bulanSah, rentangBulan.
 * Side Effects: Tidak ada.
 * Izin = kunci LAMA (tanpa kunci baru): sales_history.view (cakupan History Penjualan = seluruh perusahaan), insentif_sales.view_all
 *   (target insentif semua orang), supervisor_review.view (per salesman, cakupan hierarki lewat resolveScope seperti Supervisor Review).
 * "Cabang" = cabang Accurate (customer.branch_name / sales_daily_progress.branch) — di perusahaan ini = divisi principal (HEINZ, MSM, …).
 */

export type TabId = "top30" | "harian" | "target" | "drop-size" | "coverage" | "tidak-order";

export const TAB: ReadonlyArray<{ id: TabId; label: string; izin: string; api: string }> = [
    { id: "top30", label: "Top 30", izin: "sales_history.view", api: "/api/laporan-sales/top30" },
    { id: "harian", label: "Monitoring Harian", izin: "supervisor_review.view", api: "/api/laporan-sales/harian" },
    { id: "target", label: "Target vs Realisasi", izin: "insentif_sales.view_all", api: "/api/laporan-sales/target" },
    { id: "drop-size", label: "Drop Size", izin: "sales_history.view", api: "/api/laporan-sales/drop-size" },
    { id: "coverage", label: "Coverage Ganda", izin: "supervisor_review.view", api: "/api/laporan-sales/coverage" },
    { id: "tidak-order", label: "Tidak Order", izin: "supervisor_review.view", api: "/api/laporan-sales/tidak-order" },
];

/** Izin halaman = salah satu kunci tab (lib/rbac.ts pagePermissions /laporan-sales `anyOf`). */
export const IZIN_HALAMAN = [...new Set(TAB.map((t) => t.izin))];

export const tabTerlihat = (perms: ReadonlySet<string>) => TAB.filter((t) => perms.has(t.izin));

/** `?bulan=YYYY-MM` (wajib di semua API yang berperiode). */
export const bulanSah = (v: unknown): v is string => typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/** Rentang bulan: jumlah hari + pola `trans_date` Accurate (dd/MM/yyyy) untuk `LIKE '%/MM/YYYY'`. */
export function rentangBulan(bulan: string): { tahun: number; bulan: number; hari: number; polaTransDate: string } {
    const [t, b] = bulan.split("-").map(Number);
    return { tahun: t, bulan: b, hari: new Date(Date.UTC(t, b, 0)).getUTCDate(), polaTransDate: `%/${String(b).padStart(2, "0")}/${t}` };
}

/** Props setiap komponen tab (app/(dashboard)/laporan-sales/tab/*.tsx). */
export type PropsTab = { bulan: string };

// ── Jawaban API per tab (JSON 200). Galat: { error: string } dengan 400 (parameter) / 401 / 403 / 500. ──────────────────

/** GET /api/laporan-sales/top30?bulan&principle?&urut=nilai|qty — sumber SQLite History Penjualan (lib/sales-history). */
export type BarisTop30 = { peringkat: number; kode: string; nama: string; nilai: number; qty: number; faktur: number };
export type JawabanTop30 = { bulan: string; principle: string | null; urut: "nilai" | "qty"; pilihanPrincipal: string[]; produk: BarisTop30[]; pelanggan: BarisTop30[] };

/** GET /api/laporan-sales/harian?bulan&cabang? — faktur INV Postgres sales_invoice (dpp), cakupan resolveScope. */
export type BarisHarian = { custNo: string; custNama: string; salesCode: string | null; salesNama: string | null; cabang: string; mtd: number; perHari: number[] };
export type JawabanHarian = { bulan: string; hari: number; pilihanCabang: string[]; baris: BarisHarian[]; fakturTanpaDpp: number };

/** GET /api/laporan-sales/target?bulan — target insentif vs realisasi DPP per cabang × principal (hitungan lib/insentif-sales). */
export type BarisTarget = { cabang: string; principle: string; salesman: number; target: number; realisasi: number; persen: number | null };
/** Sama dengan dashboard Insentif: realisasi HANYA untuk salesman × principal bertarget (bukan kantor); sisanya di `tanpaTarget`, tidak di baris/total. */
export type JawabanTarget = {
    bulan: string; baris: BarisTarget[]; total: { target: number; realisasi: number; persen: number | null };
    tanpaTarget: { kombinasi: number; realisasi: number };
};

/** GET /api/laporan-sales/drop-size?bulan&cabang? — nilai per faktur per tipe outlet (customer.category_name). */
export type BarisDropSize = { tipe: string; toko: number; faktur: number; nilai: number; dropSize: number; nilaiPerToko: number };
export type JawabanDropSize = { bulan: string; pilihanCabang: string[]; baris: BarisDropSize[] };

/** GET /api/laporan-sales/coverage?principle? — toko JKS aktif yang dilayani > 1 salesman (principal sama), cakupan resolveScope. */
export type SalesmanCoverage = { salesCode: string; salesNama: string; hari: string; minggu: string };
export type BarisCoverage = { custCode: string; custName: string; principle: string; salesman: SalesmanCoverage[] };
export type JawabanCoverage = { pilihanPrincipal: string[]; totalToko: number; baris: BarisCoverage[] };

/** GET /api/laporan-sales/tidak-order?bulan&cabang? — kunjungan Form Kontrol tanpa order, per alasan (no_order_reason), cakupan resolveScope. */
export type BarisAlasan = { kode: string; label: string; kategori: string; jumlah: number };
export type JawabanTidakOrder = { bulan: string; kunjungan: number; tidakOrder: number; alasan: BarisAlasan[]; perSalesman: { salesCode: string; salesNama: string; jumlah: number }[] };
