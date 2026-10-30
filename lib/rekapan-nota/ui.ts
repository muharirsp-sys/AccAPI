/*
 * Tujuan: Helper murni layar Rekapan Nota (Fiori S2): label status/exception dalam bahasa tugas, tanggal WITA,
 *   penyaringan pool, dan urutan wave berikutnya. Tidak ada logic bisnis baru — hanya penyajian.
 * Caller: app/(dashboard)/rekapan-nota/*.tsx, ui.test.ts.
 * Dependensi: lib/tampil (KOSONG, sebabHttp). Pure kecuali `ambil`.
 * Main Functions: WAVE_STATUS, EXCEPTION_LABEL, menahanKonfirmasi, tanggalPanjang, tanggalPendek,
 *   saringPool, urutanBerikutnya, formatKarton, labelEvent, nomorLembar, judulBerkas, usulIsiDariNama, hariIniWita, ambil.
 * Side Effects: `ambil` melakukan GET (dipakai komponen klien); sisanya pure.
 *   Tanggal + jam (layar dan kop cetak) memakai `waktuWita` lib/tampil ("dd/mm/yyyy hh.mm"), tidak ada format jam sendiri di sini.
 */
import type { Tone } from "@/components/fiori/core";
import { KOSONG, sebabHttp } from "@/lib/tampil";

export type WaveStatusKode = "draft" | "released" | "confirmed" | "cancelled";

/** Kode status mentah → label + tone badge (A4: tidak ada kode mentah di layar). */
export const WAVE_STATUS: Record<WaveStatusKode, { label: string; tone: Tone }> = {
    draft: { label: "Draf", tone: "neu" },
    released: { label: "Rilis", tone: "info" },
    confirmed: { label: "Dikonfirmasi", tone: "pos" },
    cancelled: { label: "Dibatalkan", tone: "neg" },
};

export const EXCEPTION_LABEL: Record<string, string> = {
    KONVERSI_TIDAK_ADA: "Isi per karton belum ada",
    KONVERSI_BEDA_DENGAN_EXPORT: "Isi per karton beda dengan file",
    SATUAN_TIDAK_KONSISTEN: "Satuan tidak konsisten",
    OUTLET_TANPA_AREA: "Outlet tanpa area",
    PRINCIPAL_BELUM_MASUK: "Principal tidak ada di file",
    REKONSILIASI_SELISIH: "Selisih dengan file",
};

/** Hanya exception KONVERSI_* yang menahan konfirmasi (lib/rekapan-nota/exception.ts, R1.4). */
export const menahanKonfirmasi = (jenis: string, status: string) => status === "open" && jenis.startsWith("KONVERSI");

const utcNoon = (ymd: string) => new Date(`${ymd}T12:00:00Z`);

/** "Selasa, 6 Okt 2026" dari YYYY-MM-DD; tanggal saja, tanpa pergeseran zona. */
export function tanggalPanjang(ymd: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
    return new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(utcNoon(ymd));
}

/** "06/10/2026" dari YYYY-MM-DD (aturan lintas layar: dd/mm/yyyy). */
export function tanggalPendek(ymd: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
    return new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(utcNoon(ymd));
}

/** Tanggal hari ini (yyyy-mm-dd) dalam WITA — bukan UTC, yang masih "kemarin" sampai 08.00 WITA. */
export const hariIniWita = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(d);

/**
 * Nomor lembar TETAP per wave + lembar (owner 20 Okt 2026), gaya nomor Accurate: RKP/2610/0002/ALL, TTF/2610/0002.
 * Cetak ulang = nomor sama; jam cetak di kop yang membedakan dua cetakan. Wave id unik global, jadi nomornya unik.
 */
export function nomorLembar(jenis: "RKP" | "TTF", tanggalWave: string, waveId: number, kode?: string) {
    return [jenis, tanggalWave.slice(2, 4) + tanggalWave.slice(5, 7), String(waveId).padStart(4, "0"), kode].filter(Boolean).join("/");
}

/**
 * Judul halaman cetak = nama berkas bawaan "Save as PDF" (owner 20 Okt 2026): nomor lembar tanpa "/" + tanggal-jam cetak WITA,
 * mis. RKP-2610-0002-JP-FKS_20261020-0940. Jam = saat halaman dimuat (sama dengan "dicetak" di kop); muat ulang untuk jam baru.
 */
export function judulBerkas(noLembar: string, d = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar", year: "numeric", month: "2-digit",
        day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
    return `${noLembar.replaceAll("/", "-")}_${p.year}${p.month}${p.day}-${p.hour}${p.minute}`;
}

const SATUAN_KECIL = "P|PC|PCS|BTL|PCH|SCH|SACHET|RCG|BOX|DUS|PACK|PAK|TUBE|BAG|CUP|KLG|BKS|LBR|ROLL|POT|JRG|PAIL|GLN|TIN";

/**
 * Usulan isi per karton dari NAMA barang (owner 24 Okt 2026): "... 55GR X 24P" -> 24, "... 60 PCS X 180G" -> 60,
 * "... 280ML X 24 PCH" -> 24. Hanya usulan yang dicek admin sebelum disimpan. Lebih dari satu kandidat
 * ("15/18 GR X 24 RCG PCSX12") atau tidak ada -> null: lebih baik kosong daripada menebak.
 */
export function usulIsiDariNama(nama: string | null | undefined): number | null {
    const n = String(nama ?? "").toUpperCase();
    const kandidat = new Set<number>();
    for (const m of n.matchAll(new RegExp(`\\bX\\s*(\\d+)\\s*(?:${SATUAN_KECIL})?(?=\\s|$)`, "g"))) kandidat.add(Number(m[1]));
    for (const m of n.matchAll(new RegExp(`(\\d+)\\s*(?:PCS|PC)\\s*X\\b`, "g"))) kandidat.add(Number(m[1]));
    for (const m of n.matchAll(/(?:PCS|PC|P)X(\d+)\b/g)) kandidat.add(Number(m[1]));
    const v = [...kandidat].filter((x) => x > 1 && x <= 10000);
    return v.length === 1 ? v[0] : null;
}

export const formatKarton = (krt: number | null | undefined) =>
    krt == null ? KOSONG : new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(krt);

export type PoolFilter = { cari: string; salesman: string; area: string; pareto: boolean };
export type PoolRow = { no_nota: string; customer: string | null; salesman: string | null; area: string | null; pareto: boolean | null };

/** Cari (nota/outlet, tanpa huruf besar-kecil) DAN salesman DAN area DAN pareto. Pilih semua hanya memilih hasil ini. */
export function saringPool<T extends PoolRow>(rows: T[], f: PoolFilter): T[] {
    const q = f.cari.trim().toLowerCase();
    return rows.filter((r) =>
        (!q || r.no_nota.toLowerCase().includes(q) || (r.customer ?? "").toLowerCase().includes(q))
        && (!f.salesman || (r.salesman ?? "") === f.salesman)
        && (!f.area || (r.area ?? "") === f.area)
        && (!f.pareto || r.pareto === true));
}

/** Urutan wave berikutnya seperti hari ini: reguler = urutan reguler terakhir + 1; kanvas mulai 9. Server tetap menolak kembar (409). */
export function urutanBerikutnya(wave: Array<{ tipe: string; urutan: number }>, tipe: "reguler" | "kanvas") {
    const sejenis = wave.filter((w) => w.tipe === tipe).map((w) => w.urutan);
    return tipe === "kanvas" ? 9 + sejenis.length : (sejenis.length ? Math.max(...sejenis) : 0) + 1;
}

type EventPayload = Record<string, unknown>;
const n = (v: unknown) => (Array.isArray(v) ? v.length : typeof v === "number" ? v : 0);

/** Baris Riwayat dari wave_event: kalimat tugas + perubahan singkat. */
export function labelEvent(event: string, payload: EventPayload = {}): { apa: string; ubah?: string } {
    switch (event) {
        case "wave.created": return { apa: "Membuat wave", ubah: `urutan ${String(payload.urutan ?? "?")} · ${String(payload.tipe ?? "")}` };
        case "wave.nota_added": return { apa: `Menambah ${n(payload.no_nota)} nota`, ubah: payload.prioritas === "urgent" ? "sebagai urgent" : undefined };
        case "wave.nota_add_rejected": return { apa: `${n(payload.no_nota)} nota ditolak`, ubah: "sudah ada di wave lain" };
        case "wave.groups_selected": return { apa: "Memilih grup cetak", ubah: `${n(payload.pick_group_ids)} grup` };
        case "wave.released": return { apa: "Merilis wave", ubah: `${n(payload.jumlah_nota)} nota · ${n(payload.exception_open)} masalah terdeteksi` };
        case "wave.confirmed": return { apa: "Mengonfirmasi wave", ubah: `${n(payload.jumlah_nota)} nota` };
        case "wave.cancelled": return { apa: "Membatalkan wave", ubah: [payload.nota_kembali ? `${n(payload.nota_kembali)} nota kembali ke pool` : "", payload.alasan ? String(payload.alasan) : ""].filter(Boolean).join(" · ") || undefined };
        case "wave.exception_resolved": return { apa: payload.status === "selesai" ? "Menandai masalah selesai" : "Mengabaikan masalah", ubah: [String(payload.ref_kode ?? ""), payload.alasan ? String(payload.alasan) : ""].filter(Boolean).join(" · ") };
        case "wave.nota_released": return { apa: `Melepas ${String(payload.no_nota ?? "")}`, ubah: payload.alasan ? String(payload.alasan) : undefined };
        case "wave.prioritas_changed": return { apa: `Mengubah prioritas ${String(payload.no_nota ?? "")}`, ubah: `ke ${String(payload.ke ?? "")}` };
        default: return { apa: event };
    }
}

export type { Load } from "@/components/fiori/interactive";
import type { Load } from "@/components/fiori/interactive";

/** GET JSON → Load; galat jaringan/HTTP/batas waktu jadi status galat (tidak pernah tampil sebagai kosong). */
export async function ambil<T>(url: string, pick: (json: unknown) => T = (j) => j as T, timeoutMs = 30_000): Promise<Load<T>> {
    try {
        const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            return { status: "galat", error: body.error ?? sebabHttp(res.status) };
        }
        return { status: "siap", data: pick(await res.json()) };
    } catch (e) {
        // TypeError = fetch gagal tersambung (pesan peramban "Failed to fetch" tidak boleh sampai ke pengguna).
        return { status: "galat", error: e instanceof DOMException && e.name === "TimeoutError" ? "Server tidak menjawab tepat waktu" : e instanceof TypeError ? sebabHttp(0) : e instanceof Error ? e.message : sebabHttp(500) };
    }
}
