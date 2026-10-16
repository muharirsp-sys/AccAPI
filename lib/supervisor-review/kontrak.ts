/*
 * Tujuan: KONTRAK bersama Supervisor Review — bentuk jawaban API yang disepakati SEBELUM SR-1 (server), SR-2 (layar), SR-3 (peta)
 *   dikerjakan paralel. Spec: docs/superpowers/specs/2026-10-16-supervisor-review-design.md.
 * Caller: SR-1 app/api/supervisor-review/** (pembuat jawaban), SR-2 app/(dashboard)/supervisor-review/** + tabs/TabHierarki,
 *   SR-3 app/(dashboard)/supervisor-review/Peta.tsx + form-kontrol/tabs/TabKoordinat.
 * Aturan: hanya tipe + konstanta, tanpa logika. Mengubah berkas ini = mengubah kontrak → koordinasikan lewat orkestrator, jangan diam-diam.
 */

/** ⚪ belum check-in hari itu · 🟢 sedang di toko (check-in tanpa check-out) · 🔵 sudah berkunjung, sedang tidak di toko. */
export type StatusSalesman = "belum" | "di_toko" | "sudah";

/** Angka ringkasan (spec §2). Jam = desimal (1.5 = 1 jam 30 menit). Nilai rupiah = DPP sebelum PPN. */
export interface Angka {
    registeredOutlet: number;
    callPlan: number;
    callRute: number;
    callNonRute: number;
    ec: number;
    noo: number;
    quantity: number;
    itemPerEc: number;
    nilaiOrder: number;
    omzetPerEc: number;
    jamDiToko: number;
    jamPerjalanan: number;
}

export interface BarisSalesman extends Angka {
    cabang: string;
    /** "" = baris "Tanpa salesman terpetakan" (faktur yang masterSalesmanId-nya tak punya kode). */
    salesCode: string;
    nama: string;
    status: StatusSalesman;
    /** https://wa.me/628…?text=… siap pakai; null = No HP belum diisi (tombol nonaktif + petunjuk). */
    waUrl: string | null;
}

export interface TotalCabang extends Angka {
    cabang: string;
}

/** rute = toko jadwal hari itu · luar_rute = kunjungan_luar_rute · tanpa_checkin = toko berfaktur tanpa check-in (EC + Call Non Rute). */
export type JenisKunjungan = "rute" | "luar_rute" | "tanpa_checkin";

export interface Kunjungan {
    salesCode: string;
    custCode: string;
    namaToko: string;
    jenis: JenisKunjungan;
    /** ISO 8601 dengan zona (+08:00); null untuk tanpa_checkin. */
    mulai: string | null;
    selesai: string | null;
    menitDiToko: number | null;
    /** Dari check-out kunjungan sebelumnya; null untuk kunjungan pertama / tanpa check-out. */
    menitTempuh: number | null;
    qty: number | null;
    item: number | null;
    nilai: number | null;
    ec: boolean;
    /** ORDER di Form Kontrol tanpa faktur hari itu. */
    belumDifakturkan: boolean;
    /** Titik check-in (null bila tanpa GPS / tanpa_checkin). */
    lat: number | null;
    lng: number | null;
    /** Jarak titik check-in ke toko_koordinat; null bila salah satu tak ada. Tandai "jauh" bila > JARAK_JAUH_M. */
    jarakKeTokoM: number | null;
}

/** Penanda toko di peta (hanya toko yang punya toko_koordinat). */
export type StatusToko = "ec" | "tanpa_ec" | "belum" | "faktur_tanpa_checkin";

export interface PenandaToko {
    custCode: string;
    namaToko: string;
    salesCode: string;
    lat: number;
    lng: number;
    status: StatusToko;
}

/** GET /api/supervisor-review?tanggal=YYYY-MM-DD&cabang=&principle= (izin supervisor_review.view; cakupan resolveScope). */
export interface JawabanSupervisorReview {
    /** YYYY-MM-DD WITA; bawaan witaToday(). */
    tanggal: string;
    /** ISO waktu jawaban dibuat ("data per HH.MM"). */
    diperbaruiPada: string;
    cakupan: "global" | "sm" | "spv" | "salesman";
    pilihanCabang: string[];
    pilihanPrinciple: string[];
    salesman: BarisSalesman[];
    totalCabang: TotalCabang[];
    /** Semua kunjungan dalam cakupan, urut salesCode lalu mulai (tanpa_checkin di akhir per salesman). */
    kunjungan: Kunjungan[];
    penanda: PenandaToko[];
    /** Toko JKS dalam cakupan yang belum punya toko_koordinat. */
    tokoTanpaKoordinat: number;
    /** Faktur hari itu yang rinciannya belum terbaca (qty_total NULL = ringkasan rincian belum terisi), per cabang. */
    fakturBelumTerbaca: { cabang: string; jumlah: number }[];
    /** Isi bila tabel sengaja kosong, mis. "HIERARKI_BELUM_TERTAUT" (akun SPV/SM tak cocok Hierarki). */
    pesan?: { kode: string; teks: string };
}

/** POST /api/supervisor-review/koordinat — multipart field `file` (xlsx: kode toko, latitude, longitude); izin form_kontrol.manage. */
export interface JawabanUnggahKoordinat {
    disimpan: number;
    /** baris = nomor baris Excel (header = 1). Baris sah tetap disimpan. */
    ditolak: { baris: number; kode: string; pesan: string }[];
}

/** GET /api/supervisor-review/koordinat — ringkasan untuk tab Koordinat Toko. */
export interface RingkasanKoordinat {
    tokoJks: number;
    berKoordinat: number;
    /** Maks. 200 kode JKS aktif tanpa koordinat, untuk templat unduh. */
    contohTanpaKoordinat: { custCode: string; namaToko: string }[];
}

/**
 * Hierarki (app/api/form-kontrol/sales-profiles): GET rows bertambah `noHp: string | null`; PUT menerima `noHp` opsional
 * (string kosong/null = hapus; selain itu wajib bentuk 08… setelah dinormalkan, jika tidak 400 kode NO_HP_TIDAK_SAH).
 */
export interface HierarkiNoHp {
    noHp?: string | null;
}

/** Ambang "jauh dari toko" (meter). ponytail: satu konstanta, setel dari data nyata (akurasi GPS median ±11 m per 15 Okt). */
export const JARAK_JAUH_M = 200;
