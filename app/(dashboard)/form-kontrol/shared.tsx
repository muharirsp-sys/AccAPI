/*
 * Tujuan: Tipe, konstanta, dan helper bersama Form Kontrol (shell, tab tim, tab salesman, kunjungan).
 * Caller: form-kontrol/FormKontrol.tsx (shell), tabs/*, spv-dashboard/DashboardSpv.tsx, visit/[custCode]/*.
 * Dependensi: React (context izin), components/fiori/interactive (tipe Load).
 * Main Functions: TABS, hariIniWita, jamWita, IzinFkCtx/useIzinFk/alasanIzinFk, ambilFk, tulisFk, compareRoute, visitDurationMin.
 * Side Effects: ambilFk/tulisFk melakukan HTTP ke /api/form-kontrol/*; sisanya pure.
 */
"use client";

import { createContext, useContext } from "react";
import type { Load } from "@/components/fiori/interactive";

// ── Types ──────────────────────────────────────────────────────────────────

export interface Scope {
    role: string;
    salesCode?: string;
    salesName?: string;
    principle?: string;
    spvName?: string;
    smName?: string;
    allowedSalesCodes: string[] | null;
    allowedSpvIds?: string[] | null;
}

export interface JksRow {
    id: string;
    salesCode: string;
    salesName: string;
    custCode: string;
    custName: string;
    market: string;
    alamat: string;
    kota: string;
    hariKunjungan: string;
    mingguPattern: "ganjil" | "genap" | "all";
    area: string;
    rayon: string;
    principle: string;
    visitFrequency: 1 | 2 | 4;
    isActive: boolean;
}

export interface AoRow {
    id: string;
    salesCode: string;
    custCode: string;
    custName: string;
    principle: string;
    status: "ordered" | "active" | "not_order" | "not_visited" | "priority";
    orderValueDpp: number;
    isPriority: boolean;
    noOrderReasonCode?: string;
    noOrderNote?: string;
    monthlyOrderCount: number;
    needsAttention: boolean;
    checkinAt?: string | null;   // ISO — null = belum check-in hari ini
    checkoutAt?: string | null;  // ISO — non-null = kunjungan selesai
}

export interface Reason {
    id: string;
    reasonCode: string;
    label: string;
    category: string;
}

export interface FreqRow {
    custCode: string;
    custName: string;
    mingguPattern: string;
    visitFrequency: number;
    actualVisits: number;
    overVisit: boolean;
}

export type TabKey = "jks" | "ao" | "no-order" | "laporan" | "briefing" | "sm-control" | "frekuensi" | "hierarki";

// ── Constants ──────────────────────────────────────────────────────────────

export const TABS: { key: TabKey; label: string; roles: string[] }[] = [
    { key: "jks", label: "Kontrol JKS", roles: ["admin", "manager", "admin_sales", "sm", "spv"] },
    { key: "ao", label: "Form AO Harian", roles: ["salesman", "spv", "staff", "admin", "manager"] },
    { key: "no-order", label: "Toko Tidak Order", roles: ["salesman", "spv", "sm", "staff", "admin", "manager"] },
    // Tab Merchandising lama dihapus (S5): merch bagian wizard kunjungan (ber-foto/GPS); SPV melihat hasilnya di Dashboard SPV.
    { key: "laporan", label: "Laporan Harian", roles: ["salesman", "spv", "staff", "admin", "manager"] },
    { key: "briefing", label: "Briefing SPV", roles: ["spv", "sm", "admin", "manager"] },
    { key: "sm-control", label: "Kontrol SM", roles: ["sm", "admin", "manager"] },
    { key: "frekuensi", label: "Frekuensi Kunjungan", roles: ["admin", "manager", "admin_sales", "sm"] },
    { key: "hierarki", label: "Hierarki Sales", roles: ["admin", "manager"] },
];

/**
 * "Hari ini" (YYYY-MM-DD) dalam WITA (Asia/Makassar) — pengganti `new Date().toISOString().slice(0,10)` (UTC) yang
 * mencatat kemarin sebelum 08.00 WITA. Nilai ini yang DIKIRIM ke server (keputusan orkestrator S5, perubahan perilaku
 * disengaja). ponytail: tanggal tetap dari jam ponsel; penetapan oleh server = BL-28.
 */
export function hariIniWita(now: Date = new Date()): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(now);
}

/** "09.40" dalam WITA dari ISO; "—" bila kosong/tidak valid. Jam di layar selalu WITA (bukan Asia/Jakarta). */
export function jamWita(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Makassar" }).format(d);
}

// ── Izin & HTTP (S5) ───────────────────────────────────────────────────────

/** Izin akun dari server (shell membaca resolveRequestPermissions); tab membaca lewat useIzinFk. */
export const IzinFkCtx = createContext<ReadonlySet<string>>(new Set());
/**
 * Alasan tombol nonaktif bila akun tidak punya izin `form_kontrol.<aksi>`; undefined = boleh.
 * Akun yang sampai ke layar ini lolos my-scope (butuh form_kontrol.view), jadi punya izin form_kontrol dari grup akses. Daftar izin
 * TANPA satu pun kunci form_kontrol (preset peran lama, D-17; admin LOCAL_AUTH_BYPASS kini memegang semua kunci registry) tidak bisa dipercaya → tombol tidak dikunci dan
 * server yang memutuskan (403 tampil di dialog). ponytail: tebakan ini hilang begitu preset lama diaudit (D-17).
 */
export function alasanIzinFk(izin: ReadonlySet<string>, aksi: "view" | "submit" | "manage"): string | undefined {
    if (izin.has(`form_kontrol.${aksi}`) || ![...izin].some((k) => k.startsWith("form_kontrol."))) return undefined;
    return "Akun Anda belum punya izin untuk aksi ini; minta admin menambahkannya ke grup akses.";
}
export function useIzinFk(aksi: "view" | "submit" | "manage"): string | undefined {
    return alasanIzinFk(useContext(IzinFkCtx), aksi);
}

async function bacaJson(res: Response): Promise<Record<string, unknown> | null> {
    const text = await res.text();
    if (!text) return {};
    try {
        const j: unknown = JSON.parse(text);
        return j && typeof j === "object" ? (j as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

/**
 * Pesan `error` route /api/form-kontrol/* yang dikenal → kalimat Indonesia. Pesan lain (Inggris/teknis, 500 "Internal server
 * error", e.message mentah) tidak diteruskan: layar cukup memakai kalimat umum pemanggil, tanpa kode status.
 */
const PESAN_SERVER: Record<string, string> = {
    "SPV name not found": "Akun Anda belum tertaut ke nama SPV di Hierarki Sales.",
    "session must be pagi or sore": "Sesi briefing harus pagi atau sore.",
    "No file provided": "Berkas belum terkirim.",
    "Only image files allowed": "Hanya berkas gambar yang diterima.",
    "Store not found": "Toko tidak ditemukan.",
    "Upload failed": "Unggahan gagal.",
    "salesCode, custCode and principle are required": "Kode sales, kode toko, dan principal wajib diisi.",
    "File tidak ditemukan": "Berkas tidak ikut terkirim.",
    "Sheet kosong": "Sheet pertama berkas kosong.",
    "Tidak ada baris untuk diimport": "Berkas tidak berisi baris untuk diimpor.",
    "Tidak berhak atau laporan belum disubmit": "Anda tidak berhak atas laporan ini, atau laporan belum dikirim salesman.",
    "Ukuran file maksimal 5MB.": "Ukuran berkas maksimal 5 MB.",
};
function pesanServer(res: Response, data: Record<string, unknown> | null): string {
    const e = typeof data?.error === "string" ? data.error : "";
    if (res.status === 401) return " Sesi Anda berakhir; masuk ulang lalu coba lagi.";
    if (res.status === 403 && (!e || e === "Forbidden")) return " Akun Anda tidak punya izin untuk ini.";
    if (res.status >= 500) return "";
    if (e.startsWith("Missing")) return " Data wajib belum lengkap.";
    return PESAN_SERVER[e] ? ` ${PESAN_SERVER[e]}` : "";
}

/** GET → Load. Galat jaringan/HTTP/badan bukan JSON jadi status galat berkalimat Indonesia — tidak pernah tampil sebagai kosong. */
export async function ambilFk<T>(url: string, pick: (json: Record<string, unknown>) => T, umum: string): Promise<Load<T>> {
    try {
        const res = await fetch(url, { cache: "no-store" });
        const data = await bacaJson(res);
        if (!res.ok || data === null) return { status: "galat", error: `${umum}${pesanServer(res, data)}` };
        return { status: "siap", data: pick(data) };
    } catch {
        return { status: "galat", error: `${umum} Server tidak terjangkau — periksa sinyal atau koneksi, lalu coba lagi.` };
    }
}

export const PESAN_TIDAK_PASTI = "Server tidak memberi jawaban yang pasti — hasilnya belum pasti; muat ulang untuk memeriksa sebelum mengulang.";
/** Dilempar tulisFk bila hasil tulis TIDAK PASTI (koneksi putus, status ≥ 502, badan bukan JSON). */
export class TulisTidakPasti extends Error {}

/**
 * POST/PUT ke /api/form-kontrol/*. Objek → JSON; FormData apa adanya. 4xx/500 → throw Error(gagal + pesan server 4xx).
 * Jawaban tidak pasti → throw TulisTidakPasti(PESAN_TIDAK_PASTI), tidak pernah HTML mentah.
 */
export async function tulisFk(url: string, opsi: { method?: "POST" | "PUT"; body: Record<string, unknown> | FormData; gagal: string }) {
    const isForm = typeof FormData !== "undefined" && opsi.body instanceof FormData;
    let res: Response;
    let data: Record<string, unknown> | null;
    try {
        res = await fetch(url, {
            method: opsi.method ?? "POST",
            headers: isForm ? undefined : { "Content-Type": "application/json" },
            body: isForm ? (opsi.body as FormData) : JSON.stringify(opsi.body),
        });
        data = await bacaJson(res);
    } catch {
        throw new TulisTidakPasti(PESAN_TIDAK_PASTI);
    }
    if (res.status >= 502 || data === null) throw new TulisTidakPasti(PESAN_TIDAK_PASTI);
    // `status` ikut dibawa: 4xx = tidak ada yang ditulis; 500 bisa berarti sebagian sudah ditulis (mis. impor JKS per baris).
    if (!res.ok) throw Object.assign(new Error(`${opsi.gagal}${pesanServer(res, data)}`), { status: res.status });
    return data;
}

export const PRINCIPLES = ["GODREJ", "MONTISS", "MUSTIKA RATU", "SOFTEX"];
export const HARI = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];

export const BRIEFING_AGENDA: Record<"pagi" | "sore", string[]> = {
    pagi: [
        "JKS layak dijalankan hari ini",
        "Salesman paham area & rute",
        "Seluruh toko valid & terdaftar",
        "Target AO hari ini dikonfirmasi",
        "Kendala kemarin dibahas",
    ],
    sore: [
        "Toko tidak order diidentifikasi",
        "Toko tidak dikunjungi dicatat",
        "Penyebab utama dibahas",
        "Solusi tindak lanjut disepakati",
        "Laporan salesman di-acknowledge",
    ],
};

// ── Rute (TabAo) ───────────────────────────────────────────────────────────

// urgent-first: belum order naik ke atas, selesai turun ke bawah
function routeRank(r: AoRow): number {
    if (r.checkoutAt) return 4;
    if (r.status === "not_order") return 0;
    if (r.isPriority || r.needsAttention) return 1;
    if (r.status === "ordered" || r.status === "active") return 2;
    return 3;
}

export function compareRoute(a: AoRow, b: AoRow): number {
    return routeRank(a) - routeRank(b) || a.custName.localeCompare(b.custName);
}

export function visitDurationMin(r: AoRow): number | null {
    if (!r.checkinAt || !r.checkoutAt) return null;
    return Math.max(0, Math.round((new Date(r.checkoutAt).getTime() - new Date(r.checkinAt).getTime()) / 60000));
}
