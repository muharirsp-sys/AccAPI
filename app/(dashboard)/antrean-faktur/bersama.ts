/*
 * Tujuan: Tipe jawaban API antrean faktur + helper penyajian layar Antrean Faktur (Fiori S6c): label status, kalimat jawaban
 *   Accurate yang terbaca (bukan JSON mentah), umur, dan tulis dengan deteksi jawaban TIDAK PASTI.
 * Caller: app/(dashboard)/antrean-faktur/{AntreanFaktur,Dialog,VerifikasiBalik}.tsx.
 * Dependensi: components/fiori/core (Tone), API /api/invoice-outbox/** dan /api/invoice-verify (bentuk jawaban).
 * Main Functions: STATUS, kalimatAccurate, usia, hariIniWita, tulis, pesanGagal, TidakPasti, BELUM_PASTI.
 * Side Effects: `tulis` melakukan POST/DELETE (dipakai komponen klien); sisanya pure.
 */
import type { Tone } from "@/components/fiori/core";

export type State = "queued" | "sending" | "posted" | "unknown" | "rejected";

export type Row = {
    orderId: string; soNo: string | null; source: string; customerNo: string; outlet: string; salesman: string;
    orderDate: string; state: State; attempts: number; lastError: string; accurateNumber: string;
    queuedBy: string; createdAt: string; updatedAt: string; ageMinutes: number; overdue: boolean;
};

export type Batch = {
    id: string; fileName: string; principal: string; uploadedAt: string; uploadedBy: string;
    reviewCount: number; lineCount: number; ageMinutes: number; overdue: boolean;
};

export type Antrean = {
    escalateAfterMinutes: number; summary: Partial<Record<State, number>>; overdue: number; overdueQueue: number;
    overdueBatches: number; reviewLinesOverdue: number; pendingBatches: Batch[]; rows: Row[];
    /** Jam klien saat jawaban diterima (dipasang loader, bukan server) — dasar "mengirim > 15 menit" tanpa Date.now() di render. */
    diambil: number;
};

/** Hasil pencarian faktur (ringkasCari di lib/invoice-outbox-actions). */
export type Pencarian =
    | { hasil: "ketemu"; sumber: "cache" | "accurate"; cocok: "charField1" | "baris" | "description"; id: string; number: string; semua: { id: string; number: string }[] }
    | { hasil: "tidak_ketemu_dicek"; sumber: "accurate"; diperiksa: number; baris_list_do: number;
        calon_tanpa_kunci: { id: string; number: string; totalAmount: number | null; transDate: string }[] }
    | { hasil: "gagal_cek"; alasan: string };

/** Kode status mentah → label + tone (aturan: tidak ada kode mentah di layar). */
export const STATUS: Record<State, { label: string; tone: Tone }> = {
    queued: { label: "Antre", tone: "info" },
    sending: { label: "Mengirim", tone: "neu" },
    posted: { label: "Terposting", tone: "pos" },
    unknown: { label: "Tidak pasti", tone: "warn" },
    rejected: { label: "Ditolak", tone: "neg" },
};

/** Ambang penyapu server (lib/invoice-sender SAPU_SETELAH_MENIT): `sending` lebih lama dari ini menjadi Tidak pasti. */
export const SAPU_MENIT = 15;

export const nomorSo = (row: { orderId: string; soNo: string | null }) => row.soNo ?? row.orderId;
/** Principal dari kunci `PRINCIPAL:NO-SO`; order internal (uuid) tidak berprinsipal. */
export const principalDari = (orderId: string) => (orderId.includes(":") ? orderId.slice(0, orderId.indexOf(":")) : "Order internal");

export const usia = (menit: number) => (menit < 60 ? `${menit} mnt` : `${Math.floor(menit / 60)} jam ${String(menit % 60).padStart(2, "0")} mnt`);

/** Hari ini (yyyy-MM-dd) menurut WITA — batas tanggal faktur sama dengan server (cekTanggalFaktur). */
export const hariIniWita = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());

/**
 * Jawaban Accurate yang tersimpan (last_error / reason event) → kalimat. Penolakan tersimpan sebagai daftar pesan JSON
 * (`["Pelanggan … tidak ditemukan"]`); jawaban tidak pasti sebagai catatan teknis pengirim (lib/accurate-invoice-write).
 */
export function kalimatAccurate(teks: string): string {
    const t = (teks ?? "").trim();
    if (!t) return "";
    try {
        const j: unknown = JSON.parse(t);
        const daftar = Array.isArray(j) ? j : j && typeof j === "object" ? (j as { d?: unknown; message?: unknown }).d ?? (j as { message?: unknown }).message : null;
        if (Array.isArray(daftar) && daftar.some((x) => typeof x === "string")) return daftar.filter((x) => typeof x === "string").join("; ");
        if (typeof daftar === "string" && daftar.trim()) return daftar;
    } catch {
        // Daftar pesan yang terpotong (hasil Kirim memotong 200 karakter) tidak lagi JSON sah: buang kurung/kutipnya saja.
        if (t.startsWith('["')) return t.replace(/^\["/, "").replace(/"?\]?$/, "").split('","').join("; ");
    }
    const http = /^HTTP (\d{3})/.exec(t)?.[1];
    if (http === "429") return "Accurate membatasi jumlah permintaan (HTTP 429) — belum terbukti tidak diproses.";
    if (http === "401" || http === "403") return `Accurate menolak sesi atau izin (HTTP ${http}) — belum terbukti tidak diproses.`;
    if (http?.startsWith("5")) return `Server Accurate bermasalah (HTTP ${http}) — fakturnya mungkin sudah terbentuk.`;
    const nonJson = /^respons non-JSON \((\d+)\)/.exec(t)?.[1];
    if (nonJson) return `Jawaban bukan dari Accurate (HTTP ${nonJson}, mis. halaman gateway) — fakturnya mungkin sudah terbentuk.`;
    if (t.startsWith("respons tanpa amplop")) return "Jawaban tanpa format Accurate (mungkin dari gateway) — fakturnya mungkin sudah terbentuk.";
    if (t.startsWith("penolakan tanpa daftar pesan")) return "Accurate menolak tanpa pesan yang jelas — fakturnya mungkin sudah terbentuk.";
    if (t.startsWith("sukses tanpa id")) return "Accurate menjawab berhasil tanpa nomor faktur yang sah — periksa di Accurate.";
    if (/timeout|timed out|aborted/i.test(t)) return "Accurate tidak menjawab dalam 60 detik — fakturnya mungkin sudah terbentuk.";
    if (/fetch failed|ECONN|socket|network/i.test(t)) return "Koneksi ke Accurate terputus — fakturnya mungkin sudah terbentuk.";
    return t;
}

/** Ringkasan satu baris hasil pencarian faktur, untuk strip/riwayat. */
export function kalimatPencarian(p: Pencarian | undefined | null): string {
    if (!p) return "";
    if (p.hasil === "ketemu") return `faktur ${p.number || p.id} ditemukan (${p.sumber === "cache" ? "salinan lokal, dikonfirmasi ke Accurate" : "langsung di Accurate"})`;
    if (p.hasil === "tidak_ketemu_dicek") return `tidak ketemu setelah memeriksa ${p.diperiksa} faktur pelanggan ini di Accurate`;
    return `pencarian tidak bisa memastikan (${p.alasan})`;
}

export const BELUM_PASTI = "Hasilnya belum pasti: server tidak memberi jawaban yang jelas (koneksi putus atau jawaban bukan data). "
    + "Antrean dimuat ulang — periksa baris Mengirim dan Tidak pasti sebelum mengulang.";
/** Dilempar `tulis` bila jawaban TIDAK PASTI: koneksi putus, status ≥ 502, atau badan bukan JSON (mis. HTML "504 Gateway Time-out"). */
export class TidakPasti extends Error {}

/**
 * POST/DELETE JSON. Mengembalikan status + badan JSON apa adanya (pemanggil yang menilai `ok`: Kirim menjawab 200 dengan ok=false
 * bila ada hasil tidak pasti/selisih). Jawaban tidak pasti → TidakPasti(BELUM_PASTI), tidak pernah teks/HTML mentah.
 */
export async function tulis(url: string, body: Record<string, unknown>, method: "POST" | "DELETE" = "POST"): Promise<{ status: number; data: Record<string, unknown> }> {
    let res: Response;
    let text: string;
    try {
        res = await fetch(url, { method, credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        text = await res.text();
    } catch {
        throw new TidakPasti(BELUM_PASTI);
    }
    let data: Record<string, unknown> | null = null;
    try {
        const j: unknown = JSON.parse(text);
        data = j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
    } catch { /* bukan JSON */ }
    if (res.status >= 502 || data === null) {
        throw new TidakPasti(typeof data?.error === "string" ? `${BELUM_PASTI} Pesan server: ${data.error}` : BELUM_PASTI);
    }
    return { status: res.status, data };
}

/** Pesan galat pasti (4xx/500 berbadan JSON): pesan server bila ada, selain itu kalimat umum per status. */
export function pesanGagal(status: number, data: Record<string, unknown>, umum: string): string {
    const e = typeof data.error === "string" && data.error !== "Forbidden" && data.error !== "Unauthorized" ? data.error : "";
    if (e) return e;
    if (status === 401) return "Sesi login berakhir — muat ulang halaman lalu masuk lagi.";
    if (status === 403) return "Akun Anda belum punya izin untuk tindakan ini.";
    return umum;
}
