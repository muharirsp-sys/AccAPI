/*
 * Tujuan: Helper murni wizard Pelunasan (Fiori S6e-2b, it02 #16–19): baca Form Kerja Inc harian (baris header, nama kolom, tanggal laporan),
 *   isi berkas per jenis pelunasan, pemeriksaan langkah Akun (rekening/akun wajib bila berkas memuat jenisnya; penanda ISI_KODE_AKUN_ tidak
 *   boleh lolos), ringkasan Kelompok pelunasan di Tinjau, rencana kirim dari pratinjau ganda (baris ditahan vs diizinkan Finance → kunci
 *   override lock), label alasan/hasil, dan hitungan langkah Hasil.
 * Caller: app/(dashboard)/pelunasan/*; lib/pelunasan-wizard.test.ts.
 * Dependensi: lib/pelunasan (sel, akun, tipe PetaAkun & pratinjau ganda), lib/excel-date, lib/sales-receipt-fingerprint,
 *   lib/sales-receipt-upload (override, penanda akun).
 * Main Functions: bersihkanHeader, cariBarisHeader, tanggalLaporan, isiBerkas, periksaAkun, petaDari, ringkasKelompok, rencanaKirim,
 *   LABEL_ALASAN, LABEL_DILEWATI, LABEL_HASIL, hitungHasil, paketDari, LABEL_STATUS_SERVER, terapkanPenyelesaian, nomorTerposting, nilaiUang,
 *   barisLaporanHasil.
 * Side Effects: tidak ada (murni).
 */
import { getTextVal, getVal, type Bebas } from "./pelunasan/sel.ts";
import type { PetaAkun } from "./pelunasan/alokasi.ts";
import { AKUN_BAWAAN, LABEL_AKUN, bankTransfer, jenisPotLain, namaRekening, type AkunPelunasan } from "./pelunasan/akun.ts";
import type { DuplicateConflictReason, DuplicateReviewEntry } from "./pelunasan/pratinjau-ganda.ts";
import type { BarisHasil, HasilKirim } from "./pelunasan/kirim.ts";
import { buildSalesReceiptIdempotencyPayload } from "./sales-receipt-fingerprint.ts";
import { PLACEHOLDER_AKUN, overrideKeysNeeded } from "./sales-receipt-upload.ts";
import { excelDateToIso } from "./excel-date.ts";

const rapat = (v: unknown) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Nama kolom yang dibaca mesin (lib/pelunasan/alokasi.ts, parser.ts). Kolom berkas dicocokkan tanpa spasi/titik/huruf besar, jadi
 * Form Kerja Inc harian ("Ket.Trf", "Biaya Trf/BG", "No.SRB RT Ktr", "Pot.RT Gt", "Pot.Lain", "Ket.ALL Trx") terbaca sama dengan
 * Format Pelunasan lama ("Ket. Trf", "BiayaTrf/BG", "No.SRB Rt Ktr", "Pot. RT Gt", "Pot. Lain", "Ket. All Trx").
 */
const KOLOM_MESIN = ["Code Outlet", "No. Nota", "Tunai", "Trf", "Ket. Trf", "BG", "Ket.BG", "Pot.DiscTB", "Pot.1 Kwtnsi", "Pot.2 Kwtnsi",
    "Pot.3 Kwtnsi", "Ket Kwitansi", "BiayaTrf/BG", "Pot.RT Ktr", "No.SRB Rt Ktr", "Pot. RT Gt", "No.RJS RT Gt", "Pot. Lain", "Ket. Pot",
    "Ket. All Trx", "Total Pot", "Total.Trx", "Saldo", "Sisa"];
const ALIAS_KOLOM = new Map<string, string>([...KOLOM_MESIN.map((k) => [rapat(k), k] as [string, string]), ["KETTF", "Ket. Trf"], ["KETPOTONG", "Ket. Pot"],
    // Form Kerja Inc: "6_Saldo" = sisa piutang sebelum baris ini, "6_Sisa" = sesudahnya (dipakai cek "sudah diinput di Accurate").
    ["6SALDO", "Saldo"], ["6SISA", "Sisa"]]);

/** Header "(*wajib)" dibuang (sama dengan Konsol AOL) dan nama kolom disamakan ke nama yang dibaca mesin. */
export const bersihkanHeader = (rows: Bebas[]): Bebas[] => rows.map((row) => {
    const bersih: Bebas = {};
    for (const key in row) {
        const polos = key.replace(/\s\(\*wajib\)$/i, "").trim();
        const nama = ALIAS_KOLOM.get(rapat(polos)) ?? polos;
        // Dua kolom berkas bernama setara: yang pertama berisi menang (kolom kosong tidak menimpa).
        if (nama in bersih && (bersih[nama] ?? "") !== "" && (row[key] ?? "") === "") continue;
        bersih[nama] = row[key];
    }
    return bersih;
});

/**
 * Baris header (indeks dari baris pertama `aoa`) = baris pertama yang memuat "Code Outlet" dan "No. Nota". Form Kerja Inc harian
 * (laporan AR "New Laporan AR\DD.xlsx") punya tanggal, baris kosong, dan baris total di atas header; Format Pelunasan lama = 0. -1 = tidak ada.
 */
export function cariBarisHeader(aoa: unknown[][]): number {
    for (let i = 0; i < Math.min(aoa.length, 30); i++) {
        const sel = new Set((aoa[i] ?? []).map(rapat));
        if (sel.has("CODEOUTLET") && sel.has("NONOTA")) return i;
    }
    return -1;
}

/** Tanggal laporan (YYYY-MM-DD) dari sel tanggal pertama DI ATAS header (Form Kerja Inc: D1). null = tidak ada. */
export function tanggalLaporan(aoa: unknown[][], barisHeader: number): string | null {
    for (let i = 0; i < barisHeader; i++) {
        for (const v of aoa[i] ?? []) {
            // Serial Excel 40000–60000 = 2009–2064; angka lain di atas header adalah total/jumlah, bukan tanggal.
            if (v instanceof Date || (typeof v === "number" && v >= 40000 && v <= 60000)) return excelDateToIso(v);
        }
    }
    return null;
}

const nominal = (row: Bebas, kolom: string) => Number(getVal(row, kolom)) || 0;

export type JenisIsi = keyof AkunPelunasan | "retur";
export type IsiBerkas = { baris: number; jenis: Record<JenisIsi, { baris: number; nilai: number }> };

/**
 * Baris + nilai per jenis pelunasan (langkah Akun). Aturan bank & Pot. Lain = fungsi yang SAMA dengan mesin (lib/pelunasan/akun.ts).
 * "selisih" baru diketahui saat Tinjau (butuh sisa piutang Accurate), jadi di sini selalu 0.
 */
export function isiBerkas(rows: Bebas[]): IsiBerkas {
    const jenis = Object.fromEntries([...LABEL_AKUN.map((l) => l.k), "retur"].map((k) => [k, { baris: 0, nilai: 0 }])) as IsiBerkas["jenis"];
    const tambah = (k: JenisIsi, nilai: number) => { jenis[k].baris += 1; jenis[k].nilai += nilai; };
    let baris = 0;
    for (const row of rows) {
        if (!getTextVal(row, "Code Outlet") && !getTextVal(row, "No. Nota")) continue;
        baris += 1;
        const tunai = nominal(row, "Tunai"), trf = nominal(row, "Trf"), bg = nominal(row, "BG"), biaya = nominal(row, "BiayaTrf/BG"), potLain = nominal(row, "Pot. Lain");
        if (tunai > 0) tambah("tunai", tunai);
        if (trf > 0) tambah(bankTransfer(String(getVal(row, "Ket. Trf") || "")) ?? "trf", trf);
        if (bg > 0) tambah("bg", bg);
        const kw = nominal(row, "Pot.1 Kwtnsi") + nominal(row, "Pot.2 Kwtnsi") + nominal(row, "Pot.3 Kwtnsi");
        if (kw > 0) tambah("kwitansi", kw);
        if (biaya > 0) tambah(bg > 0 ? "biayaBg" : "biayaTrf", biaya);
        const pl = potLain > 0 ? jenisPotLain(getTextVal(row, "Ket. Pot")) : null;
        if (pl === "ppn") tambah("ppnRetur", potLain);
        if (pl === "klaim") tambah("potLain", potLain);
        const retur = nominal(row, "Pot.RT Ktr") + nominal(row, "Pot. RT Gt") + (pl === "retur" ? potLain : 0);
        if (retur > 0) tambah("retur", retur);
    }
    return { baris, jenis };
}

export type Akun = AkunPelunasan;
/** Isian awal langkah Akun = praktik Accurate (lib/pelunasan/akun.ts); Transfer bank lain sengaja kosong (wajib dipilih bila dipakai). */
export const AKUN_AWAL: Akun = { ...AKUN_BAWAAN };

/** Galat per isian langkah Akun; objek kosong = boleh lanjut. */
export function periksaAkun(akun: Akun, isi: IsiBerkas): Partial<Record<keyof Akun, string>> {
    const galat: Partial<Record<keyof Akun, string>> = {};
    for (const { k, kolom } of LABEL_AKUN) {
        const n = isi.jenis[k]?.baris ?? 0;
        if (n > 0 && !akun[k].trim()) galat[k] = `Wajib: ${n} baris (${kolom}).`;
    }
    for (const k of Object.keys(akun) as Array<keyof Akun>) {
        if (akun[k].toUpperCase().includes(PLACEHOLDER_AKUN)) galat[k] = "Isi nomor akun Accurate yang sebenarnya; penanda akun kosong tidak boleh dikirim.";
    }
    return galat;
}

/** Penomoran otomatis per rekening (lib/pelunasan/akun.ts REKENING). Pot.1–3 Kwitansi memakai satu akun (praktik: semuanya 110512). */
export const petaDari = (a: Akun): PetaAkun => ({
    mapTunaiAutoNum: "", mapTunaiBank: a.tunai.trim(),
    mapTrfAutoNum: "", mapTrfBank: a.trf.trim(),
    mapBgAutoNum: "", mapBgBank: a.bg.trim(),
    mapPot1Account: a.kwitansi.trim(), mapPot2Account: a.kwitansi.trim(), mapPot3Account: a.kwitansi.trim(),
    mapMaybankBank: a.maybank.trim(), mapPermataBank: a.permata.trim(), mapBriBank: a.bri.trim(), mapPpnReturBank: a.ppnRetur.trim(),
    mapPotLainAccount: a.potLain.trim(), mapBiayaTrfAccount: a.biayaTrf.trim(), mapBiayaBgAccount: a.biayaBg.trim(), mapSelisihAccount: a.selisih.trim(),
});

export type BarisKelompok = { kunci: string; kelompok: string; akun: string; nama: string; pelunasan: number; baris: number; nilai: number };

const METODE_KELOMPOK: Record<string, string> = { CASH_OTHER: "Tunai", BANK_TRANSFER: "Transfer", BANK_CHEQUE: "BG / Cek" };

/**
 * Ringkasan Tinjau per kelompok pelunasan: rekening uang (per rekening + metode), potongan per akun, retur (baris negatif), ayat silang.
 * `pelunasan` = dokumen sales-receipt, `baris` = baris faktur/potongan/retur, `nilai` = uang (rekening) atau nominal (potongan/retur).
 */
export function ringkasKelompok(rows: Bebas[]): BarisKelompok[] {
    const m = new Map<string, BarisKelompok>();
    const tambah = (kunci: string, kelompok: string, akun: string, pelunasan: number, baris: number, nilai: number) => {
        const b = m.get(kunci) ?? { kunci, kelompok, akun, nama: namaRekening(akun), pelunasan: 0, baris: 0, nilai: 0 };
        b.pelunasan += pelunasan; b.baris += baris; b.nilai += nilai;
        m.set(kunci, b);
    };
    for (const r of rows) {
        const bank = String(r.bankNo ?? ""), pm = String(r.paymentMethod ?? ""), uang = Number(r.chequeAmount) || 0;
        const faktur = (Array.isArray(r.detailInvoice) ? r.detailInvoice : []) as Bebas[];
        const kelompok = bank === "110120" ? (uang < 0 ? "Ayat silang · sisi retur" : "Ayat silang · sisi faktur")
            : pm === "OTHERS" ? (bank === AKUN_BAWAAN.ppnRetur ? "PPN retur" : "Tanpa uang (retur/potongan)")
                : METODE_KELOMPOK[pm] ?? pm;
        // Sisi retur ayat silang hanya berisi baris negatif; selebihnya yang dihitung baris faktur (positif).
        tambah(`U|${bank}|${kelompok}`, kelompok, bank, 1, faktur.filter((d) => (uang < 0 ? Number(d.paymentAmount) < 0 : Number(d.paymentAmount) > 0)).length, uang);
        if (bank === "110120") continue;
        for (const d of faktur) {
            if (Number(d.paymentAmount) < 0) tambah("R", "Retur (baris negatif)", "", 0, 1, -Number(d.paymentAmount));
            for (const p of (Array.isArray(d.detailDiscount) ? d.detailDiscount : []) as Bebas[]) {
                const akun = String(p.accountNo ?? p.discountNotes ?? "");
                tambah(`P|${akun}`, "Potongan", akun, 0, 1, Number(p.amount) || 0);
            }
        }
    }
    const urut = (b: BarisKelompok) => (b.kunci.startsWith("U") ? 0 : b.kunci.startsWith("P") ? 1 : 2);
    return [...m.values()].sort((a, b) => urut(a) - urut(b) || a.akun.localeCompare(b.akun));
}

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
    TANPA_NOMINAL: "Tanpa nominal (Tunai, Trf, BG, retur, dan potongan kosong)",
    FAKTUR_TIDAK_DITEMUKAN: "No. Nota tidak ditemukan di Accurate (pasti ditolak bila dikirim)",
    SUDAH_DI_ACCURATE: "Sudah diinput di Accurate (sales/admin): sisa piutang = saldo berkas − bayar",
    PERLU_CEK: "Perlu dicek: sisa piutang Accurate tidak sama dengan saldo berkas maupun sesudah bayar",
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
        // nomor kosong = server sudah SUCCESS tanpa keputusan di dialog ini: nomornya hanya di jejak penyelesaian (kandidat pencarian bukan nomor itu).
        ? { index, paket, outcome: "terposting", code: KODE_DISELESAIKAN, receiptNumbers: s.nomor,
            message: `Diselesaikan: terposting${s.nomor.length ? ` ${s.nomor.join(", ")}` : " (nomor pelunasan Accurate: lihat jejak penyelesaian)"}` }
        : { index, paket, outcome: "gagal", code: KODE_DISELESAIKAN, message: "Diselesaikan: tidak ada di Accurate, jadi boleh dikirim ulang lewat Pelunasan baru." };
}

/**
 * Nomor pelunasan Accurate yang BENAR-BENAR terposting (susulan S6e, tinjauan 2b): keputusan Selesaikan, atau item jawaban bulk-save
 * (`r.number`, bentuk yang sama dibaca lib/apiFetcher). `receiptNumbers` baris Tidak pasti/Ditahan = nomor MIRIP, bukan nomor terposting.
 */
export function nomorTerposting(h: Pick<BarisHasil, "outcome" | "code" | "receiptNumbers" | "item"> | undefined): string[] {
    if (h?.outcome !== "terposting") return [];
    if (h.code === KODE_DISELESAIKAN) return h.receiptNumbers ?? [];
    const n = (h.item as { r?: { number?: unknown } } | undefined)?.r?.number;
    const teks = typeof n === "string" || typeof n === "number" ? String(n).trim() : "";
    return teks ? [teks] : [];
}
/** Nomor pelunasan Accurate yang MIRIP (petunjuk Tidak pasti / alasan Ditahan) — kolom terpisah, tidak pernah "Nomor Accurate". */
const nomorMirip = (h: Pick<BarisHasil, "outcome" | "receiptNumbers"> | undefined) => (h && h.outcome !== "terposting" ? h.receiptNumbers ?? [] : []);

export const fakturDari = (row: Bebas) => (Array.isArray(row.detailInvoice) ? row.detailInvoice : []).map((d: Bebas) => String(d.invoiceNo ?? "")).filter(Boolean);

/** Laporan per baris (Excel atas permintaan): baris terkirim + hasilnya, lalu baris yang ditahan di Tinjau. */
export function barisLaporanHasil(kirim: Bebas[], hasil: Array<Pick<BarisHasil, "index" | "paket" | "outcome" | "message" | "code" | "receiptNumbers" | "item">>, ditahan: DuplicateReviewEntry[]) {
    const per = new Map(hasil.map((h) => [h.index, h]));
    return [
        ...kirim.map((row, i) => {
            const h = per.get(i);
            return {
                "Code Outlet": String(row.customerNo ?? ""), "Faktur": fakturDari(row).join(", "), "Metode": String(row.paymentMethod ?? ""),
                "Uang diterima": Number(row.chequeAmount) || 0, "Paket": h?.paket || "", "Hasil": h ? LABEL_HASIL[h.outcome].label : "Tidak pasti",
                "Nomor Accurate": nomorTerposting(h).join(", "), "Nomor mirip": nomorMirip(h).join(", "),
                "Keterangan": h?.message ?? "Tanpa hasil dari server; cek Accurate sebelum mengulang.",
            };
        }),
        ...ditahan.map((r) => ({
            "Code Outlet": r.customerNo, "Faktur": r.invoiceNo, "Metode": r.paymentMethod, "Uang diterima": Number(r.row.chequeAmount) || 0, "Paket": "",
            "Hasil": "Dilewati · potensi ganda", "Nomor Accurate": "", "Nomor mirip": r.matchedReceiptNumbers.join(", "),
            "Keterangan": r.reasons.map((x) => LABEL_ALASAN[x]).join("; "),
        })),
    ];
}
