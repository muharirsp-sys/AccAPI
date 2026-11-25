/**
 * Tujuan: aturan jenis pelunasan → rekening/akun Accurate, SATU sumber untuk mesin (alokasi.ts) dan wizard (langkah Akun, ringkasan
 *   Tinjau). Bawaan dipelajari dari pelunasan nyata di Accurate (CV Surya Perkasa, ±55 ribu pelunasan 25 Agu–7 Nov 2026; 4.206 rincian
 *   dicocokkan per faktur dengan 1.110 baris Form Kerja Inc Sep–Okt 2026, 25 Nov 2026):
 *   - Tunai → 110102 Kas Besar (CASH_OTHER). Trf: Ket. Trf MAYBANK → 110105, PRMT/PERMATA → 110106 (110107 dipakai s.d. ±24 Okt 2026,
 *     sesudahnya 110106), BRI → 110108 (praktik campur: 18 ke 110108, 25 ke 110105; bawaan mengikuti teks berkas). BG/Cek → 110104.
 *   - Potongan di baris faktur: Pot.1–3 Kwitansi dan Pot. Lain klaim (mis. 061/SUPER-ABCPI/04/2026) → 110512 Kwitansi Principal;
 *     Biaya Trf → 600126 Beban Transfer Pelanggan; Biaya BG → 600123 Beban Materai; selisih pembulatan → 600136 Selisih Pembulatan.
 *   - Pot. Lain "PPN RETUR" → pelunasan TERPISAH di 110118 Kas Nota Retur PPN (OTHERS).
 *   - Retur: dokumen retur pelanggan yang sama → baris retur negatif di pelunasan yang sama (271 kasus); beda pelanggan/divisi → pasangan
 *     ayat silang 110120 Kas Retur Others Principal (68 kasus).
 *   AutoNumber = `autoNumberTransactionId` rekening itu di Accurate (dibaca dari bank pada sales-receipt/detail.do).
 * Caller: lib/pelunasan/alokasi.ts, lib/pelunasan-wizard.ts, app/(dashboard)/pelunasan/*.
 * Main Functions: REKENING, AKUN_BAWAAN, LABEL_AKUN, bankTransfer, jenisPotLain, namaRekening.
 * Side Effects: tidak ada (murni).
 */

/** Rekening kas/bank yang terbukti dipakai pelunasan penjualan → nama + id AutoNumber Accurate. */
export const REKENING: Record<string, { nama: string; autoNumber: string }> = {
    "110102": { nama: "Kas Besar", autoNumber: "300" },
    "110104": { nama: "Cek & BG", autoNumber: "550" },
    "110105": { nama: "Bank Maybank 2115003838", autoNumber: "350" },
    "110106": { nama: "Bank Permata 1811863838", autoNumber: "351" },
    "110107": { nama: "Bank Permata 1812023388", autoNumber: "950" },
    "110108": { nama: "Bank BRI 0343.0188.8838.566", autoNumber: "400" },
    "110118": { nama: "Kas Nota Retur PPN", autoNumber: "750" },
    "110120": { nama: "Kas Retur Others Principal", autoNumber: "850" },
};

/** Akun potongan (detailDiscount) yang terbukti dipakai. */
const AKUN_POTONGAN: Record<string, string> = {
    "110512": "Kwitansi Principal",
    "600123": "Beban Materai",
    "600126": "Beban Transfer Pelanggan",
    "600136": "Selisih Pembulatan",
};

export const namaRekening = (no: string) => REKENING[no]?.nama ?? AKUN_POTONGAN[no] ?? "";

/** Isian langkah Akun. Bawaan = praktik Accurate; kosong pada `trf` = wajib diisi bila ada transfer tanpa bank dikenal. */
export type AkunPelunasan = {
    tunai: string; maybank: string; permata: string; bri: string; trf: string; bg: string;
    kwitansi: string; potLain: string; ppnRetur: string; biayaTrf: string; biayaBg: string; selisih: string;
};

export const AKUN_BAWAAN: AkunPelunasan = {
    tunai: "110102", maybank: "110105", permata: "110106", bri: "110108", trf: "", bg: "110104",
    kwitansi: "110512", potLain: "110512", ppnRetur: "110118", biayaTrf: "600126", biayaBg: "600123", selisih: "600136",
};

/** Label + kolom berkas per isian (urutan = urutan tampil di langkah Akun dan ringkasan). */
export const LABEL_AKUN: Array<{ k: keyof AkunPelunasan; label: string; kolom: string; rekening: boolean }> = [
    { k: "tunai", label: "Tunai", kolom: "Tunai", rekening: true },
    { k: "maybank", label: "Transfer Maybank", kolom: "Trf, Ket. Trf berisi MAYBANK atau KELEBIHAN TF", rekening: true },
    { k: "permata", label: "Transfer Permata", kolom: "Trf, Ket. Trf berisi PRMT/PERMATA", rekening: true },
    { k: "bri", label: "Transfer BRI", kolom: "Trf, Ket. Trf berisi BRI", rekening: true },
    { k: "trf", label: "Transfer bank lain", kolom: "Trf, Ket. Trf tanpa bank dikenal", rekening: true },
    { k: "bg", label: "BG / Cek", kolom: "BG", rekening: true },
    { k: "ppnRetur", label: "PPN retur", kolom: "Pot. Lain, Ket. Pot berisi PPN", rekening: true },
    { k: "kwitansi", label: "Potongan kwitansi", kolom: "Pot.1–3 Kwtnsi", rekening: false },
    { k: "potLain", label: "Pot. Lain (klaim)", kolom: "Pot. Lain selain retur/PPN", rekening: false },
    { k: "biayaTrf", label: "Biaya transfer", kolom: "Biaya Trf/BG pada transfer", rekening: false },
    { k: "biayaBg", label: "Biaya BG (materai)", kolom: "Biaya Trf/BG pada BG", rekening: false },
    { k: "selisih", label: "Selisih pembulatan", kolom: "selisih ≤ Rp 100 terhadap sisa piutang", rekening: false },
];

export type BankTransfer = "maybank" | "permata" | "bri" | null;

/**
 * Bank tujuan dari Ket. Trf. ponytail: cocok kata, bukan daftar lengkap. Salah ketik nyata di berkas (MAYBAK, MAYABNK, MAY BANK) ikut
 * Maybank lewat awalan "MAY". "KELEBIHAN TF … AR TGL …" (kelebihan transfer lama dipakai) = Maybank: praktik admin 8 dari 10 kasus
 * Sep–Okt 2026 ke 110105 BANK_TRANSFER (keputusan pengguna 25 Nov 2026: ikuti admin). Bank lain = null → rekening Transfer bank lain.
 */
export function bankTransfer(ket: string): BankTransfer {
    const t = ` ${String(ket || "").toUpperCase()} `;
    if (/\bMAY/.test(t)) return "maybank";
    if (/PRMT|PERMATA/.test(t)) return "permata";
    if (/\bBRI\b/.test(t)) return "bri";
    if (/KELEBIHAN/.test(t)) return "maybank";
    return null;
}

/** Pot. Lain menurut Ket. Pot: retur (RJN/SRT, sudah ditangani mesin retur), PPN retur (rekening 110118), atau klaim (akun potongan). */
export function jenisPotLain(ketPot: string): "retur" | "ppn" | "klaim" {
    const t = String(ketPot || "").toUpperCase();
    if (t.includes("RJN") || t.includes("SRT")) return "retur";
    if (t.includes("PPN")) return "ppn";
    return "klaim";
}
