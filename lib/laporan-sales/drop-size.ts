/*
 * Tujuan: Agregasi MURNI laporan Drop Size per tipe outlet (padanan EskaLink "Drop Size by Type Outlet"): kelompok hasil SQL (cabang × tipe)
 *   -> baris per tipe + total tertimbang. Tanpa DB/server supaya aman diimpor klien (tab) dan uji. SQL-nya ada di route (sengaja di luar berkas
 *   ini: mengimpor lib/db ke sini akan menyeret pg ke bundel klien).
 * Caller: app/api/laporan-sales/drop-size/route.ts (susunDropSize), app/(dashboard)/laporan-sales/tab/DropSize.tsx (totalDropSize), drop-size.test.ts.
 * Dependensi: lib/laporan-sales/kontrak (tipe BarisDropSize saja).
 * Main Functions: susunDropSize, totalDropSize.
 * Side Effects: Tidak ada.
 * Aturan: nilai = Σ dpp faktur INV ber-dpp; faktur dpp null TIDAK dihitung di toko/faktur/nilai (hanya dihitung terpisah di `fakturTanpaDpp`).
 *   dropSize = nilai/faktur, nilaiPerToko = nilai/toko, pembagi 0 -> 0. Total drop size = Σnilai/Σfaktur (tertimbang), BUKAN rata-rata baris.
 */
import type { BarisDropSize, JawabanDropSize } from "./kontrak";

export const TANPA_TIPE = "Tanpa tipe";
export const TANPA_CABANG = "Tanpa cabang";

/** Jawaban API = kontrak + jumlah faktur yang DPP-nya belum terbaca (tidak ada di kontrak; ekstra, tidak mengubahnya). */
export type JawabanDropSizeLengkap = JawabanDropSize & { fakturTanpaDpp: number };

/** Satu kelompok hasil SQL GROUP BY cabang, tipe. `toko`/`faktur`/`nilai` hanya dari faktur ber-dpp; `tanpaDpp` = faktur dpp null. */
export type KelompokMentah = { cabang: string | null; tipe: string | null; toko: number; faktur: number; nilai: number; tanpaDpp: number };

const bagi = (a: number, b: number) => (b > 0 ? a / b : 0);
const bulat2 = (n: number) => Math.round(n * 100) / 100;
const bersih = (v: string | null, pengganti: string) => v?.trim() || pengganti;
const baris = (tipe: string, toko: number, faktur: number, nilai: number): BarisDropSize =>
    ({ tipe, toko, faktur, nilai: bulat2(nilai), dropSize: bagi(nilai, faktur), nilaiPerToko: bagi(nilai, toko) });

/**
 * Kelompok SQL -> jawaban. `cabang` null = semua cabang; selain itu hanya kelompok cabang itu ("Tanpa cabang" = pelanggan tak tertaut).
 * `pilihanCabang` selalu dari SEMUA kelompok (cabang yang punya faktur bulan itu), bukan hanya yang lolos saringan.
 * Toko dijumlah antarkelompok: satu customerNo = satu pelanggan = satu cabang & satu tipe, jadi kelompok tidak beririsan.
 */
export function susunDropSize(mentah: KelompokMentah[], cabang: string | null): { pilihanCabang: string[]; baris: BarisDropSize[]; fakturTanpaDpp: number } {
    const pilihanCabang = [...new Set(mentah.map((k) => bersih(k.cabang, TANPA_CABANG)))].sort((a, b) => a.localeCompare(b, "id"));
    const perTipe = new Map<string, { toko: number; faktur: number; nilai: number }>();
    let fakturTanpaDpp = 0;
    for (const k of mentah) {
        if (cabang !== null && bersih(k.cabang, TANPA_CABANG) !== cabang) continue;
        fakturTanpaDpp += k.tanpaDpp;
        const tipe = bersih(k.tipe, TANPA_TIPE);
        const a = perTipe.get(tipe) ?? { toko: 0, faktur: 0, nilai: 0 };
        perTipe.set(tipe, { toko: a.toko + k.toko, faktur: a.faktur + k.faktur, nilai: a.nilai + k.nilai });
    }
    const hasil = [...perTipe]
        .filter(([, a]) => a.faktur > 0) // kelompok yang semua fakturnya dpp null = tak ada angka untuk ditampilkan
        .map(([tipe, a]) => baris(tipe, a.toko, a.faktur, a.nilai))
        .sort((a, b) => b.nilai - a.nilai || a.tipe.localeCompare(b.tipe, "id"));
    return { pilihanCabang, baris: hasil, fakturTanpaDpp };
}

/** Baris TOTAL: Σ toko/faktur/nilai, drop size = Σnilai/Σfaktur (tertimbang), nilai per toko = Σnilai/Σtoko. */
export const totalDropSize = (rows: BarisDropSize[]): BarisDropSize =>
    baris("Total", rows.reduce((s, r) => s + r.toko, 0), rows.reduce((s, r) => s + r.faktur, 0), rows.reduce((s, r) => s + r.nilai, 0));
