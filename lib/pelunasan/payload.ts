/**
 * Tujuan: finalisasi payload sales-receipt Pelunasan & laporan baris manual — dipindah UTUH dari W:80-87
 *   (normalizePayloadMoney), W:100-104 (tanggal bawaan; kini WITA), W:1575-1613 `app/(dashboard)/api-wrapper/page.tsx`
 *   basis 5d6cc936 (S6e-1). Perilaku dikunci golden lib/pelunasan/uji/golden.json.
 * Caller: lib/pelunasan/parser.ts, app/(dashboard)/api-wrapper/page.tsx (normalizePayloadMoney untuk self-heal, tanggal bawaan).
 * Main Functions: normalizePayloadMoney, finalisasiPayload, susunBarisManual, pesanPeringatanRetur, tanggalKemarin.
 * Side Effects: tidak ada I/O; finalisasiPayload merapikan angka pada objek payload yang diberikan (seperti kode lama).
 */
import type { Bebas } from "./sel.ts";
import type { PeringatanRetur } from "./alokasi.ts";

export const normalizePayloadMoney = (value: unknown) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    // Simpan presisi sampai 6 desimal agar selisih kecil seperti 0.002 tidak hilang,
    // tapi tetap rapikan noise floating-point Excel.
    const normalized = Number(num.toFixed(6));
    return Math.abs(normalized) < 0.000001 ? 0 : normalized;
};

const WITA_MS = 8 * 60 * 60 * 1000; // WITA = UTC+8 tetap (tanpa DST)
const HARI_MS = 24 * 60 * 60 * 1000;

/**
 * Tanggal transaksi bawaan (YYYY-MM-DD) = KEMARIN menurut WITA, tak bergantung zona peramban. S6e-1: dulu
 * `setDate(-1)` waktu lokal lalu `toISOString()` (UTC) → pukul 00.00–07.59 WITA mundur dua hari.
 */
export const tanggalKemarin = (now: Date = new Date()) => new Date(now.getTime() + WITA_MS - HARI_MS).toISOString().slice(0, 10);

/** W:1575-1591: gabung kelompok bayar + dokumen Ayat Silang, buang yang tanpa faktur, rapikan angka. */
export function finalisasiPayload(kelompok: Bebas[], ayatSilangDocs: Bebas[]) {
    let finalData = kelompok;
    finalData.push(...ayatSilangDocs);
    finalData = finalData.filter((sr: Bebas) => sr.detailInvoice && sr.detailInvoice.length > 0);
    finalData.forEach((sr: Bebas) => {
        if (!sr.typeAutoNumber || sr.typeAutoNumber.trim() === "") delete sr.typeAutoNumber;

        // Rapikan noise floating-point tanpa memotong selisih riil < Rp 1 yang masih penting untuk pelunasan.
        sr.chequeAmount = normalizePayloadMoney(sr.chequeAmount);
        sr.detailInvoice.forEach((dt: Bebas) => {
            if (dt.paymentAmount) dt.paymentAmount = normalizePayloadMoney(dt.paymentAmount);
            if (dt.detailDiscount) {
                dt.detailDiscount.forEach((dd: Bebas) => {
                    if (dd.amount) dd.amount = normalizePayloadMoney(dd.amount);
                });
            }
        });
    });
    return finalData;
}

/** W:1594-1598: teks toast peringatan retur yang belum ketemu. */
export const pesanPeringatanRetur = (unresolvedReturWarnings: PeringatanRetur[]) => {
    const sample = unresolvedReturWarnings
        .slice(0, 3)
        .map((item) => `${item.invoiceNo} [${item.refs.join(" | ")}]`)
        .join(", ");
    return `${unresolvedReturWarnings.length} baris retur yang belum ditemukan di Accurate dilewati sementara. Contoh: ${sample}`;
};

/** W:1601-1613: baris laporan "Retur Manual" (diunduh halaman sebagai Excel). */
export const susunBarisManual = (unresolvedReturWarnings: PeringatanRetur[]) => unresolvedReturWarnings.map((item) => ({
    "Invoice No": item.invoiceNo,
    "Code Outlet": item.customerNo,
    "Referensi Retur/Pot.Lain": item.refs.join(" | "),
    "Nominal SRB Belum Diproses": item.unresolvedSrbAmt,
    "Nominal RJS Belum Diproses": item.unresolvedRjsAmt,
    "Tunai Tetap Diproses": item.tunaiAmt,
    "Transfer Tetap Diproses": item.trfAmt,
    "BG Tetap Diproses": item.bgAmt,
    "Biaya Tetap Diproses": item.biayaBg,
    "Ket. All Trx": item.ketAllTrx,
    "Aksi Manual": "Retur/Pot.Lain perlu diproses manual di Accurate"
}));
