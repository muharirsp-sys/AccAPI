/*
 * Tujuan: I/O klien wizard Pelunasan (Fiori S6e-2b): sesi Accurate (database aktif), POST JSON yang membedakan jawaban tidak pasti,
 *   pratinjau kunci lock (baca-saja), pencarian Selesaikan, unduh Excel atas permintaan, dan kalimat izin tanpa nama kunci mentah.
 * Caller: Pelunasan.tsx, LangkahKirim.tsx.
 * Dependensi: GET /api/auth/accurate-session, POST /api/idempotency/lock {preview:true}, GET/POST /api/idempotency/resolve,
 *   GET /api/idempotency/summary?rows=1 (kontrak docs/handover/S6e2-KONTRAK-API.md); form-kontrol/lapangan (ambilJson);
 *   principal-order/bersama (baca); xlsx (dimuat saat unduh).
 * Main Functions: bacaSesi, postJson, pratinjauKunci, cariPenyelesaian, simpanPenyelesaian, muatRingkasan, labelDatabase, unduhExcel, ALASAN, tanggalTampil.
 * Side Effects: fetch; unduhExcel menulis berkas lewat peramban.
 */
import type { Load } from "@/components/fiori/interactive";
import { ambilJson } from "@/app/(dashboard)/form-kontrol/lapangan";
import { baca } from "@/app/(dashboard)/principal-order/bersama";

export type Sesi = { connected: boolean; databaseConnected: boolean; databaseId: string | null; databaseAlias: string | null };

export const bacaSesi = (): Promise<Load<Sesi>> => baca("/api/auth/accurate-session", (j) => ({
    connected: Boolean(j.connected),
    databaseConnected: Boolean(j.databaseConnected),
    databaseId: j.databaseId == null ? null : String(j.databaseId),
    databaseAlias: typeof j.databaseAlias === "string" ? j.databaseAlias : null,
}), "Sesi Accurate belum terbaca.");

/** Nama database untuk header/dialog: alias + id (alias saja bisa sama di dua database). */
export const namaDatabase = (s: { databaseAlias: string | null; databaseId: string | null }) =>
    s.databaseAlias ? `${s.databaseAlias} (id ${s.databaseId ?? "?"})` : `database id ${s.databaseId ?? "?"}`;

/**
 * Kontrak `postJson` lib/pelunasan/kirim.ts: `{status, data}` (data null bila bukan JSON, termasuk daftar hasil bulk-save apa adanya);
 * koneksi putus = MELEMPAR (lib menjadikannya Tidak pasti untuk paket yang sedang dikirim).
 */
export async function postJson(url: string, body: unknown): Promise<{ status: number; data: unknown }> {
    const res = await fetch(url, { method: "POST", credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* bukan JSON → null */ }
    return { status: res.status, data };
}

/** Pratinjau lock (tidak menulis). Ditolak/tidak terjawab = melempar: cek ganda wajib terbaca sebelum Tinjau bisa dikirim. */
export async function pratinjauKunci(keys: unknown[]) {
    const j = await ambilJson("/api/idempotency/lock", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys, preview: true }),
    });
    if (j.status === 0 || j.status >= 502 || j.data === null) throw new Error("Cek ganda tidak mendapat jawaban yang pasti dari server; coba lagi.");
    if (j.status < 200 || j.status >= 300) throw new Error(typeof j.data.error === "string" && j.data.error ? j.data.error : "Cek ganda ditolak server.");
    return j.data as { blockedEntries?: Array<{ key: string; reason?: string }> };
}

/**
 * Baris pencarian (kontrak §4). `found` = ADA pelunasan di grup pelanggan+tanggal yang MENYENTUH faktur baris (bukan identik:
 * nominal bisa beda) — `candidates` dibandingkan Finance sebelum memilih nomor untuk `terposting`.
 */
export type HasilCari = {
    key: string; status: string; customerNo: string; transDate: string; invoiceNo: string; amount: number;
    ageSeconds: number; eligible: boolean; found: boolean | null; receiptNumbers: string[]; readError: string | null;
    candidates: Kandidat[];
};
/** `receiptNumber` bisa "" (Accurate tak memberi nomor); `amount` = Σ paymentAmount pelunasan itu. */
export type Kandidat = { receiptNumber: string; invoiceNos: string[]; amount: number | null; transDate: string };
export type Pencarian = { databaseId: string | null; databaseAlias: string | null; rows: HasilCari[] };

const daftarTeks = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
/** Kandidat §4/§5 dari jawaban server (GET pencarian, atau galat similar_found / number_mismatch). */
export const kandidatDari = (v: unknown): Kandidat[] => (Array.isArray(v) ? v : []).map((k) => {
    const o = (k && typeof k === "object" ? k : {}) as Record<string, unknown>;
    return { receiptNumber: String(o.receiptNumber ?? "").trim(), invoiceNos: daftarTeks(o.invoiceNos), amount: typeof o.amount === "number" ? o.amount : null, transDate: String(o.transDate ?? "") };
});

/** Selesaikan langkah 1: hasil pencarian server di Accurate (sesi pemanggil), baca-saja. */
export const cariPenyelesaian = (key: string): Promise<Load<Pencarian>> =>
    baca(`/api/idempotency/resolve?key=${encodeURIComponent(key)}`, (j) => ({
        databaseId: j.databaseId == null ? null : String(j.databaseId),
        databaseAlias: typeof j.databaseAlias === "string" ? j.databaseAlias : null,
        rows: Array.isArray(j.rows)
            ? (j.rows as Array<Record<string, unknown>>).map((r) => ({ ...r, receiptNumbers: daftarTeks(r.receiptNumbers), candidates: kandidatDari(r.candidates) }) as HasilCari)
            : [],
    }), "Pencarian di Accurate gagal.");

/**
 * Jawaban POST Selesaikan (kontrak §5): `ragu` = putus / ≥ 502 / bukan JSON / 2xx tanpa bentuk dikenal — penyelesaian MUNGKIN tercatat.
 * `sudah` = alreadyResolved (klik ganda, atau kalah balapan dengan Finance lain): `status` = keputusan yang BERLAKU di server.
 */
export type JawabSelesaikan =
    | { jenis: "ok"; status: "SUCCESS" | "FAILED"; sudah: boolean; nomor: string[] }
    | { jenis: "tolak"; code: string; pesan: string; data: Record<string, unknown> }
    | { jenis: "ragu" };

/** Selesaikan langkah 2: simpan keputusan. Penolakan berkode (4xx/500 JSON) = tidak ada yang diubah server. */
export async function simpanPenyelesaian(body: {
    key: string; decision: "terposting" | "tidak_ada"; accurateNumber: string; reason: string; checkedSource: string; expectedDatabaseId: string;
    /** Kandidat terpilih nominalnya ≠ baris dan Finance mencentang konfirmasi (server putaran 2: tanpa ini 409 similar_not_identical). */
    acceptSimilar?: true;
}): Promise<JawabSelesaikan> {
    const j = await ambilJson("/api/idempotency/resolve", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (j.status === 0 || j.status >= 502 || j.data === null) return { jenis: "ragu" };
    if (j.status >= 200 && j.status < 300) {
        const st = j.data.status;
        const nomor = Array.isArray(j.data.receiptNumbers) ? j.data.receiptNumbers.map(String) : [];
        return j.data.ok === true && (st === "SUCCESS" || st === "FAILED") ? { jenis: "ok", status: st, sudah: j.data.alreadyResolved === true, nomor } : { jenis: "ragu" };
    }
    return { jenis: "tolak", code: typeof j.data.code === "string" && j.data.code ? j.data.code : `HTTP_${j.status}`, pesan: typeof j.data.error === "string" ? j.data.error : "", data: j.data };
}

/** `category`: "uncertain" | "processingStale" = boleh diselesaikan (§4 eligible); "retryable" = Gagal, tidak terkirim. */
export type BarisRingkasan = {
    key: string; status: string; customerNo: string | null; transDate: string | null; invoiceNo: string | null; amount: number | null;
    databaseId: string | null; updatedAt: string | null; category: string;
};
export type Ringkasan = { rows: BarisRingkasan[]; rowsTruncated: boolean };

/**
 * Daftar Tidak pasti + Gagal (GET /api/idempotency/summary?rows=1, kontrak §6). `database` = saring ke database lock itu; server WAJIB
 * menggemakan `rowsDatabaseId` — tanpa gema = daftar mungkin tidak tersaring = galat. Jawaban tanpa daftar = galat, bukan daftar kosong.
 */
export async function muatRingkasan(database?: string): Promise<Load<Ringkasan>> {
    const url = `/api/idempotency/summary?rows=1${database ? `&database=${encodeURIComponent(database)}` : ""}`;
    const l = await baca(url, (j) => j, "Daftar pelunasan gagal dimuat.");
    if (l.status !== "siap" || !l.data) return { status: "galat", error: l.error };
    if (!Array.isArray(l.data.rows)) return { status: "galat", error: "Daftar pelunasan gagal dimuat. Jawaban server tidak memuat daftar baris." };
    if (database && l.data.rowsDatabaseId !== database) return { status: "galat", error: "Daftar pelunasan gagal dimuat. Server tidak menyaring ke database yang diminta." };
    return { status: "siap", data: { rows: l.data.rows as BarisRingkasan[], rowsTruncated: l.data.rowsTruncated === true } };
}

/** Label database baris: database aktif sesi memakai alias; selebihnya id; NULL = lock sebelum S6e-2. */
export const labelDatabase = (id: string | null, sesi: Sesi | undefined) => id === null ? "tidak tercatat (kiriman sebelum pembaruan)"
    : sesi?.databaseId === id ? `${namaDatabase(sesi)} · database aktif` : `database id ${id}`;

/** Unduh Excel atas permintaan pengguna (tidak pernah otomatis). Nama berkas memakai waktu WITA. */
export async function unduhExcel(rows: Record<string, unknown>[], sheet: string, awalan: string) {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheet);
    const cap = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Makassar", dateStyle: "short", timeStyle: "short" }).format(new Date()).replace(/[: ]/g, "-");
    XLSX.writeFile(wb, `${awalan}_${cap}_WITA.xlsx`);
}

/** YYYY-MM-DD → dd/mm/yyyy. */
export const tanggalTampil = (ymd: string) => ymd.split("-").reverse().join("/");

export const ALASAN = {
    kirim: "Akun Anda belum berhak mengirim pelunasan ke Accurate; minta admin menambahkan izin Kirim pelunasan ke grup Anda.",
    izinkan: "Hanya Finance yang dapat mengizinkan baris ganda atau mirip, dengan alasan yang tercatat per baris.",
    selesaikan: "Hanya Finance yang dapat menyelesaikan baris tidak pasti.",
    /** Server menolak 403 walau tombol aktif (izin dicabut sesudah halaman dibuka): jangan suruh menekan tombol yang sama. */
    selesaikanDitolak: "Server menolak: akun Anda tidak (lagi) berhak menyelesaikan baris tidak pasti; minta admin menambahkan izinnya, lalu muat ulang halaman.",
    konsol: "Akun Anda belum bisa membuka Konsol AOL tempat masuk ke Accurate; minta admin/IT menambahkan aksesnya atau membukakan database.",
};
