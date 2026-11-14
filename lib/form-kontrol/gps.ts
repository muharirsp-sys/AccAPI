/*
 * Tujuan: GPS WAJIB saat check-in dan check-out kunjungan (owner 14 Nov 2026: "pada saat check-in sales harus terbaca koordinatnya … check-in
 *   check-out juga dipakai sebagai data analisa kunjungan tiap toko dan bahan briefing"). Dulu GPS check-in opsional (null + tanda
 *   `tanpa_lokasi`); sekarang server menolak tulis tanpa titik dengan kode berkalimat, layar meminta GPS dinyalakan lalu Coba lagi.
 * Caller: app/api/form-kontrol/checkin/route.ts, app/api/form-kontrol/checkout/route.ts; uji ./peta.test.ts.
 * Main Functions: periksaGps. Side Effects: tidak ada (murni).
 */

export type TitikGps = { lat: number; lng: number; accuracy: number };
export type GalatGps = { status: 400; kode: "GPS_WAJIB" | "GPS_TIDAK_SAH"; error: string };

const angka = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Badan POST {lat, lng, accuracy} (angka JSON) → titik, atau galat 400 berkode. `tahap` masuk ke kalimat. */
export function periksaGps(b: { lat?: unknown; lng?: unknown; accuracy?: unknown }, tahap: "check-in" | "check-out"): { titik: TitikGps } | { galat: GalatGps } {
    const lat = angka(b.lat), lng = angka(b.lng), accuracy = angka(b.accuracy);
    if (lat === null || lng === null || accuracy === null) {
        return { galat: { status: 400, kode: "GPS_WAJIB", error: `Lokasi GPS wajib saat ${tahap}. Nyalakan GPS/Lokasi ponsel dan izinkan lokasi untuk situs ini, lalu tekan Coba lagi.` } };
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180 || accuracy < 0) {
        return { galat: { status: 400, kode: "GPS_TIDAK_SAH", error: `Koordinat GPS ${tahap} tidak sah. Tekan Coba lagi untuk membaca lokasi ulang.` } };
    }
    return { titik: { lat, lng, accuracy } };
}
