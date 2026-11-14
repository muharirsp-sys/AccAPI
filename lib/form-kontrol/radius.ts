/*
 * Tujuan: Radius check-in/check-out terhadap titik toko (owner 14 Nov 2026): titik FIX maks. 20 m, titik yang masih perlu VALIDASI maks. 100 m;
 *   di luar radius salesman mengajukan ke IT (alasan wajib) dan kunjungan tetap berlanjut. Toko TANPA titik = tanpa radius: titik check-in
 *   pertama dikumpulkan untuk dianalisa (Antrean perbaikan lokasi), bukan diblok.
 * Caller: app/api/form-kontrol/{checkin,checkout}/route.ts (lewat lib/form-kontrol/db.ts cekRadiusKunjungan), layar Validasi Lokasi; uji ./peta.test.ts.
 * Dependensi: lib/supervisor-review/ringkasan haversineM (murni). Main Functions: periksaRadius, kalimatLuarRadius, alasanAjuanSah.
 * Side Effects: tidak ada.
 */
import { haversineM } from "../supervisor-review/ringkasan";

export const RADIUS_M = { fix: 20, validasi: 100 } as const;
export type StatusTitik = keyof typeof RADIUS_M;
export const STATUS_TITIK = Object.keys(RADIUS_M) as StatusTitik[];
export const LABEL_STATUS_TITIK: Record<StatusTitik, string> = { fix: "Titik fix", validasi: "Perlu validasi" };
/**
 * Toleransi akurasi GPS (owner 14 Nov 2026): jarak dikurangi akurasi yang dilaporkan ponsel, paling banyak 15 m — titik fix 20 m paling longgar
 * 35 m saat GPS kurang akurat; GPS bagus (±5 m) tetap ±25 m.
 */
export const TOLERANSI_AKURASI_M = 15;
/** Alasan pengajuan ke IT minimal sekian huruf (bukan "-" / "ok"). */
export const MIN_ALASAN = 10;
export const MAKS_ALASAN = 300;

export type TitikToko = { lat: number; lng: number; status: StatusTitik };
export type HasilRadius =
    | { dalam: true; jarakM: number | null; radiusM: number | null }
    | { dalam: false; jarakM: number; radiusM: number; toleransiM: number; statusTitik: StatusTitik; titik: TitikToko };

/** Status tersimpan tak dikenal dianggap 'validasi' (radius longgar) — tidak pernah lebih ketat dari keputusan owner. */
export const statusTitik = (v: unknown): StatusTitik => (v === "fix" ? "fix" : "validasi");

/**
 * Titik salesman vs titik toko. Tanpa titik toko = dalam (tanpa radius); jarak dibulatkan meter. Dalam bila jarak − min(akurasi, 15 m) ≤ batas
 * (akurasi tak ada / negatif = tanpa toleransi).
 */
export function periksaRadius(sales: { lat: number; lng: number; accuracy?: number | null }, toko: TitikToko | null): HasilRadius {
    if (!toko) return { dalam: true, jarakM: null, radiusM: null };
    const radiusM = RADIUS_M[toko.status];
    const jarakM = Math.round(haversineM(sales, toko));
    const toleransiM = Math.round(Math.min(TOLERANSI_AKURASI_M, Math.max(0, sales.accuracy ?? 0)));
    return jarakM - toleransiM <= radiusM ? { dalam: true, jarakM, radiusM }
        : { dalam: false, jarakM, radiusM, toleransiM, statusTitik: toko.status, titik: toko };
}

const angka = (n: number) => new Intl.NumberFormat("id-ID").format(Math.round(n));

/** Kalimat penolakan 409 DI_LUAR_RADIUS (tampil di layar kunjungan apa adanya). */
export function kalimatLuarRadius(h: Extract<HasilRadius, { dalam: false }>, akurasiM: number, tahap: "check-in" | "check-out"): string {
    return `Lokasi ${tahap} Anda ±${angka(h.jarakM)} m dari titik toko (batas ${h.radiusM} m untuk ${LABEL_STATUS_TITIK[h.statusTitik].toLowerCase()}, `
        + `ditambah toleransi akurasi GPS ±${angka(h.toleransiM)} m dari akurasi ±${angka(akurasiM)} m). Pastikan Anda di depan toko lalu tekan Coba lagi, `
        + `atau ajukan ke IT dengan alasan bila titik toko memang keliru.`;
}

/** Alasan pengajuan: ter-trim, MIN_ALASAN..MAKS_ALASAN huruf; selain itu null. */
export function alasanAjuanSah(v: unknown): string | null {
    const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
    return t.length >= MIN_ALASAN && t.length <= MAKS_ALASAN ? t : null;
}
