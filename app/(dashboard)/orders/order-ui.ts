/*
 * Tujuan: Bagian bersama layar Order Masuk Fiori (it06): tipe order FastAPI + antrean, panggilan FastAPI ber-CSRF, status order
 *   "sampai faktur" (status order FastAPI ditimpa status Antrean Faktur bila sudah antre), dan teks sumber/nomor order.
 * Caller: ./OrderMasuk.tsx (List Report), ./OrderBaru.tsx (form), ./OrderDetail.tsx (Object Page + dialog Antrekan).
 * Dependensi: lib/apiBase (FastAPI), lib/promo-ui (rupiah), ../form-kontrol/lapangan (ambilJson, Jawaban), components/fiori/core (Tone).
 * Main Functions: fastapi, nextApi, sukses, tidakPasti, pesanJawaban, nomorOrder, sumberOrder, statusOrder, STATUS_ANTREAN, nilai.
 * Side Effects: fetch ke FastAPI (/api/me untuk token CSRF, /orders…).
 */
import type { Tone } from "@/components/fiori/core";
import { resolveApiBase } from "@/lib/apiBase";
import { rupiah } from "@/lib/promo-ui";
import { ambilJson, type Jawaban } from "../form-kontrol/lapangan";

export const API_BASE = resolveApiBase();

export type ResultLine = { code: string; unit: string; quantity: string; gross: string; net: string; percents?: string[]; cash?: string };
export type Bonus = { program_id: string; code: string; unit: string; quantity: string; eligible_codes?: string[] };
export type Result = {
    pending_price?: boolean; gross?: string; discount?: string; net?: string;
    lines?: ResultLine[]; applications?: { program_id: string; minimum: string; discount: string }[]; bonuses?: Bonus[];
};
export type OrderLine = { code: string; unit: string; quantity: string; price: string };
/** Baris daftar FastAPI GET /orders (100 terbaru). */
export type OrderRow = {
    id: string; owner: string; outlet: string; channel: string; order_date: string; status: string;
    result: Result; request_id: string | null; customer_no: string; created_at: string;
};
/** FastAPI GET /orders/{id}: baris daftar + isi beku. */
export type OrderFull = OrderRow & { note: string; lines: OrderLine[]; rules: { id: string; name: string }[]; sources: { draft_id: string; revision: number }[] };
export type OutboxState = "queued" | "sending" | "posted" | "unknown" | "rejected";
export type OutboxRow = { orderId?: string; state: OutboxState; accurateNumber: string | null; lastError: string | null; updatedAt: string | null };
export type PriceInfo = {
    code: string; unit: string; price: number | null; source: string; priceCategoryName: string | null;
    branchName: string | null; effectiveDate: string | null;
};

let cachedCsrf = "";
async function csrfHeader(): Promise<Record<string, string>> {
    if (!cachedCsrf) {
        try {
            const res = await fetch(`${API_BASE}/api/me`, { credentials: "include", signal: AbortSignal.timeout(15_000) });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.csrf_token) cachedCsrf = String(data.csrf_token);
        } catch { /* backend masih memeriksa same-origin bila token tidak tersedia */ }
    }
    return cachedCsrf ? { "X-CSRF-Token": cachedCsrf } : {};
}

/** FastAPI order. status 0 = tidak sampai/tidak berjawab; data null = badan bukan JSON (mis. halaman galat proxy). */
export async function fastapi(method: "GET" | "POST", path: string, body?: unknown): Promise<Jawaban> {
    return ambilJson(`${API_BASE}${path}`, {
        method, credentials: "include",
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { "Content-Type": "application/json", ...(await csrfHeader()) },
    });
}

/** Rute Next (/api/orders/…) dengan JSON; bentuk jawaban sama dengan `fastapi`. */
export function nextApi(path: string, body?: unknown): Promise<Jawaban> {
    return ambilJson(path, body === undefined ? { credentials: "include" } : {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
}

export const sukses = (j: Jawaban): j is { status: number; data: Record<string, unknown> } =>
    j.status >= 200 && j.status < 300 && j.data !== null && j.data.ok !== false;

/** Jawaban tulis yang TIDAK PASTI: koneksi putus, status ≥ 502, atau badan bukan JSON — aksinya mungkin sudah tersimpan. */
export const tidakPasti = (j: Jawaban) => j.status === 0 || j.status >= 502 || j.data === null;

export const BELUM_PASTI = "Server tidak memberi jawaban yang pasti — hasilnya belum pasti. Data dimuat ulang; periksa dulu sebelum mengulang.";

/** Pesan server apa adanya (FastAPI `detail`, Next `error`); tanpa kode status mentah. */
export function pesanJawaban(j: Jawaban, umum: string): string {
    if (j.status === 0) return `${umum} Server tidak dapat dihubungi.`;
    if (j.status === 401) return "Sesi login berakhir; masuk ulang lalu coba lagi.";
    const d = j.data ?? {};
    const teks = typeof d.detail === "string" ? d.detail : typeof d.error === "string" ? d.error : "";
    if (j.status === 403) return teks || "Akun Anda tidak berhak atas aksi ini.";
    return teks || umum;
}

/** Nomor tampilan = 8 karakter awal id — sama dengan penanda `order …` di catatan tiap baris faktur. */
export const nomorOrder = (id: string) => `Order ${id.slice(0, 8)}`;

export function sumberOrder(o: Pick<OrderRow, "request_id" | "owner">): string {
    return o.request_id ? `Order Sales #${o.request_id.slice(0, 8)}` : `Petugas · ${o.owner || "—"}`;
}

export const STATUS_ANTREAN: Record<OutboxState, { label: string; tone: Tone; busy?: boolean }> = {
    queued: { label: "Di antrean", tone: "info" },
    sending: { label: "Sedang dikirim", tone: "info", busy: true },
    posted: { label: "Difakturkan", tone: "pos" },
    unknown: { label: "Tidak pasti di Accurate", tone: "warn" },
    rejected: { label: "Ditolak Accurate", tone: "neg" },
};

export type StatusKey = "butuh" | "siap" | "belum" | "antre" | "faktur" | "masalah" | "lain";
export type StatusOrder = { key: StatusKey; label: string; tone: Tone; busy?: boolean };

/**
 * Status "sampai faktur": begitu order punya baris Antrean Faktur, status antrean yang berlaku (Di antrean → Difakturkan / Tidak pasti /
 * Ditolak). Tanpa baris antrean: status FastAPI (needs_price = Butuh harga, draft = Siap diantrekan). `outbox` undefined = status antrean
 * BELUM TERBACA (memuat / gagal) — kunci "belum", dipisahkan dari null (memang belum antre) dan TIDAK dihitung "Siap diantrekan",
 * supaya order yang sudah difakturkan tidak pernah tampil siap diantrekan.
 */
export function statusOrder(o: Pick<OrderRow, "status" | "result">, outbox: OutboxRow | null | undefined, memuat = false): StatusOrder {
    if (outbox) {
        const s = STATUS_ANTREAN[outbox.state];
        const key: StatusKey = outbox.state === "posted" ? "faktur" : outbox.state === "queued" || outbox.state === "sending" ? "antre" : "masalah";
        return { key, ...s };
    }
    if (o.status === "needs_price" || o.result?.pending_price) return { key: "butuh", label: "Butuh harga", tone: "warn" };
    if (o.status === "draft") {
        if (outbox === null) return { key: "siap", label: "Siap diantrekan", tone: "info" };
        return memuat ? { key: "belum", label: "Memeriksa Antrean Faktur…", tone: "neu", busy: true } : { key: "belum", label: "Tersimpan · status antrean belum terbaca", tone: "neu" };
    }
    return { key: "lain", label: "Status tidak dikenal", tone: "neu" };
}

/** Rupiah dari angka/teks beku FastAPI; kosong/bukan angka → "—" (bukan Rp 0 yang terbaca seperti nilai). */
export const nilai = (raw: string | number | null | undefined) =>
    raw === null || raw === undefined || raw === "" || !Number.isFinite(Number(raw)) ? "—" : rupiah(raw);
