/*
 * Tujuan: Menentukan kolom nilai penjualan mana yang dipakai sebagai realisasi Value,
 *   karena tidak semua cabang memakai acuan yang sama.
 * Caller: handler upload closing di app/(dashboard)/insentif-sales/page.tsx.
 * Dependensi: tidak ada (pure).
 * Main Functions: valueSourceForBranch, realisasiValue.
 * Side Effects: none.
 *
 * Aturan (dikonfirmasi user 2026-08-21, ABC ditambahkan 2026-08-29):
 * - Default seluruh cabang: DPP (nilai jual setelah potongan).
 * - VINDA, KINO NON FOOD, MIX NON FOOD, ABC: NILAI_JUAL (sebelum potongan).
 * Selisihnya nyata, bukan pembulatan — pada closing Juli 2026: VINDA 23,1%,
 * MIX NON FOOD 9,9%, KINO NON FOOD 4,0%, ABC 3,3%. Salah kolom = salah pencapaian.
 *
 * Daftarnya BUKAN urutan besar selisih, jadi jangan menambah cabang karena selisihnya besar:
 * HEINZ (19,2%) dan MONTISS (17,5%) selisihnya lebih besar dari KINO NON FOOD tapi tetap DPP
 * (dikonfirmasi user 2026-08-29). Acuannya kesepakatan per principal, bukan angka.
 */

/**
 * Cabang (kolom JENISPRODUK di file closing) yang memakai NILAI_JUAL, bukan DPP.
 * "ABC" = ABC PRESIDENT INDONESIA (ABCPI). Ejaan di file closing "ABC", bukan "ABCPI" —
 * menulis "ABCPI" di sini tidak akan pernah cocok.
 */
const BRANCH_PAKAI_NILAI_JUAL = new Set(["VINDA", "KINO NON FOOD", "MIX NON FOOD", "ABC"]);

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
