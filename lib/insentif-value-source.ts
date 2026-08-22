/*
 * Tujuan: Menentukan kolom nilai penjualan mana yang dipakai sebagai realisasi Value,
 *   karena tidak semua cabang memakai acuan yang sama.
 * Caller: handler upload closing di app/(dashboard)/insentif-sales/page.tsx.
 * Dependensi: tidak ada (pure).
 * Main Functions: valueSourceForBranch, realisasiValue.
 * Side Effects: none.
 *
 * Aturan (dikonfirmasi user 2026-08-21):
 * - Default seluruh cabang: DPP (nilai jual setelah potongan).
 * - VINDA, KINO NON FOOD, MIX NON FOOD: NILAI_JUAL (sebelum potongan).
 * Selisihnya nyata, bukan pembulatan — pada closing Juli 2026: VINDA 23,1%,
 * MIX NON FOOD 9,9%, KINO NON FOOD 4,0%. Salah kolom = salah pencapaian.
 */

/** Cabang (kolom JENISPRODUK di file closing) yang memakai NILAI_JUAL, bukan DPP. */
const BRANCH_PAKAI_NILAI_JUAL = new Set(["VINDA", "KINO NON FOOD", "MIX NON FOOD"]);

export type ValueSource = "dpp" | "nilai_jual";

/** Kolom acuan Value untuk satu cabang. Perbandingan case-insensitive & abai spasi ganda. */
export function valueSourceForBranch(branch: string): ValueSource {
    const b = (branch ?? "").trim().toUpperCase().replace(/\s+/g, " ");
    return BRANCH_PAKAI_NILAI_JUAL.has(b) ? "nilai_jual" : "dpp";
}

/**
 * Realisasi Value satu baris closing sesuai cabangnya.
 * Kedua angka tetap diminta supaya pemilihan terjadi di satu tempat — pemanggil tidak
 * perlu tahu aturannya, dan aturan tidak tersebar di parser.
 */
export function realisasiValue(branch: string, dpp: number, nilaiJual: number): number {
    return valueSourceForBranch(branch) === "nilai_jual" ? nilaiJual : dpp;
}
