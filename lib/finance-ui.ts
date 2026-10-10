/*
 * Tujuan: Keputusan murni layar Finance (Fiori S6b): izin tombol di SATU tempat (matriks D-01 sedang disusun), status transfer
 *   terpisah dari status posting (catatan FastAPI + attempt server), kunci per baris (BL-05/BL-49, tidak pasti, data usang),
 *   kapan "Tidak ada di Accurate" boleh dipilih, dan penyaring catatan lama. Tanpa HTTP.
 * Caller: app/(dashboard)/finance/{Finance,posting}.tsx/ts, finance-ui.test.ts.
 * Dependensi: lib/finance-post-status (postStatusNote, teks C11), lib/promo-ui (tgl), tipe Tone.
 * Main Functions: izinFinance, statusTransfer, statusPosting, kunciBaris, alasanTidakAda, saringCatatan, catatanPosting, alasanFaktur.
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
    targetDbId: string;
    ageSeconds: number;
    createdAtWita: string;
    updatedAtWita: string;
    message: string;
};

export type KodePosting = "belum" | "sedang" | "terposting" | "tidak_pasti" | "gagal";

export const LABEL_POSTING: Record<KodePosting, { label: string; tone: Tone }> = {
    belum: { label: "Belum diposting", tone: "neu" },
    sedang: { label: "Sedang diposting", tone: "info" },
    terposting: { label: "Terposting", tone: "pos" },
    tidak_pasti: { label: "Posting tidak pasti", tone: "warn" },
    gagal: { label: "Posting gagal", tone: "neg" },
};

export type StatusPosting = { kode: KodePosting; nomor: string; catatanTertinggal: boolean };

/**
 * Status POSTING gabungan catatan FastAPI (`accurate_post_status` efektif: "failed" lama bergalat ambigu sudah = unknown di server)
 * dan attempt server terbaru. Attempt `sending` segar = sedang diposting sesi/tab lain; `stale` = TIDAK PASTI (bukan "sedang").
 * Attempt `posted` sementara catatan belum = terposting dengan catatan tertinggal (browser ditutup sebelum mencatat) — menekan
 * posting lagi hanya mencatat hasilnya (server menjawab 409 posted record yang sama, tidak mengirim ulang).
 */
export function statusPosting(row: { accurate_post_status?: string; accurate_purchase_payment_number?: string }, attempt: AttemptFinance | null | undefined): StatusPosting {
    const ledger = String(row.accurate_post_status || "");
    const a = attempt?.status;
    if (a === "sending") return { kode: "sedang", nomor: "", catatanTertinggal: false };
    if (ledger === "posted") return { kode: "terposting", nomor: row.accurate_purchase_payment_number || attempt?.accurateNumber || "", catatanTertinggal: false };
    if (a === "posted") return { kode: "terposting", nomor: attempt?.accurateNumber || "", catatanTertinggal: true };
    if (ledger === "unknown" || a === "unknown" || a === "stale") return { kode: "tidak_pasti", nomor: "", catatanTertinggal: false };
    if (ledger === "failed" || a === "failed") return { kode: "gagal", nomor: "", catatanTertinggal: false };
    return { kode: "belum", nomor: "", catatanTertinggal: false };
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
    const tidakPasti = kode === "tidak_pasti" || p.kunciLokal;
    const terposting = kode === "terposting";
    return {
        posting: sedang
            ?? (terposting && !catatanTertinggal ? "Sudah terposting di Accurate. Pembatalan lewat dokumen pembalik di Accurate." : undefined)
            ?? (tidakPasti ? "Posting tidak pasti: Finance memeriksa Accurate lalu menyelesaikannya sebelum posting lagi." : undefined)
            ?? p.sumber ?? p.izin.posting,
        status: sedang
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

/** Faktur yang bisa diposting: ada, dan tidak kosong/BELUM ADA (aturan normalizePurchasePaymentPayload server). */
export function alasanFaktur(detail: Array<{ invoiceNo: string }> | undefined): string | undefined {
    if (!detail?.length) return "Pengajuan tanpa faktur; lengkapi di Pembayaran sebelum posting.";
    const salah = detail.filter((d) => { const n = String(d.invoiceNo || "").trim().toUpperCase(); return !n || n === "BELUM ADA"; }).length;
    return salah ? `${salah} faktur bernomor kosong/BELUM ADA; lengkapi di Pembayaran sebelum posting.` : undefined;
}
