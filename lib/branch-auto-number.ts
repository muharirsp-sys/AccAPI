/*
 * Tujuan: Memasangkan cabang Accurate dengan seri penomoran Faktur Penjualan miliknya.
 * Caller: lib/sync (setelah modul branch/auto_number selesai), jalur faktur.
 * Dependensi: tidak ada (murni) — sengaja bebas import agar bisa diuji di mana saja.
 * Main Functions: matchBranchAutoNumbers.
 * Side Effects: tidak ada.
 *
 * Kenapa dipasangkan sendiri, bukan diambil dari API: `auto-number/list.do` TIDAK punya
 * field cabang sama sekali dan `auto-number/detail.do` menjawab 404 (probe live 2026-09-09).
 * Satu-satunya kaitan yang tersedia adalah NAMA seri ("Faktur Penjualan Godrej" untuk cabang
 * GODREJ), jadi pemasangannya deterministik di sini dan hasilnya disimpan — bukan ditebak
 * ulang setiap kali faktur dikirim.
 *
 * Cabang tanpa pasangan sengaja dibiarkan kosong. Nomor faktur yang masuk seri cabang lain
 * jauh lebih mahal daripada order yang ditolak.
 */

const SALES_INVOICE_TYPE = "SI";
const PREFIX = "faktur penjualan";

// Beberapa seri memakai singkatan yang tidak akan pernah cocok dengan nama cabang.
// Dipetakan eksplisit, bukan lewat pencocokan samar: singkatan mirip ("MF" vs "MNF")
// justru paling berbahaya kalau ditebak.
const ALIAS: Record<string, string> = {
    "mf": "mix food",
    "mnf": "mix non food",
    "fr": "forisa",
    "fr - mt": "forisa - mt",
};

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

export type BranchRow = { id: number; name: string };
export type AutoNumberRow = { id: number; name: string; transactionType: string; suspended?: boolean };
export type BranchAutoNumberMatch = { branchId: number; branchName: string; autoNumberId: number | null; autoNumberName: string };

export function matchBranchAutoNumbers(branches: BranchRow[], autoNumbers: AutoNumberRow[]): BranchAutoNumberMatch[] {
    // Hanya seri Faktur Penjualan. Di database ini ada seri bernama "Faktur Pembelian ..."
    // yang transactionType-nya ikut "SI" — memakainya berarti faktur penjualan menempel pada
    // penomoran pembelian, jadi prefix nama ikut diperiksa, bukan tipe saja.
    const candidates = new Map<string, AutoNumberRow>();
    for (const row of autoNumbers) {
        if (row.transactionType !== SALES_INVOICE_TYPE || row.suspended) continue;
        const name = normalize(row.name);
        if (!name.startsWith(PREFIX)) continue;
        const tail = name.slice(PREFIX.length).trim();
        const key = ALIAS[tail] ?? tail;
        // Nama seri ganda: yang pertama menang dan sisanya diabaikan, supaya hasilnya tidak
        // bergantung pada urutan baris yang dikembalikan Accurate.
        if (!candidates.has(key)) candidates.set(key, row);
    }

    return branches.map((branch) => {
        const hit = candidates.get(normalize(branch.name));
        return {
            branchId: branch.id,
            branchName: branch.name,
            autoNumberId: hit ? hit.id : null,
            autoNumberName: hit ? hit.name : "",
        };
    });
}
