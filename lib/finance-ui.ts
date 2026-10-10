/*
 * Tujuan: Keputusan murni layar Finance (Fiori S6b): izin tombol di SATU tempat (matriks D-01 sedang disusun), status transfer
 *   terpisah dari status posting (catatan FastAPI + attempt server), kunci per baris (BL-05/BL-49, tidak pasti, data usang),
 *   kapan "Tidak ada di Accurate" boleh dipilih, dan penyaring catatan lama. Tanpa HTTP.
 * Caller: app/(dashboard)/finance/{Finance,posting}.tsx/ts, finance-ui.test.ts.
 * Dependensi: lib/finance-post-status (postStatusNote, teks C11), lib/promo-ui (tgl), tipe Tone.
 * Main Functions: izinFinance, statusTransfer, statusPosting, kodeTampil, kunciBaris, bedaPengajuan, potongKelompok, alasanTidakAda, saringCatatan, catatanPosting, alasanFaktur.
 * Side Effects: Tidak ada.
 */
import type { Tone } from "@/components/fiori/core";
import { postStatusNote } from "@/lib/finance-post-status";
import { tgl } from "@/lib/promo-ui";

/** undefined = boleh; selain itu alasan nonaktif yang DITAMPILKAN (tanpa nama kunci izin mentah). */
export type IzinFinance = { posting?: string; tujuan?: string; status?: string; selesaikan?: string; ekspor?: string };

const BUTUH_UBAH = "Akun Anda belum berwenang mengubah data Finance; minta admin menambahkan izin ubah Finance ke grup akses Anda.";

/**
 * SATU tempat izin tombol Finance (D-01: owner setuju Claude menyusun draf matriks — ubah pemetaan di sini saja). Mengikuti
 * gerbang server HARI INI, bukan kunci yang terdaftar tetapi belum ditegakkan (finance.post_accurate, upload_proof, export):
 * - posting = command /api/finance/purchase-payment + simpan tujuan + unggah bukti + catatan FastAPI → finance.update;
 * - tujuan (pemasok/rekening) dan bukti = FastAPI /payments/finance/mapping, /proof → finance.update;
 * - status (Belum transfer / Kembalikan ke Pembayaran) = FastAPI /payments/finance/update → finance.update;
 * - selesaikan (posting tidak pasti) = /api/finance/purchase-payment/resolve → finance.resolve_unknown (D-14, hanya Finance);
 * - ekspor = FastAPI /payments/finance/export → finance.view.
 */
export function izinFinance(keys: ReadonlySet<string>): IzinFinance {
    const ubah = keys.has("finance.update") ? undefined : BUTUH_UBAH;
    return {
        posting: ubah && "Akun Anda belum berwenang mencatat transfer dan memposting ke Accurate; minta admin menambahkan izin ubah Finance.",
        tujuan: ubah,
        status: ubah,
        selesaikan: keys.has("finance.resolve_unknown") ? undefined : "Hanya Finance yang berwenang menyelesaikan posting tidak pasti.",
        ekspor: keys.has("finance.view") ? undefined : "Akun Anda belum berwenang melihat data Finance.",
    };
}

/** Status TRANSFER (status_pembayaran) — dipisah dari status posting (it02 #11). */
export function statusTransfer(status: string, tanggal?: string): { label: string; tone: Tone } {
    const s = String(status || "").toLowerCase();
    if (s.includes("ajukan ulang")) return { label: "Dikembalikan ke Pembayaran", tone: "warn" };
    if (s.includes("sudah")) return { label: tanggal ? `Ditransfer ${tgl(tanggal)}` : "Sudah ditransfer", tone: "pos" };
    return { label: "Belum transfer", tone: "info" };
}

/** Bagian jawaban GET /api/finance/purchase-payment/attempts yang dipakai layar (kontrak S6-0e). */
export type AttemptFinance = {
    attemptId: string;
    state: string;
    status: "sending" | "stale" | "posted" | "unknown" | "failed";
    stale: boolean;
    accurateNumber: string;
    actorName: string | null;
    /** Record pengirim (= recordKey). */
    clientRef: string;
    targetDbId: string;
    ageSeconds: number;
    createdAtWita: string;
    updatedAtWita: string;
    message: string;
};

export type KodePosting = "belum" | "sedang" | "terposting" | "tidak_pasti" | "gagal" | "tak_terbaca";

export const LABEL_POSTING: Record<KodePosting, { label: string; tone: Tone }> = {
    belum: { label: "Belum diposting", tone: "neu" },
    sedang: { label: "Sedang diposting", tone: "info" },
    terposting: { label: "Terposting", tone: "pos" },
    tidak_pasti: { label: "Posting tidak pasti", tone: "warn" },
    gagal: { label: "Posting gagal", tone: "neg" },
    tak_terbaca: { label: "Status posting tidak terbaca", tone: "warn" },
};

export type StatusPosting = { kode: KodePosting; nomor: string; catatanTertinggal: boolean };

/**
 * Status POSTING gabungan catatan FastAPI (`accurate_post_status` efektif: "failed" lama bergalat ambigu sudah = unknown di server)
 * dan attempt server terbaru. Attempt `sending` segar = sedang diposting sesi/tab lain; `stale` = TIDAK PASTI (bukan "sedang").
 * Attempt `posted` sementara catatan belum = terposting dengan catatan tertinggal (browser ditutup sebelum mencatat) — menekan
 * posting lagi hanya mencatat hasilnya (server menjawab 409 posted record yang sama, tidak mengirim ulang). Itu HANYA bila attempt
 * milik record ini (`clientRef` = recordKey) di database sesi ini; record lain dengan himpunan faktur sama / database lain = TIDAK
 * PASTI (tinjauan A-3: subjek attempt = himpunan faktur, bukan record).
 */
export function statusPosting(
    row: { accurate_post_status?: string; accurate_purchase_payment_number?: string }, attempt: AttemptFinance | null | undefined,
    milik: { key: string; dbId: string; terbaca?: boolean },
): StatusPosting {
    const ledger = String(row.accurate_post_status || "");
    // Tinjauan B-3: attempt server tak terbaca ≠ "belum diposting". Hanya catatan Finance yang pasti (posted / unknown) tetap berlaku.
    if (milik.terbaca === false && ledger !== "posted" && ledger !== "unknown") return { kode: "tak_terbaca", nomor: "", catatanTertinggal: false };
    const a = attempt?.status;
    if (a === "sending") return { kode: "sedang", nomor: "", catatanTertinggal: false };
    if (ledger === "posted") return { kode: "terposting", nomor: row.accurate_purchase_payment_number || attempt?.accurateNumber || "", catatanTertinggal: false };
    if (a === "posted") {
        const milikSendiri = attempt!.clientRef === milik.key && Boolean(milik.dbId) && attempt!.targetDbId === milik.dbId;
        return milikSendiri ? { kode: "terposting", nomor: attempt!.accurateNumber || "", catatanTertinggal: true } : { kode: "tidak_pasti", nomor: "", catatanTertinggal: false };
    }
    if (ledger === "unknown" || a === "unknown" || a === "stale") return { kode: "tidak_pasti", nomor: "", catatanTertinggal: false };
    if (ledger === "failed" || a === "failed") return { kode: "gagal", nomor: "", catatanTertinggal: false };
    return { kode: "belum", nomor: "", catatanTertinggal: false };
}

/**
 * Kode yang DITAMPILKAN: hasil tidak pasti di tab ini (`kunciLokal`, sebelum server sempat mencatatnya) hanya menggeser baris yang
 * masih tampak belum/gagal. Bila server sudah menunjukkan terposting/sedang/tidak pasti, keadaan server yang berlaku — kalau tidak,
 * "Catat hasil posting" buntu di tab yang sama (tinjauan A-2/B-2).
 */
export function kodeTampil(kode: KodePosting, kunciLokal: boolean): KodePosting {
    return kunciLokal && (kode === "belum" || kode === "gagal" || kode === "tak_terbaca") ? "tidak_pasti" : kode;
}

export type KunciBaris = { posting?: string; status?: string; selesaikan?: string; tujuan?: string };

/**
 * Alasan aksi baris nonaktif, urut dari yang paling menjelaskan. `sumber` = data tidak segar (memuat ulang, gagal dimuat ulang,
 * status posting server tidak terbaca); `kunciLokal` = tab ini baru menerima hasil TIDAK PASTI yang belum diselesaikan.
 * Posting yang sudah/mungkin sudah terjadi tidak bisa dikembalikan ke Pembayaran (BL-05/BL-49; server juga menolak 409).
 */
export function kunciBaris(p: { posting: StatusPosting; izin: IzinFinance; sumber?: string; kunciLokal?: boolean }): KunciBaris {
    const { kode, catatanTertinggal } = p.posting;
    const sedang = kode === "sedang" ? "Sedang diposting dari sesi atau tab lain; tunggu hasilnya lalu muat ulang." : undefined;
    const tidakPasti = kodeTampil(kode, Boolean(p.kunciLokal)) === "tidak_pasti";
    const terposting = kode === "terposting";
    const takTerbaca = kode === "tak_terbaca" && !tidakPasti ? "Status posting dari server tidak terbaca; muat ulang dulu." : undefined;
    return {
        posting: takTerbaca ?? sedang
            ?? (terposting && !catatanTertinggal ? "Sudah terposting di Accurate. Pembatalan lewat dokumen pembalik di Accurate." : undefined)
            ?? (tidakPasti ? "Posting tidak pasti: Finance memeriksa Accurate lalu menyelesaikannya sebelum posting lagi." : undefined)
            ?? p.sumber ?? p.izin.posting,
        status: takTerbaca ?? sedang
            ?? (terposting ? "Sudah terposting; status transfer tidak bisa dikembalikan (BL-05). Pembatalan lewat dokumen pembalik di Accurate." : undefined)
            ?? (tidakPasti ? "Posting tidak pasti; selesaikan dulu sebelum mengubah status transfer." : undefined)
            ?? p.sumber ?? p.izin.status,
        selesaikan: (!tidakPasti ? "Hanya untuk posting tidak pasti." : undefined) ?? sedang ?? p.sumber ?? p.izin.selesaikan,
        tujuan: sedang ?? (terposting && !catatanTertinggal ? "Sudah terposting; tujuan pengajuan ini tidak diubah lagi." : undefined) ?? p.sumber ?? p.izin.tujuan,
    };
}

/**
 * "Tidak ada di Accurate" membuka posting ulang, jadi hanya setelah percobaan basi ≥ 2 menit (Accurate mungkin masih memproses;
 * server menegakkan dengan jam DB). `detikSejakMuat` menambah umur dari GET attempts. Tanpa attempt server (status lama) = boleh.
 */
export function alasanTidakAda(attempt: AttemptFinance | null | undefined, detikSejakMuat: number): string | undefined {
    if (!attempt || attempt.stale) return undefined;
    const sisa = 120 - (attempt.ageSeconds + Math.max(0, detikSejakMuat));
    return sisa <= 0 ? undefined : `Tersedia 2 menit setelah percobaan (±${Math.ceil(sisa / 60)} menit lagi); Accurate mungkin masih memproses.`;
}

/**
 * Catatan/galat lama untuk layar: tanpa ajakan "Coba lagi" (mengulang posting yang tidak pasti = membayar dua kali) dan tanpa
 * alamat server lokal (mis. "localhost:8000").
 */
export function saringCatatan(teks: string | null | undefined): string {
    return String(teks ?? "")
        .replace(/\s*Coba lagi\b\.?/gi, "")
        .replace(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\S*/gi, "server")
        .replace(/\b(?:localhost|127\.0\.0\.1)(?::\d+)?/gi, "server")
        .replace(/\s{2,}/g, " ")
        .trim();
}

/** Kalimat status posting di detail (C11): tidak pasti memakai teks postStatusNote, disaring. */
export function catatanPosting(kode: KodePosting, error: string, raw: string): string {
    if (kode === "tidak_pasti") return saringCatatan(postStatusNote("unknown", saringCatatan(error), raw || "unknown"));
    if (kode === "gagal") return `Posting gagal${error ? `: ${saringCatatan(error)}` : ""}. Boleh diposting ulang setelah diperbaiki.`;
    return "";
}

/**
 * Tinjauan A-6: GET /attempts dipotong per 100 kelompok (batas server) DAN per panjang query (batas baris permintaan/header
 * server/proxy — 414). `params` = potongan query yang sudah di-encode, satu per kelompok; hasil = indeks per permintaan, urutan
 * tetap. Satu kelompok yang sendirian melebihi batas tetap dikirim sendiri (server yang memutuskan).
 */
export function potongKelompok(params: string[], maks = 100, maksKarakter = 6000): number[][] {
    const out: number[][] = [];
    let kini: number[] = [];
    let panjang = 0;
    params.forEach((q, i) => {
        if (kini.length && (kini.length >= maks || panjang + 1 + q.length > maksKarakter)) { out.push(kini); kini = []; panjang = 0; }
        kini.push(i);
        panjang += (panjang ? 1 : 0) + q.length;
    });
    if (kini.length) out.push(kini);
    return out;
}

type PengajuanBanding = {
    total_nilai: number; status_pembayaran: string; accurate_post_status?: string;
    detail_invoices: Array<{ invoiceNo: string; paymentAmount: number }>;
};

/**
 * Tinjauan B-5: baris yang akan ditulis dibaca ULANG sebelum langkah tulis pertama. Kembalikan bagian yang berubah (undefined = sama):
 * pengajuan hilang, nilai dibayar, faktur/nilainya, status transfer, atau status posting. Berubah = batal tanpa tulis.
 */
export function bedaPengajuan(lama: PengajuanBanding, kini: PengajuanBanding | undefined): string | undefined {
    if (!kini) return "pengajuan tidak ada lagi di daftar";
    if (Number(lama.total_nilai || 0) !== Number(kini.total_nilai || 0)) return "nilai dibayar";
    const faktur = (x: PengajuanBanding) => (x.detail_invoices || []).map((d) => `${String(d.invoiceNo).trim()}=${Number(d.paymentAmount || 0)}`).sort().join("|");
    if (faktur(lama) !== faktur(kini)) return "faktur atau nilainya";
    if (String(lama.status_pembayaran || "") !== String(kini.status_pembayaran || "")) return "status transfer";
    if (String(lama.accurate_post_status || "") !== String(kini.accurate_post_status || "")) return "status posting";
    return undefined;
}

/** Faktur yang bisa diposting: ada, dan tidak kosong/BELUM ADA (aturan normalizePurchasePaymentPayload server). */
export function alasanFaktur(detail: Array<{ invoiceNo: string }> | undefined): string | undefined {
    if (!detail?.length) return "Pengajuan tanpa faktur; lengkapi di Pembayaran sebelum posting.";
    const salah = detail.filter((d) => { const n = String(d.invoiceNo || "").trim().toUpperCase(); return !n || n === "BELUM ADA"; }).length;
    return salah ? `${salah} faktur bernomor kosong/BELUM ADA; lengkapi di Pembayaran sebelum posting.` : undefined;
}
