/*
 * Tujuan: Helper geolocation klien untuk menangkap koordinat saat check-in/foto kunjungan.
 * Caller: components/form-kontrol/camera-capture.tsx & visit wizard (page.tsx).
 * Dependensi: navigator.geolocation (native browser, zero dependency).
 * Main Functions: getCurrentCoords, ambilLokasi (NOO: galat dibedakan).
 * Side Effects: Memicu prompt izin lokasi browser.
 */
export interface GeoCoords {
    lat: number;
    lng: number;
    accuracy: number; // meter
}

// ponytail: native geolocation, no lib. Resolve null (bukan reject) supaya flow tidak terblokir
// kalau user tolak izin / GPS mati — anti-fraud cukup di-FLAG server-side, bukan memblok kunjungan.
export function getCurrentCoords(timeoutMs = 8000): Promise<GeoCoords | null> {
    if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve(null);
    return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                accuracy: pos.coords.accuracy,
            }),
            () => resolve(null),
            { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
        );
    });
}

export type GalatLokasi = "ditolak" | "tidak_tersedia" | "waktu_habis" | "tidak_didukung";

/**
 * NOO (13 Okt 2026): lokasi WAJIB — berbeda dengan getCurrentCoords (null diam-diam), sebab kegagalan dibedakan supaya layar bisa menjelaskan
 * cara menyalakan izin lokasi. Error GeolocationPositionError: 1 = izin ditolak, 2 = posisi tidak tersedia, 3 = waktu habis.
 */
export function ambilLokasi(timeoutMs = 15000): Promise<{ coords: GeoCoords } | { galat: GalatLokasi }> {
    if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve({ galat: "tidak_didukung" });
    return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ coords: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy } }),
            (e) => resolve({ galat: e.code === 1 ? "ditolak" : e.code === 3 ? "waktu_habis" : "tidak_tersedia" }),
            { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
        );
    });
}
