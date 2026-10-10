/*
 * Tujuan: Bagian bersama layar Pembayaran & SPPD (Fiori S6a, it08): satu pintu HTTP ke FastAPI (CSRF dari /api/me, kode status
 *   diterjemahkan, jawaban tidak pasti dibedakan dari penolakan), kerangka halaman + subnavigasi (Rekaman · Pengajuan & SPPD · Format SPPD),
 *   dan tautan unduh berkas FastAPI.
 * Caller: app/(dashboard)/payments/{Rekaman,RekamanDialog,FormatSppd}.tsx, cart/[draftId]/Keranjang.tsx, pengajuan/*.tsx.
 * Dependensi: lib/apiBase (dev = localhost:8000), components/fiori/interactive (tipe Load), next/link.
 * Main Functions: baca, tulis, sebab, unduhUrl, RangkaPembayaran, BELUM_PASTI.
 * Side Effects: fetch ke FastAPI (credentials include); GET /api/me untuk token CSRF (disimpan di modul).
 *
 * Kode status, bukan teks: sebagian pesan lama FastAPI berbahasa Inggris ("Forbidden", "CSRF token invalid"), jadi 401/403 selalu
 * memakai kalimat sendiri. 400/404/409 membawa `error` berbahasa Indonesia dari server — ditampilkan apa adanya.
 * Tidak pasti (tulis) = koneksi putus/timeout, status ≥ 500 (juga 500 JSON dari `except Exception` — bisa terjadi SESUDAH tulis), atau
 * badan bukan JSON: mungkin sudah tertulis, mungkin belum — pemanggil memuat ulang dan mengunci tulis, bukan menampilkan HTML mentah.
 * Baca: jawaban 2xx yang bentuknya tidak dikenali (`pick` mengembalikan undefined, mis. tanpa array `data`) = galat, bukan kosong.
 */
"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import type { Load } from "@/components/fiori/interactive";
import { resolveApiBase } from "@/lib/apiBase";

export const API_BASE = resolveApiBase();
// ponytail: tanpa timeout, backend yang menggantung membuat spinner abadi. Angka tetap dari halaman lama: unggah/ajukan ikut
// membuat berkas Excel/DOCX sehingga jauh lebih lama dari baca.
const BACA_MS = 45_000;
const TULIS_MS = 180_000;

export const PESAN_PUTUS = "Server pembayaran tidak terhubung (koneksi putus atau terlalu lama menjawab).";
export const BELUM_PASTI = "Hasilnya belum pasti: server tidak memberi jawaban yang jelas (koneksi putus, server sibuk, atau jawaban rusak). Data dimuat ulang — periksa hasilnya sebelum mengulang.";

type Jawab = { status: number; data: Record<string, unknown> | null };

async function panggil(url: string, init: RequestInit, ms: number): Promise<Jawab> {
    try {
        const res = await fetch(url, { ...init, credentials: "include", cache: "no-store", signal: AbortSignal.timeout(ms) });
        const text = await res.text();
        let data: Record<string, unknown> | null = null;
        try {
            const j: unknown = text ? JSON.parse(text) : null;
            data = j && typeof j === "object" ? (j as Record<string, unknown>) : null;
        } catch { /* bukan JSON → data null */ }
        return { status: res.status, data };
    } catch {
        return { status: 0, data: null };
    }
}

let token = "";
async function csrf(segar = false): Promise<string> {
    if (token && !segar) return token;
    const j = await panggil(`${API_BASE}/api/me`, { method: "GET" }, 15_000);
    token = String(j.data?.csrf_token ?? "");
    return token;
}

/** Kalimat galat menurut kode status; `umum` untuk jawaban tanpa pesan yang bisa dipakai. */
export function sebab(j: Jawab, umum: string): string {
    if (j.status === 0) return `${PESAN_PUTUS} Coba lagi.`;
    if (j.status === 401) return "Sesi login berakhir; masuk ulang lalu coba lagi.";
    if (j.status === 403) return "Server menolak: akun Anda tidak berhak atas aksi ini, atau sesi keamanan halaman kedaluwarsa — muat ulang halaman lalu coba lagi.";
    const err = typeof j.data?.error === "string" ? j.data.error.trim() : "";
    return err || umum;
}

/**
 * GET → Load. Galat TIDAK PERNAH menjadi data kosong: `pick` mengembalikan undefined bila bentuk jawaban tidak dikenali → galat.
 * `nihil404`: 404 penolakan server (`{ok:false, error}`) = "tidak ada" (data null) — mis. draf terpakai. 404 lain (rute tidak ada,
 * proxy) tetap galat.
 */
export async function baca<T>(path: string, pick: (data: Record<string, unknown>) => T | undefined, opsi: { nihil404?: boolean } = {}): Promise<Load<T | null>> {
    const j = await panggil(`${API_BASE}${path}`, { method: "GET" }, BACA_MS);
    if (opsi.nihil404 && j.status === 404 && j.data?.ok === false && typeof j.data.error === "string") return { status: "siap", data: null };
    const isi = j.status >= 200 && j.status < 300 && j.data && j.data.ok !== false ? pick(j.data) : undefined;
    if (isi !== undefined) return { status: "siap", data: isi };
    if (j.status >= 200 && j.status < 300) return { status: "galat", error: "Jawaban server tidak terbaca." };
    return { status: "galat", error: sebab(j, j.data ? "Server pembayaran gagal memuat data." : "Server pembayaran gagal memuat data (jawaban rusak).") };
}

export type HasilTulis =
    | { ok: true; status: number; data: Record<string, unknown> }
    | { ok: false; tidakPasti: boolean; status: number; data: Record<string, unknown> | null; error: string };

/** POST JSON / FormData dengan CSRF. 403 diulang SEKALI dengan token baru: FastAPI menolak CSRF/izin sebelum menulis apa pun. */
export async function tulis(path: string, body: unknown): Promise<HasilTulis> {
    const isForm = body instanceof FormData;
    const kirim = (tok: string) => panggil(`${API_BASE}${path}`, {
        method: "POST",
        body: isForm ? body : JSON.stringify(body),
        headers: { ...(isForm ? {} : { "Content-Type": "application/json" }), ...(tok ? { "X-CSRF-Token": tok } : {}) },
    }, TULIS_MS);
    let j = await kirim(await csrf());
    if (j.status === 403) j = await kirim(await csrf(true));
    if (j.status >= 200 && j.status < 300 && j.data && j.data.ok !== false) return { ok: true, status: j.status, data: j.data };
    const tidakPasti = j.status === 0 || j.status >= 500 || j.data === null;
    return { ok: false, tidakPasti, status: j.status, data: j.data, error: tidakPasti ? BELUM_PASTI : sebab(j, "Server pembayaran gagal memproses permintaan.") };
}

/** URL unduhan FastAPI (`/payments/files/…`, `/payments/export`) — tautan biasa, cookie sesi ikut. */
export const unduhUrl = (path: string) => (path.startsWith("http") ? path : `${API_BASE}${path}`);

/** Daftar rekaman terkunci dari jawaban 409 → "LPB-7 (sudah ditransfer)". */
export function daftarKunci(data: Record<string, unknown> | null): string[] {
    const locked = Array.isArray(data?.locked) ? (data.locked as Array<Record<string, unknown>>) : [];
    return locked.map((x) => `${String(x.no_lpb || x.record_id || "")} (${String(x.reason || "terkunci")})`);
}

type Halaman = "rekaman" | "pengajuan" | "format";
const HALAMAN: Array<{ key: Halaman; label: string; href: string; izin: string }> = [
    { key: "rekaman", label: "Rekaman pembayaran", href: "/payments", izin: "payments.view" },
    // BL-50: sub-halaman di /payments, bukan item menu baru (katalog sidebar tetap 27 item).
    { key: "pengajuan", label: "Pengajuan & SPPD", href: "/payments/pengajuan", izin: "payments.view" },
    { key: "format", label: "Format SPPD", href: "/payments/sppd", izin: "sppd.view" },
];

/** Kerangka halaman Pembayaran: jejak, judul + aksi, keterangan, subnavigasi menurut izin. */
export function RangkaPembayaran({ halaman, judul, deskripsi, aksi, permKeys, children }: {
    halaman: Halaman; judul: ReactNode; deskripsi?: ReactNode; aksi?: ReactNode; permKeys: string[]; children: ReactNode;
}) {
    const terlihat = HALAMAN.filter((h) => permKeys.includes(h.izin));
    const ini = HALAMAN.find((h) => h.key === halaman)!;
    return (
        <div className="fi-page">
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Keuangan</span></li><li><span aria-current="page">{ini.label}</span></li></ol></nav>
                <div className="fi-page-bar"><h1>{judul}</h1><span className="fi-spacer" />{aksi}</div>
                {deskripsi && <p>{deskripsi}</p>}
            </header>
            {terlihat.length > 1 && (
                <nav className="fi-subnav" aria-label="Halaman Pembayaran">
                    {terlihat.map((h) => <Link key={h.key} href={h.href} aria-current={h.key === halaman ? "page" : undefined}>{h.label}</Link>)}
                </nav>
            )}
            {children}
        </div>
    );
}
