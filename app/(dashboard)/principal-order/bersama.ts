/*
 * Tujuan: Tipe dan helper bersama layar Order Principal (Fiori S6d): bentuk respons /api/principal-order/*, baca → Load, tulis yang
 *   membedakan penolakan server dari jawaban TIDAK PASTI, pemilah "SO ditahan utuh", label status antrean, dan format angka/waktu.
 * Caller: OrderPrincipal.tsx, LangkahBatch.tsx.
 * Dependensi: app/(dashboard)/form-kontrol/lapangan (ambilJson), components/fiori (tipe Load, Tone), lib/rekapan-nota/ui (tanggalPendek).
 * Main Functions: baca, tulis, TidakPasti, PESAN_TIDAK_PASTI, ditahanUtuh, LABEL_ANTREAN, angka, waktuWita, tanggalSo, ALASAN_IZIN.
 * Side Effects: baca/tulis melakukan fetch; sisanya murni.
 */
import type { Tone } from "@/components/fiori/core";
import type { Load } from "@/components/fiori/interactive";
import { ambilJson } from "@/app/(dashboard)/form-kontrol/lapangan";
import { tanggalPendek } from "@/lib/rekapan-nota/ui";

export type Batch = {
    id: string; principal: string; fileName: string; branch: string; period: string;
    lineCount: number; skipped: number; issues: string[]; status: string;
    uploadedBy: string; uploadedAt: string;
    validatedAt: string | null; okCount: number; reviewCount: number;
};

export type Line = {
    rowNumber: number; soNo: string; soDate: string | null; customerCode: string; customerName: string;
    customerType: string; productCode: string; productName: string;
    reportQty: string; reportGross: string; qty: string; unit: string; price: string;
    discounts: { position: number; percent: number; amount?: number; reportPosition?: number }[]; bonus: boolean;
    itemCode: string | null; customerNo: string | null; expectedPrice: string | null;
    status: "pending" | "ok" | "review"; findings: string[];
};

/** Satu calon faktur dari pratinjau antre. `salesmanId` 0 = tidak ketemu/nonaktif di Accurate -> faktur terbit TANPA sales. */
export type CalonFaktur = {
    key: string; soNo: string; customerNo: string; orderDate: string; lineCount: number;
    gross: number; net: number; branch: string; salesman: string; salesmanId: number;
    /** SO yang pernah dibuang dari antrean: saat diantrekan, fakturnya dicari dulu di Accurate. */
    pernahDibuang?: boolean;
};
export type SoTidakIkut = { soNo: string; reason: string };
export type Rencana = { batchId: string; ready: CalonFaktur[]; skipped: SoTidakIkut[] };
export type HasilAntre = { queued: number; alreadyPosted: { orderId: string; accurateId: string; number: string }[]; skipped: SoTidakIkut[] };

/** Satu konfirmasi "SO ini BUKAN order ganda" yang sudah tercatat. */
export type Ack = { principal: string; soNo: string; reason: string; note: string; confirmedBy: string; confirmedAt: string };

export type Pratinjau = {
    fileName: string; branch: string; period: string; lineCount: number; skipped: number;
    issues: string[]; unmappedProducts: string[]; unmappedCustomers: string[]; unmappedSalesmen: string[];
    duplicateOf: { id: string; fileName: string; uploadedAt: string } | null;
};

export type BarisAntrean = { orderId: string; state: string; number: string; error: string };
export type StatusAntrean = { candidates: number; queue: BarisAntrean[] };

export const PRINCIPAL_DIDUKUNG = "KINO NON FOOD";

export const ALASAN_IZIN = {
    buat: "Akun Anda belum berhak mengunggah, memvalidasi, atau mengonfirmasi order principal (izin buat Order Masuk); minta admin menambahkannya.",
    ubah: "Akun Anda belum berhak menyiapkan, mengantrekan, atau menghapus batch (izin ubah Order Masuk); minta admin menambahkannya.",
};

const sebab = (status: number, data: Record<string, unknown> | null, umum: string) => {
    if (status === 0) return `${umum} Server tidak terjangkau; periksa koneksi lalu coba lagi.`;
    if (status === 401) return `${umum} Sesi login berakhir; masuk ulang lalu coba lagi.`;
    if (status === 403) return `${umum} Akun Anda belum punya izin untuk data ini; minta admin menambahkannya ke grup akses.`;
    const pesan = data && typeof data.error === "string" ? data.error : "";
    return pesan ? `${umum} ${pesan}` : `${umum} Server gagal memproses permintaan.`;
};

/** GET → Load. Galat tidak pernah menjadi data kosong; HTTP 2xx tanpa `ok: true` juga galat (sama dengan cek kode lama). */
export async function baca<T>(url: string, pick: (data: Record<string, unknown>) => T, umum: string): Promise<Load<T>> {
    const j = await ambilJson(url, { credentials: "include" });
    if (j.status >= 200 && j.status < 300 && j.data?.ok) return { status: "siap", data: pick(j.data) };
    return { status: "galat", error: sebab(j.status, j.data, umum) };
}

/** Pesan bila jawaban server tidak pasti (aksi mungkin sudah tersimpan, mungkin belum). */
export const PESAN_TIDAK_PASTI = "Server tidak memberi jawaban yang pasti — hasilnya belum pasti. Data dimuat ulang; periksa dulu sebelum mengulang.";

/** Dilempar `tulis` bila hasilnya TIDAK PASTI: koneksi putus, status ≥ 502, atau badan bukan JSON (mis. halaman HTML proxy). */
export class TidakPasti extends Error {
    constructor() { super(PESAN_TIDAK_PASTI); }
}

/** Galat yang ditolak server tetapi membawa daftar SO yang tidak ikut (pratinjau antre 422). */
export class DitolakDenganDaftar extends Error {
    constructor(message: string, readonly skipped: SoTidakIkut[]) { super(message); }
}

/**
 * Tulis ke endpoint Order Principal. Objek → JSON; FormData apa adanya. Ditolak (4xx/500 atau `ok` bukan true) → Error(pesan server).
 * Tidak pasti → TidakPasti, tidak pernah teks/HTML mentah.
 */
export async function tulis(url: string, opsi: { method?: "POST" | "DELETE"; body?: Record<string, unknown> | FormData; gagal: string }) {
    const isForm = typeof FormData !== "undefined" && opsi.body instanceof FormData;
    const j = await ambilJson(url, {
        method: opsi.method ?? "POST",
        credentials: "include",
        headers: opsi.body && !isForm ? { "Content-Type": "application/json" } : undefined,
        body: opsi.body ? (isForm ? (opsi.body as FormData) : JSON.stringify(opsi.body)) : undefined,
    });
    if (j.status === 0 || j.status >= 502 || j.data === null) throw new TidakPasti();
    if (j.status < 200 || j.status >= 300 || !j.data.ok) {
        const pesan = typeof j.data.error === "string" && j.data.error ? j.data.error : opsi.gagal;
        if (Array.isArray(j.data.skipped)) throw new DitolakDenganDaftar(pesan, j.data.skipped as SoTidakIkut[]);
        throw new Error(j.status === 403 ? `${pesan}. Minta admin menambahkan izinnya.` : pesan);
    }
    return j.data;
}

/**
 * Isu batch yang berbunyi "SO … ditahan utuh" (lib/order-detail): SO yang punya produk belum termapping tidak disimpan SAMA SEKALI,
 * supaya faktur tidak terbit separuh isi (INV/2609/KN01340 kurang Rp 405.000). Dipisah dari isu lain dan ditaruh paling atas.
 */
export function ditahanUtuh(issues: string[]) {
    const held: { so: string; kode: string; teks: string }[] = [];
    const lain: string[] = [];
    for (const teks of issues) {
        const m = /^SO (\S+) ditahan utuh/.exec(teks);
        if (m) held.push({ so: m[1], kode: /kode produk (.+?) belum ada di mapping/.exec(teks)?.[1] ?? "", teks });
        else lain.push(teks);
    }
    return { held, lain };
}

/** Status baris antrean faktur → label bahasa tugas (sama dengan mockup Antrean Faktur it02: tidak pasti = warn, ditolak = neg). */
export const LABEL_ANTREAN: Record<string, { label: string; tone: Tone }> = {
    queued: { label: "Antre", tone: "info" },
    sending: { label: "Mengirim", tone: "info" },
    rejected: { label: "Ditolak Accurate", tone: "neg" },
    unknown: { label: "Tidak pasti", tone: "warn" },
    posted: { label: "Terposting", tone: "pos" },
};
export const labelAntrean = (state: string) => LABEL_ANTREAN[state] ?? { label: state, tone: "neu" as Tone };

/** Nomor SO dari kunci antrean `KINO-NON-FOOD:<SO>`. */
export const soDariKunci = (key: string) => key.slice(key.indexOf(":") + 1);

export const angka = (value: string | number) => Number(value).toLocaleString("id-ID", { maximumFractionDigits: 2 });

/** "05/10/2026 16.20" dalam WITA. */
export function waktuWita(iso: string | null | undefined) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Makassar", ...o }).format(d);
    return `${f({ day: "2-digit", month: "2-digit", year: "numeric" })} ${f({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
}

/** Tanggal SO/periode: setiap YYYY-MM-DD (juga cap waktu ISO) → dd/mm/yyyy; teks lain apa adanya. */
export const tanggalSo = (teks: string | null | undefined) =>
    String(teks ?? "").replace(/(\d{4}-\d{2}-\d{2})(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?/g, (_, ymd: string) => tanggalPendek(ymd));
