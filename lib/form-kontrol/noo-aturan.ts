/*
 * Tujuan: Aturan MURNI NOO (toko baru dari kunjungan salesman, owner 13 Okt 2026) — dipakai server (route) DAN layar (validasi sebelum kirim):
 *   kode NOO, No. HP Indonesia kanonik, NIK 16 digit, NIK tersamar, pemeriksa isian formulir, label status.
 * Caller: lib/form-kontrol/noo.ts, app/api/form-kontrol/noo/**, app/api/form-kontrol/ao-control (lewat noo.ts),
 *   app/(dashboard)/form-kontrol/tabs/{TabNoo,NooFormulir,TabAo}.tsx, visit/[custCode]/Kunjungan.tsx, spv-dashboard/DashboardSpv.tsx.
 * Dependensi: tidak ada (aman di klien).
 * Main Functions: isKodeNoo, normalHp, periksaNik, samarkanNik, periksaIsianNoo, LABEL_STATUS_NOO.
 * Side Effects: Tidak ada.
 */

/** Kode NOO = "NOO-" + 8 huruf/angka besar; juga cust_code kunjungan NOO di kunjungan_luar_rute/ao_control_daily. */
export const POLA_KODE_NOO = /^NOO-[0-9A-Z]{8}$/;
// ponytail: penanda layar "kunjungan NOO" = bentuk kode (cust_code kunjungan); server memutuskan dari tabel noo_toko (noo.ts tolakOrderNoo).
//   Plafon: pelanggan Accurate yang kebetulan berkode "NOO-XXXXXXXX" akan berlabel NOO di layar (tidak memengaruhi izin/order di server).
export const isKodeNoo = (kode: unknown): boolean => typeof kode === "string" && POLA_KODE_NOO.test(kode);

export type StatusNoo = "menunggu_spv" | "disetujui" | "ditolak" | "terdaftar";
export const LABEL_STATUS_NOO: Record<StatusNoo, string> = {
    menunggu_spv: "Menunggu SPV",
    disetujui: "Disetujui — menunggu didaftarkan",
    ditolak: "Ditolak",
    terdaftar: "Terdaftar",
};

/**
 * No. HP Indonesia → bentuk kanonik "08…" (10–13 digit), atau null. Menerima +62/62/0, spasi, titik, tanda hubung, kurung.
 * Hanya nomor seluler (08x; x ≠ 0) — sama dengan CHECK noo_toko_pribadi.
 */
export function normalHp(v: unknown): string | null {
    let s = String(v ?? "").replace(/[\s.\-()]/g, "");
    if (s.startsWith("+62")) s = `0${s.slice(3)}`;
    else if (s.startsWith("62")) s = `0${s.slice(2)}`;
    return /^08[1-9][0-9]{7,10}$/.test(s) ? s : null;
}

/** NIK = tepat 16 angka (spasi di antara kelompok angka dibuang); selain itu null. */
export function periksaNik(v: unknown): string | null {
    const s = String(v ?? "").replace(/\s/g, "");
    return /^[0-9]{16}$/.test(s) ? s : null;
}

/** Tampilan bawaan NIK: 4 angka depan + 8 titik + 4 angka belakang (7371••••••••0012). Bukan NIK sah → "—". */
export const samarkanNik = (nik: string | null | undefined): string =>
    nik && /^[0-9]{16}$/.test(nik) ? `${nik.slice(0, 4)}${"•".repeat(8)}${nik.slice(12)}` : "—";

export type IsianNoo = {
    namaToko: string; namaPemilik: string; alamat: string; noHp: string; nik: string; namaKtp: string;
    lat: number; lng: number; akurasi: number;
};
export type GalatIsian = { kode: string; error: string };

const BATAS = { namaToko: 120, namaPemilik: 120, alamat: 300, namaKtp: 120 } as const;
const LABEL = { namaToko: "Nama toko", namaPemilik: "Nama pemilik", alamat: "Alamat", namaKtp: "Nama sesuai KTP" } as const;
const angka = (v: unknown): number | null => {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v !== "string" || !v.trim()) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/**
 * Isian formulir NOO (FormData atau objek; nilai teks) → isian bersih, atau galat berkode berkalimat Indonesia.
 * Galat TIDAK pernah memuat nilai NIK/HP yang diketik (data pribadi tidak masuk pesan galat).
 */
export function periksaIsianNoo(ambil: (k: string) => unknown): { isian: IsianNoo } | { galat: GalatIsian } {
    const teks = {} as Record<keyof typeof BATAS, string>;
    for (const k of Object.keys(BATAS) as (keyof typeof BATAS)[]) {
        const v = String(ambil(k) ?? "").replace(/\s+/g, " ").trim();
        if (!v) return { galat: { kode: "ISIAN_WAJIB", error: `${LABEL[k]} wajib diisi.` } };
        if (v.length > BATAS[k]) return { galat: { kode: "ISIAN_TERLALU_PANJANG", error: `${LABEL[k]} maksimal ${BATAS[k]} karakter.` } };
        teks[k] = v;
    }
    const noHp = normalHp(ambil("noHp"));
    if (!noHp) return { galat: { kode: "HP_TIDAK_SAH", error: "No. HP pemilik harus nomor seluler Indonesia (08…, +62…), 10–13 angka." } };
    const nik = periksaNik(ambil("nik"));
    if (!nik) return { galat: { kode: "NIK_TIDAK_SAH", error: "NIK harus tepat 16 angka sesuai KTP." } };
    const lat = angka(ambil("lat")), lng = angka(ambil("lng")), akurasi = angka(ambil("akurasi"));
    if (lat === null || lng === null || akurasi === null) {
        return { galat: { kode: "GPS_WAJIB", error: "Lokasi GPS toko wajib. Nyalakan izin lokasi di peramban lalu ambil lokasi lagi." } };
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180 || akurasi < 0) {
        return { galat: { kode: "GPS_TIDAK_SAH", error: "Koordinat GPS tidak sah; ambil lokasi lagi." } };
    }
    return { isian: { ...teks, noHp, nik, lat, lng, akurasi } };
}
