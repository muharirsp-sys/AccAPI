/*
 * Tujuan: Bagian bersama layar Data Principal (Fiori S7b): bentuk jawaban /api/principals/**, label jenis alias, saringan daftar,
 *   ringkasan baris riwayat, serta baca/tulis yang membedakan galat PASTI dari jawaban TIDAK PASTI.
 * Caller: components/principal/DataPrincipal.tsx, components/principal/RiwayatPrincipal.tsx, principal-ui.test.ts.
 * Dependensi: lib/principal/resolver (JENIS_ALIAS, SUMBER_KODE — murni), lib/tampil (waktuWita). Kontrak:
 *   docs/handover/S7-2-KONTRAK-PRINCIPAL-API.md.
 * Main Functions: saring, ringkasLog, aktorTeks, labelJenis, labelVarian, baca, tulis, GalatTulis.
 * Side Effects: baca/tulis melakukan fetch ke /api/principals/**; sisanya murni.
 * Header CSRF: TIDAK dikirim. /api/principals/** adalah route handler Next dengan cookie sesi (pola sama dengan Kasir dan Order
 *   Principal); token CSRF hanya dipakai route FastAPI (payments, orders).
 */
import type { Load } from "@/components/fiori/interactive";
import { JENIS_ALIAS, SUMBER_KODE, type JenisAlias } from "@/lib/principal/resolver";

export { JENIS_ALIAS, SUMBER_KODE };
export { waktuWita } from "@/lib/tampil";

export type Varian = { principalId: string; variantKey: string; name: string | null; isActive: boolean; createdBy: string | null; createdAt: string };
export type Alias = {
    id: string; aliasNorm: string; principalId: string; variantKey: string | null; aliasAsli: string; jenis: string; sumber: string;
    createdBy: string | null; createdAt: string;
};
export type Principal = {
    id: string; code: string; name: string; isActive: boolean; createdBy: string | null; createdAt: string; updatedBy: string | null; updatedAt: string;
    variants: Varian[]; aliases: Alias[];
};
export type Log = {
    id: number; entitas: "principal" | "varian" | "alias"; kunci: string; principalId: string; aksi: "buat" | "aktif" | "nonaktif" | "hapus";
    before: Record<string, unknown> | null; after: Record<string, unknown> | null; aktor: string; waktu: string;
};
export type HalamanRiwayat = { riwayat: Log[]; sebelum: number | null };
export type SaringStatus = "semua" | "aktif" | "nonaktif";

export const LABEL_JENIS: Record<JenisAlias, string> = {
    nama: "Nama", kode_master_barang: "Kode Master Barang", label_mapping: "Label mapping", nama_bank: "Nama bank", nama_summary: "Nama di Summary", nama_surat: "Nama di surat",
};
export const labelJenis = (jenis: string) => (LABEL_JENIS as Record<string, string>)[jenis] ?? jenis;
/** Alias `null` = principal utuh; varian `""` = varian dasar. */
export const labelVarian = (key: string | null) => (key === null ? "Seluruh principal" : key === "" ? "Dasar" : key);

/** Cari di kode, nama, kode/nama varian, dan semua ejaan alias (huruf besar-kecil diabaikan) + saringan status. */
export function saring(daftar: Principal[], cari: string, status: SaringStatus): Principal[] {
    const q = cari.trim().toLowerCase();
    return daftar.filter((p) => (status === "semua" || (status === "aktif") === p.isActive)
        && (!q || [p.code, p.name, ...p.variants.flatMap((v) => [v.variantKey, v.name ?? ""]), ...p.aliases.flatMap((a) => [a.aliasAsli, a.aliasNorm])]
            .some((teks) => teks.toLowerCase().includes(q))));
}

const KATA_AKSI = { buat: "dibuat", aktif: "diaktifkan", nonaktif: "dinonaktifkan", hapus: "dihapus" } as const;
const teksDari = (v: unknown) => (typeof v === "string" ? v : "");

/** Satu baris riwayat → kalimat + rincian. `before`/`after` = isi baris entitas (kontrak: kunci camelCase properti db/schema). */
export function ringkasLog(l: Log): { apa: string; rinci: string } {
    const isi = l.after ?? l.before ?? {};
    const kata = KATA_AKSI[l.aksi] ?? l.aksi;
    if (l.entitas === "principal") return { apa: `Principal ${kata}`, rinci: [teksDari(isi.code), teksDari(isi.name)].filter(Boolean).join(" · ") };
    if (l.entitas === "varian") {
        // kunci varian = "<principal_id>:<variant_key>"; isi baris lebih tepercaya bila ada.
        const key = typeof isi.variantKey === "string" ? isi.variantKey : l.kunci.slice(l.kunci.indexOf(":") + 1);
        return { apa: `Varian ${labelVarian(key)} ${kata}`, rinci: teksDari(isi.name) };
    }
    const varian = typeof isi.variantKey === "string" ? ` · varian ${labelVarian(isi.variantKey)}` : "";
    return { apa: `Alias ${kata}`, rinci: `“${teksDari(isi.aliasAsli) || l.kunci}” · ${labelJenis(teksDari(isi.jenis))}${varian}` };
}

/** Aktor = id akun sesi (tanpa nama di API); benih memakai `benih:S7-2`.
 *  TODO: tampilkan nama pelaku bila API riwayat menyertakan `actorName` (audit desain 001, No 87); butuh perubahan API, bukan layar. */
export const aktorTeks = (aktor: string) => (aktor.startsWith("benih:") ? `benih ${aktor.slice(6)}` : aktor);

// ---------------------------------------------------------------------------------------------------------- jaringan

type Jawab = { status: number; data: Record<string, unknown> | null };

async function minta(url: string, init?: RequestInit): Promise<Jawab> {
    try {
        const res = await fetch(url, { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(30_000), ...init });
        const data: unknown = await res.json().catch(() => null);
        return { status: res.status, data: data && typeof data === "object" ? (data as Record<string, unknown>) : null };
    } catch {
        return { status: 0, data: null }; // putus / batas waktu
    }
}

const pesanServer = (data: Jawab["data"]) => (typeof data?.error === "string" && data.error ? data.error : "");

/** GET → Load. Galat (izin, putus, server) tidak pernah menjadi daftar kosong; 500/503 membawa kalimat server (mis. "Hubungi IT Support"). */
export async function baca<T>(url: string, pick: (j: Record<string, unknown>) => T, umum: string): Promise<Load<T>> {
    const { status, data } = await minta(url);
    if (status >= 200 && status < 300 && data?.ok === true) return { status: "siap", data: pick(data) };
    const sebab = status === 0 || data === null ? "Server tidak terjangkau atau tidak menjawab dengan jelas; coba lagi."
        : status === 401 ? "Sesi login berakhir; masuk ulang lalu coba lagi."
        : status === 403 ? "Akun Anda belum berhak melihat Data Principal (izin Lihat Principles); minta admin menambahkannya ke grup akses."
        : pesanServer(data) || "Server gagal memproses permintaan.";
    return { status: "galat", error: `${umum} ${sebab}` };
}

export const BELUM_PASTI = "Hasilnya belum pasti: server tidak memberi jawaban yang jelas, jadi perubahan mungkin sudah tersimpan. Data dimuat ulang. Periksa dulu sebelum mengulang.";

/** `belumPasti` = jawaban hilang/tidak terbaca (hasil tulis tidak diketahui); lainnya = server menolak dan tidak menulis apa pun. */
export class GalatTulis extends Error {
    constructor(message: string, readonly status: number, readonly belumPasti = false, readonly code?: string) { super(message); }
}

/** Tulis JSON. Sukses = `ok: true`; selain itu melempar GalatTulis berkalimat server (403 diberi petunjuk izin). */
export async function tulis(url: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<Record<string, unknown>> {
    const { status, data } = await minta(url, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    if (status >= 200 && status < 300 && data?.ok === true) return data;
    if (status === 0 || status === 502 || status === 504 || data === null) throw new GalatTulis(BELUM_PASTI, status, true);
    const pesan = pesanServer(data) || "Server menolak permintaan.";
    const teks = status === 401 ? `${pesan.replace(/[.\s]+$/, "")}. Sesi login berakhir; masuk ulang lalu coba lagi.`
        : status === 403 ? `${pesan.replace(/[.\s]+$/, "")}. Akun Anda belum berhak atas aksi ini; minta admin menambahkan izinnya.` : pesan;
    throw new GalatTulis(teks, status, false, typeof data.code === "string" ? data.code : undefined);
}
