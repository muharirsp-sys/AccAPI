/*
 * Tujuan: Helper murni wizard Pelunasan (Fiori S6e-2b, it02 #16–19): isi berkas (BG, transfer tanpa bank, potongan), pemeriksaan langkah
 *   Akun (BG/potongan wajib bila berkas memuatnya; penanda ISI_KODE_AKUN_ tidak boleh lolos), rencana kirim dari pratinjau ganda (baris
 *   ditahan vs diizinkan Finance → kunci override lock), label alasan/hasil, dan hitungan langkah Hasil.
 * Caller: app/(dashboard)/pelunasan/*; lib/pelunasan-wizard.test.ts.
 * Dependensi: lib/pelunasan (sel, tipe PetaAkun & pratinjau ganda), lib/sales-receipt-fingerprint, lib/sales-receipt-upload (override, penanda akun).
 * Main Functions: bersihkanHeader, isiBerkas, periksaAkun, petaDari, rencanaKirim, LABEL_ALASAN, LABEL_DILEWATI, LABEL_HASIL, hitungHasil,
 *   paketDari, LABEL_STATUS_SERVER, terapkanPenyelesaian, nilaiUang, barisLaporanHasil.
 * Side Effects: tidak ada (murni).
 */
import { getTextVal, getVal, type Bebas } from "./pelunasan/sel.ts";
import type { PetaAkun } from "./pelunasan/alokasi.ts";
import type { DuplicateConflictReason, DuplicateReviewEntry } from "./pelunasan/pratinjau-ganda.ts";
import type { BarisHasil, HasilKirim } from "./pelunasan/kirim.ts";
import { buildSalesReceiptIdempotencyPayload } from "./sales-receipt-fingerprint.ts";
import { PLACEHOLDER_AKUN, overrideKeysNeeded } from "./sales-receipt-upload.ts";

/** Header "(*wajib)" dibuang — sama dengan Konsol AOL. */
export const bersihkanHeader = (rows: Bebas[]): Bebas[] => rows.map((row) => {
    const bersih: Bebas = {};
    for (const key in row) bersih[key.replace(/\s\(\*wajib\)$/i, "").trim()] = row[key];
    return bersih;
});

const nominal = (row: Bebas, kolom: string) => Number(getVal(row, kolom)) || 0;

export type IsiBerkas = { baris: number; bg: number; trfTanpaBank: number; pot: [number, number, number] };

/**
 * Jumlah baris yang menuntut akun di langkah Akun.
 * ponytail: aturan bank transfer menyalin lib/pelunasan/alokasi.ts (Ket. Trf berisi MAYBANK/PRMT/PERMATA = bank tetap). Bila aturan
 * itu berubah di lib, ubah juga di sini; uji pelunasan-wizard.test.ts mengunci bentuknya.
 */
export function isiBerkas(rows: Bebas[]): IsiBerkas {
    const isi: IsiBerkas = { baris: 0, bg: 0, trfTanpaBank: 0, pot: [0, 0, 0] };
    for (const row of rows) {
        if (!getTextVal(row, "Code Outlet") && !getTextVal(row, "No. Nota")) continue;
        isi.baris += 1;
        if (nominal(row, "BG") > 0) isi.bg += 1;
        if (nominal(row, "Trf") > 0) {
            const ket = String(getVal(row, "Ket. Trf") || getVal(row, "Ket.TF") || "").toUpperCase();
            if (!ket.includes("MAYBANK") && !ket.includes("PRMT") && !ket.includes("PERMATA")) isi.trfTanpaBank += 1;
        }
        (["Pot.1 Kwtnsi", "Pot.2 Kwtnsi", "Pot.3 Kwtnsi"] as const).forEach((kolom, i) => { if (nominal(row, kolom) > 0) isi.pot[i] += 1; });
    }
    return isi;
}

export type Akun = { tunai: string; trf: string; bg: string; pot1: string; pot2: string; pot3: string };
export const AKUN_KOSONG: Akun = { tunai: "", trf: "", bg: "", pot1: "", pot2: "", pot3: "" };

/** Galat per isian langkah Akun; objek kosong = boleh lanjut. */
export function periksaAkun(akun: Akun, isi: IsiBerkas): Partial<Record<keyof Akun, string>> {
    const galat: Partial<Record<keyof Akun, string>> = {};
    const wajib: Array<[keyof Akun, number, string]> = [
        ["trf", isi.trfTanpaBank, "baris transfer tanpa bank Maybank/Permata di Ket. Trf"],
        ["bg", isi.bg, "baris berisi BG"],
        ["pot1", isi.pot[0], "baris berisi Pot.1 Kwtnsi"],
        ["pot2", isi.pot[1], "baris berisi Pot.2 Kwtnsi"],
        ["pot3", isi.pot[2], "baris berisi Pot.3 Kwtnsi"],
    ];
    for (const [k, n, apa] of wajib) if (n > 0 && !akun[k].trim()) galat[k] = `Wajib: ${n} ${apa}.`;
    for (const k of Object.keys(akun) as Array<keyof Akun>) {
        if (akun[k].toUpperCase().includes(PLACEHOLDER_AKUN)) galat[k] = "Isi nomor akun Accurate yang sebenarnya; penanda akun kosong tidak boleh dikirim.";
    }
    return galat;
}

/** Penomoran "Otomatis": AutoNumber kosong = bawaan lib (Accurate memberi nomor). Rekening Tunai kosong = bawaan lib. */
export const petaDari = (a: Akun): PetaAkun => ({
    mapTunaiAutoNum: "", mapTunaiBank: a.tunai.trim(),
    mapTrfAutoNum: "", mapTrfBank: a.trf.trim(),
    mapBgAutoNum: "", mapBgBank: a.bg.trim(),
    mapPot1Account: a.pot1.trim(), mapPot2Account: a.pot2.trim(), mapPot3Account: a.pot3.trim(),
});

const DIKUNCI: DuplicateConflictReason[] = ["ALREADY_SUCCESS", "STILL_PROCESSING", "UNKNOWN_OUTCOME"];
const RIWAYAT: DuplicateConflictReason[] = ["ACCURATE_HISTORY", "ACCURATE_HISTORY_UNREADABLE"];

export type Override = { allowDuplicateKeys: string[]; allowLockedKeys: string[]; allowHistoryKeys: string[] };

/**
 * Baris payload yang dikirim + yang ditahan. Baris tinjauan `recommended` (baris pertama ganda-dalam-berkas) ikut tanpa izin; baris
 * tinjauan lain hanya ikut bila Finance mengizinkannya (`diizinkan` = reviewId). Kunci override = yang BENAR-BENAR dipakai server.
 */
export function rencanaKirim(payload: Bebas[], review: DuplicateReviewEntry[], diizinkan: ReadonlySet<string>) {
    const tinjau = new Map(review.map((r) => [r.originalIndex, r]));
    const kirim: Bebas[] = [];
    const ditahan: DuplicateReviewEntry[] = [];
    payload.forEach((row, i) => {
        const r = tinjau.get(i);
        if (!r || r.recommended || diizinkan.has(r.reviewId)) kirim.push(row);
        else ditahan.push(r);
    });
    const izin = review.filter((r) => !r.recommended && diizinkan.has(r.reviewId));
    // Override ACCURATE_HISTORY menutup juga riwayat TAK TERBACA (kontrak §1); satu override riwayat per baris final berkunci itu (§2).
    const override: Override = overrideKeysNeeded(
        kirim.map((row) => buildSalesReceiptIdempotencyPayload(row).key),
        izin.filter((r) => r.reasons.includes("DUPLICATE_IN_UPLOAD")).map((r) => r.key),
        izin.filter((r) => r.reasons.some((x) => DIKUNCI.includes(x))).map((r) => r.key),
        izin.filter((r) => r.reasons.some((x) => RIWAYAT.includes(x))).map((r) => r.key),
    );
    const perluAlasan = override.allowDuplicateKeys.length + override.allowLockedKeys.length + override.allowHistoryKeys.length > 0;
    /** Kirim ulang terkendali (takeover Finance, kontrak §5 hint "takeover"): baris yang kiriman sebelumnya belum pasti/berjalan/terposting. */
    const takeover = izin.filter((r) => r.reasons.some((x) => DIKUNCI.includes(x)));
    return { kirim, ditahan, izin, override, perluAlasan, takeover };
}

/** Uang diterima (Σ chequeAmount; dokumen Ayat Silang saling meniadakan). */
export const nilaiUang = (rows: Bebas[]) => rows.reduce((t, r) => t + (Number(r.chequeAmount) || 0), 0);

export const LABEL_ALASAN: Record<DuplicateConflictReason, string> = {
    DUPLICATE_IN_UPLOAD: "Ganda di berkas ini",
    ALREADY_SUCCESS: "Sudah pernah terposting dari aplikasi ini",
    STILL_PROCESSING: "Masih dikirim dalam 15 menit terakhir",
    UNKNOWN_OUTCOME: "Kiriman sebelumnya belum pasti; cek Accurate dulu",
    ACCURATE_HISTORY: "Mirip pelunasan yang sudah ada di Accurate",
    ACCURATE_HISTORY_UNREADABLE: "Riwayat pelunasan di Accurate tidak terbaca (belum tentu aman)",
};

/** Alasan yang dibuka lewat override takeover lock (allowLockedKeys) = kirim ulang terkendali. */
export const butuhTakeover = (r: Pick<DuplicateReviewEntry, "reasons">) => r.reasons.some((x) => DIKUNCI.includes(x));

export const LABEL_DILEWATI: Record<string, string> = {
    KODE_OUTLET_KOSONG: "Code Outlet kosong",
    TANPA_NOMINAL: "Tanpa nominal (Tunai, Trf, BG, dan potongan kosong)",
};

export const LABEL_HASIL: Record<HasilKirim, { label: string; tone: "pos" | "neg" | "warn" }> = {
    terposting: { label: "Terposting", tone: "pos" },
    gagal: { label: "Gagal · tidak terkirim", tone: "neg" },
    tidak_pasti: { label: "Tidak pasti", tone: "warn" },
    ditahan: { label: "Ditahan · menunggu Finance", tone: "warn" },
};

export function hitungHasil(rows: Array<Pick<BarisHasil, "outcome">>) {
    const n: Record<HasilKirim, number> = { terposting: 0, gagal: 0, tidak_pasti: 0, ditahan: 0 };
    for (const r of rows) n[r.outcome] += 1;
    return n;
}

/** Nomor paket (urut, unik) yang memuat baris dengan hasil itu — untuk kalimat "paket 2" di Hasil. */
export const paketDari = (rows: Array<Pick<BarisHasil, "outcome" | "paket">>, outcome: HasilKirim) =>
    [...new Set(rows.filter((r) => r.outcome === outcome).map((r) => r.paket))].sort((a, b) => a - b);

/** Status idempotency_log di server (kontrak §4/§6) → kalimat. */
export const LABEL_STATUS_SERVER: Record<string, string> = {
    UNKNOWN: "Tidak pasti", SENDING: "Mengirim", PROCESSING: "Dikunci, belum dikirim", SUCCESS: "Terposting", FAILED: "Tidak terkirim (boleh diulang)",
};

/** Keputusan server untuk baris Tidak pasti: hasil Selesaikan, atau status SUCCESS/FAILED yang terbaca saat pencarian. */
export type Penyelesaian = { status: "SUCCESS" | "FAILED"; nomor: string[]; pesan: string };
export const KODE_DISELESAIKAN = "DISELESAIKAN";

/** Hasil baris sesudah diselesaikan: SUCCESS = terposting (nomor), FAILED = tidak ada di Accurate (Gagal, boleh dikirim ulang). */
export function terapkanPenyelesaian(h: BarisHasil | undefined, index: number, s: Penyelesaian | undefined): BarisHasil | undefined {
    if (!s) return h;
    const paket = h?.paket ?? 0;
    return s.status === "SUCCESS"
        ? { index, paket, outcome: "terposting", code: KODE_DISELESAIKAN, receiptNumbers: s.nomor, message: `Diselesaikan: terposting${s.nomor.length ? ` ${s.nomor.join(", ")}` : ""}` }
        : { index, paket, outcome: "gagal", code: KODE_DISELESAIKAN, message: "Diselesaikan: tidak ada di Accurate — boleh dikirim ulang lewat Pelunasan baru." };
}

export const fakturDari = (row: Bebas) => (Array.isArray(row.detailInvoice) ? row.detailInvoice : []).map((d: Bebas) => String(d.invoiceNo ?? "")).filter(Boolean);

/** Laporan per baris (Excel atas permintaan): baris terkirim + hasilnya, lalu baris yang ditahan di Tinjau. */
export function barisLaporanHasil(kirim: Bebas[], hasil: Array<Pick<BarisHasil, "index" | "paket" | "outcome" | "message" | "receiptNumbers">>, ditahan: DuplicateReviewEntry[]) {
    const per = new Map(hasil.map((h) => [h.index, h]));
    return [
        ...kirim.map((row, i) => {
            const h = per.get(i);
            return {
                "Code Outlet": String(row.customerNo ?? ""), "Faktur": fakturDari(row).join(", "), "Metode": String(row.paymentMethod ?? ""),
                "Uang diterima": Number(row.chequeAmount) || 0, "Paket": h?.paket || "", "Hasil": h ? LABEL_HASIL[h.outcome].label : "Tidak pasti",
                "Nomor Accurate": (h?.receiptNumbers ?? []).join(", "), "Keterangan": h?.message ?? "Tanpa hasil dari server; cek Accurate sebelum mengulang.",
            };
        }),
        ...ditahan.map((r) => ({
            "Code Outlet": r.customerNo, "Faktur": r.invoiceNo, "Metode": r.paymentMethod, "Uang diterima": Number(r.row.chequeAmount) || 0, "Paket": "",
            "Hasil": "Dilewati · potensi ganda", "Nomor Accurate": r.matchedReceiptNumbers.join(", "), "Keterangan": r.reasons.map((x) => LABEL_ALASAN[x]).join("; "),
        })),
    ];
}
