/*
 * Tujuan: Helper murni layar Pembayaran & SPPD (Fiori S6a, it08): status rekaman untuk tile/badge, isian yang kurang sebelum
 *   diajukan (cermin validasi /payments/cart/create), izin aksi → alasan nonaktif, angka ketat, tanggal WITA, dan pratinjau nomor
 *   SPPD. Tidak ada logic bisnis baru — server tetap penentu (kunci `locked_reason`, validasi, nomor).
 * Caller: app/(dashboard)/payments/**, payments-ui.test.ts.
 * Dependensi: lib/insentif-sales-excel (parseLocaleNumber = cermin parse_number_strict), lib/dateFilter (parseAnyDate).
 * Main Functions: statusRekaman, STATUS_REKAMAN, kurangLengkap, bisaDiajukan, angka, ISIAN, nilaiAwal, galatIsian, izinPembayaran,
 *   tanggalTampil, keYmd, hariIniWita, besokWita, namaAkun, pratinjauNomor, galatTemplat, statusFinance.
 * Side Effects: Tidak ada.
 */
import type { Tone } from "@/components/fiori/core";
import { parseAnyDate } from "@/lib/dateFilter";
import { parseLocaleNumber } from "@/lib/insentif-sales-excel";

/** Baris GET /payments/data (payments.json bagian lpb). Angka uang datang sebagai teks rupiah ("12.500.000") atau angka. */
export type Rekaman = {
    record_id: string;
    tipe_pengajuan?: string; no_lpb?: string; principle?: string;
    invoice_no?: string; invoice?: string; tgl_invoice?: string; jt_invoice?: string;
    jenis_dokumen?: string; nomor_dokumen?: string;
    nilai_invoice?: string | number; nilai_win?: string | number; nilai_win_display?: string; gap_nilai?: string | number;
    tgl_setor?: string; tgl_win?: string; tgl_jtempo_win?: string; jt_win?: string; tgl_terima_barang?: string;
    actual_date?: string; tgl_pembayaran?: string;
    status_pembayaran?: string; submission_id?: string; sppd_no?: string; target_payment_date?: string;
    accurate_post_status?: string; accurate_purchase_payment_number?: string;
    /** "" = boleh diubah/dihapus; selain itu alasan kunci dari server (BL-05/BL-49). UI tidak menebak dari status. */
    locked_reason?: string;
    updated_at?: string; created_by?: string;
};

export type StatusRekaman = "draf" | "siap" | "diajukan" | "ulang" | "transfer";

export const STATUS_REKAMAN: Record<StatusRekaman, { label: string; tone: Tone; catatan: string }> = {
    draf: { label: "Draf · belum lengkap", tone: "neu", catatan: "isian invoice kurang" },
    siap: { label: "Siap diajukan", tone: "info", catatan: "bisa dipilih" },
    diajukan: { label: "Diajukan · belum transfer", tone: "warn", catatan: "menunggu Finance" },
    ulang: { label: "Ajukan ulang", tone: "warn", catatan: "dikembalikan Finance" },
    transfer: { label: "Sudah transfer", tone: "pos", catatan: "terkunci" },
};

const t = (v: unknown) => String(v ?? "").trim();
export const tipeRekaman = (r: Rekaman) => {
    const x = t(r.tipe_pengajuan).toUpperCase();
    return x === "CBD" || x === "NON_LPB" ? x : "LPB";
};

/** Status untuk tile dan badge. "Diajukan" = Belum Transfer + nomor pengajuan (sama dengan `_already_submitted` server). */
export function statusRekaman(r: Rekaman): StatusRekaman {
    const st = t(r.status_pembayaran).toLowerCase();
    if (st === "sudah transfer" || t(r.accurate_post_status) === "posted") return "transfer";
    if (st === "belum transfer" && t(r.submission_id)) return "diajukan";
    if (st === "ajukan ulang") return "ulang";
    return kurangLengkap(r).length ? "draf" : "siap";
}

/**
 * Angka ketat (AM-044): number apa adanya; teks lewat parseLocaleNumber (cermin parse_number_strict Python).
 * NaN = bukan angka — pemanggil WAJIB menolak, bukan menjadikannya 0. Kosong = 0.
 */
export function angka(v: unknown): number {
    if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
    return parseLocaleNumber(t(v));
}

/**
 * Isian yang masih kosong sebelum rekaman bisa diajukan — cermin urutan validasi POST /payments/cart/create
 * (python_backend/routers/payments.py). Server tetap memeriksa ulang (termasuk indikasi LPB ganda yang tidak bisa dicek di layar).
 */
export function kurangLengkap(r: Rekaman): string[] {
    const tipe = tipeRekaman(r);
    const kurang: string[] = [];
    if (!t(r.principle)) kurang.push("Principal");
    if (tipe === "LPB") {
        if (!t(r.no_lpb)) kurang.push("No. LPB");
        if (!t(r.tgl_invoice)) kurang.push("Tanggal invoice");
        if (!t(r.jt_invoice)) kurang.push("Jatuh tempo invoice");
        if (!t(r.invoice_no)) kurang.push("No. invoice");
    }
    if (tipe === "CBD" && !t(r.invoice_no) && !t(r.no_lpb)) kurang.push("No. invoice");
    if (tipe === "NON_LPB") {
        if (!t(r.jenis_dokumen)) kurang.push("Jenis dokumen");
        if (!t(r.nomor_dokumen)) kurang.push("Nomor dokumen");
    }
    const nilai = angka(r.nilai_invoice);
    if (!(nilai > 0)) kurang.push("Nilai invoice");
    return kurang;
}

/** Boleh dicentang untuk keranjang: Siap (atau dikembalikan Finance dan sudah lengkap) dan tidak dikunci server. */
export function bisaDiajukan(r: Rekaman): boolean {
    const st = statusRekaman(r);
    return (st === "siap" || st === "ulang") && !t(r.locked_reason) && kurangLengkap(r).length === 0;
}

/** Status satu rekaman di jalur Finance (detail pengajuan). Posting menang atas status transfer. */
export function statusFinance(statusPembayaran: string, posting: string): { label: string; tone: Tone } {
    if (posting === "posted") return { label: "Terposting", tone: "pos" };
    if (posting === "unknown") return { label: "Posting tidak pasti", tone: "warn" };
    if (posting === "failed") return { label: "Posting gagal", tone: "neg" };
    const st = t(statusPembayaran).toLowerCase();
    if (st === "sudah transfer") return { label: "Sudah transfer", tone: "pos" };
    if (st === "ajukan ulang") return { label: "Dikembalikan Finance", tone: "warn" };
    if (st === "belum transfer") return { label: "Belum transfer", tone: "info" };
    return { label: "Belum diajukan", tone: "neu" };
}

// ── Isian yang boleh diubah dari layar Rekaman ──
export type Isian = "principle" | "invoice_no" | "tgl_invoice" | "jt_invoice" | "jenis_dokumen" | "nomor_dokumen" | "nilai_invoice" | "actual_date" | "tgl_pembayaran";
/** Isian yang boleh diubah di jalur Pembayaran (sama dengan grid lama; No. LPB dan tipe tidak pernah bisa diubah dari layar). */
export const ISIAN: Array<{ key: Isian; label: string; jenis: "teks" | "tanggal" | "angka" }> = [
    { key: "principle", label: "Principal", jenis: "teks" },
    { key: "invoice_no", label: "No. invoice", jenis: "teks" },
    { key: "tgl_invoice", label: "Tanggal invoice", jenis: "tanggal" },
    { key: "jt_invoice", label: "Jatuh tempo invoice", jenis: "tanggal" },
    { key: "nilai_invoice", label: "Nilai invoice", jenis: "angka" },
    { key: "jenis_dokumen", label: "Jenis dokumen", jenis: "teks" },
    { key: "nomor_dokumen", label: "Nomor dokumen", jenis: "teks" },
    { key: "actual_date", label: "Actual date", jenis: "tanggal" },
    { key: "tgl_pembayaran", label: "Tanggal bayar pusat", jenis: "tanggal" },
];
export type Draf = Record<string, Partial<Record<Isian, string>>>;

/** Nilai isian seperti tersimpan, dalam bentuk form (tanggal YYYY-MM-DD). */
export function nilaiAwal(r: Rekaman, k: Isian): string {
    const jenis = ISIAN.find((i) => i.key === k)?.jenis;
    const v = k === "invoice_no" ? r.invoice_no ?? r.invoice : r[k];
    return jenis === "tanggal" ? keYmd(v) : String(v ?? "");
}

/** Galat isian di layar (angka ketat: NaN = blok, minus ditolak). */
export function galatIsian(k: Isian, v: string): string | undefined {
    if (k !== "nilai_invoice") return undefined;
    const n = angka(v);
    if (Number.isNaN(n)) return `“${v}” bukan angka rupiah. Contoh: 12.500.000`;
    if (n < 0) return "Nilai invoice tidak boleh minus.";
    return undefined;
}

// ── Izin (BL-31): tombol tulis mengikuti izin endpoint-nya; tanpa izin = nonaktif dengan alasan terlihat ──
export type AksiPembayaran =
    | "lihat" | "ubah" | "hapus" | "unggah" | "manual" | "keranjang"
    | "lihatSppd" | "setelan" | "restore" | "excelSppd" | "gantiNama" | "unduhSppd";

/** Kunci izin per aksi = yang ditegakkan FastAPI (routers/payments.py, routers/sppd.py, main.py). */
const KUNCI: Record<AksiPembayaran, [string, string]> = {
    lihat: ["payments.view", "melihat rekaman pembayaran"],
    ubah: ["payments.update", "mengubah isian rekaman pembayaran"],
    hapus: ["payments.delete", "menghapus rekaman pembayaran"],
    unggah: ["payments.edit", "mengunggah LPB"],
    manual: ["payments.edit", "menambah pengajuan manual"],
    keranjang: ["payments.edit", "membuat dan mengajukan keranjang"],
    lihatSppd: ["sppd.view", "melihat Format SPPD dan data rekening"],
    setelan: ["sppd.edit_settings", "mengubah setelan dan nomor SPPD"],
    restore: ["sppd.edit_settings", "memulihkan backup (ikut menaikkan nomor SPPD)"],
    excelSppd: ["sppd.upload_excel", "mengunggah Excel data SPPD"],
    gantiNama: ["payments.edit", "mengganti nama principal di rekaman"],
    unduhSppd: ["sppd.download", "mengunduh dokumen SPPD"],
};

/** Alasan nonaktif per aksi (undefined = boleh). Kalimat tugas, tanpa nama kunci mentah. */
export function izinPembayaran(permKeys: Iterable<string>): Record<AksiPembayaran, string | undefined> {
    const punya = new Set(permKeys);
    const out = {} as Record<AksiPembayaran, string | undefined>;
    for (const [aksi, [kunci, kalimat]] of Object.entries(KUNCI) as [AksiPembayaran, [string, string]][]) {
        out[aksi] = punya.has(kunci) ? undefined : `Akun Anda belum punya izin ${kalimat}. Minta admin menambahkannya ke grup Anda.`;
    }
    return out;
}

// ── Tanggal (WITA) ──
/** dd/mm/yyyy dari tanggal tersimpan (YYYY-MM-DD, dd/mm/yyyy, dll.); teks lain apa adanya; kosong = "—". */
export function tanggalTampil(v: unknown): string {
    const p = parseAnyDate(v);
    return p ? `${p.d}/${p.m}/${p.y}` : t(v) || "—";
}

/** Nilai <input type="date"> (YYYY-MM-DD) dari tanggal tersimpan; "" bila tidak terbaca. */
export function keYmd(v: unknown): string {
    const p = parseAnyDate(v);
    return p ? `${p.y}-${p.m}-${p.d}` : "";
}

export const hariIniWita = (now: Date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(now);
/** "Besok" menurut WITA (bawaan tanggal bayar Finance di cart/create), dihitung di klien dan dikirim eksplisit. */
export const besokWita = (now: Date = new Date()) => hariIniWita(new Date(now.getTime() + 864e5));

/** "betterauth|staff|a@x" → "a@x" (identitas sesi FastAPI). */
export const namaAkun = (id: unknown) => t(id).split("|").filter(Boolean).pop() ?? "";

// ── Nomor SPPD ──
const ROMAWI = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
const PLACEHOLDER = /\{(seq(?::0\d+d)?|seq3|roman_month|month|year|yy)\}/g;

/** Templat ditolak bila tanpa nomor urut (semua surat bernomor sama) atau berisi kurung kurawal yang tidak dikenal server. */
export function galatTemplat(template: string): string | undefined {
    const x = t(template);
    if (!x) return "Format nomor wajib diisi.";
    if (!/\{seq(?::0\d+d)?\}|\{seq3\}/.test(x)) return "Format nomor wajib memuat nomor urut, mis. {seq:03d}.";
    if (/[{}]/.test(x.replace(PLACEHOLDER, ""))) return "Format nomor berisi isian yang tidak dikenal. Pakai {seq:03d}, {roman_month}, {year}, {month}, {yy}.";
    return undefined;
}

/** Cermin format_sppd_number_with_template (python_backend/shared.py) untuk pratinjau; tanggal = YYYY-MM-DD WITA. */
export function pratinjauNomor(template: string, seq: number, ymd: string): string {
    const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(ymd);
    if (!m || galatTemplat(template)) return "";
    const bulan = Number(m[2]);
    return t(template).replace(PLACEHOLDER, (_, kunci: string) => {
        if (kunci.startsWith("seq:")) return String(seq).padStart(Number(kunci.slice(4, -1)), "0");
        if (kunci === "seq") return String(seq);
        if (kunci === "seq3") return String(seq).padStart(3, "0");
        if (kunci === "roman_month") return ROMAWI[bulan - 1] ?? "";
        if (kunci === "month") return String(bulan);
        if (kunci === "year") return m[1];
        return m[1].slice(-2);
    });
}
