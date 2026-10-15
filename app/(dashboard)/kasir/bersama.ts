/*
 * Tujuan: Tipe + I/O klien layar Kasir ↔ Incaso (K2b, BL-59): bentuk GET /api/kasir (KASIR-KONTRAK §8.3), tulis yang memisahkan jawaban
 *   PASTI dari TIDAK PASTI menurut §8.2 (BUKAN `tulis()` principal-order: di sana semua ≥ 502 dianggap tidak pasti, padahal 502 BACA_GAGAL /
 *   503 SESI_SINKRON = pasti), isian Rupiah manusia -> teks desimal, format Rupiah/WITA, label status & alasan.
 * Caller: Kasir.tsx, DialogKasir.tsx.
 * Dependensi: form-kontrol/lapangan (ambilJson), principal-order/bersama (baca, sebab, waktuWita), lib/insentif-sales-excel (parseLocaleNumber),
 *   lib/kasir/rekonsiliasi (keSen — murni), lib/promo-ui (rupiah).
 * Main Functions: bacaHari, bacaRincian, kirimKasir, nominalKeTeks, rp, jamWita, segarkan, ALASAN, LABEL_*.
 * Side Effects: fetch (bacaHari/bacaRincian/kirimKasir/segarkan); sisanya murni.
 */
import type { Tone } from "@/components/fiori/core";
import type { Load } from "@/components/fiori/interactive";
import { ambilJson } from "@/app/(dashboard)/form-kontrol/lapangan";
import { baca } from "@/app/(dashboard)/principal-order/bersama";
import { parseLocaleNumber } from "@/lib/insentif-sales-excel";
import { keSen } from "@/lib/kasir/rekonsiliasi";
import { rupiah } from "@/lib/promo-ui";

export { waktuWita } from "@/app/(dashboard)/principal-order/bersama";

/** Uang dari server = teks desimal ("1250000.00"); null = angka Incaso belum terbaca (BUKAN 0). */
export type Uang = string;
export type Metode = "CASH_OTHER" | "BANK_TRANSFER" | "BANK_CHEQUE";
export type StatusOrang = "klop" | "selisih" | "belum_setor" | "setoran_tanpa_pelunasan";
export type Dasar = { kode: string; revisi: number };
export type Setoran = { tunai: Uang; transfer: Uang; giro: Uang; total: Uang };
export type SetoranTerakhir = {
    id: number; kode: string; revisi: number; noFormKasir: string | null; buktiUrl: string | null; giroNomor: string | null;
    giroJatuhTempo: string | null; catatan: string | null; oleh: string; pada: string;
};
export type BarisOrang = {
    orang: string; nama: string; kode: string[];
    pelunasan: Uang | null; pelunasanPerMetode: Partial<Record<Metode, Uang>> | null; jumlahFaktur: number | null;
    setoran: Setoran | null; dasar: Dasar[]; setoranPerKode: (Dasar & Setoran)[]; setoranTerakhir: SetoranTerakhir | null;
    selisih: Uang | null; status: StatusOrang | null; dijelaskan: boolean | null; salesmanIdTakDikenal: number[] | null;
};
export type AlasanEmber = "jumlah_invoice_payment_beda" | "tanpa_baris_faktur" | "metode_tak_dikenal" | "nominal_negatif";
export type Ember = {
    pelunasanId: number; nomor: string; metode: string; chequeAmount: Uang; jumlahInvoicePayment: Uang; sisa: Uang;
    arah: "lebih_bayar" | "kredit"; alasan: AlasanEmber; orang: { orang: string; nama: string }[]; dijelaskan: boolean;
};
export type EventHari = { id: number; jenis: "tutup" | "kunci" | "buka"; alasan: string | null; oleh: string; pada: string };
export type Ditolak = { id: number; nomor: string; sebab: string; pesan: string };
/** §7 StatusPublik (publikkan). */
export type StatusBaca = {
    databaseId: string; tanggal: string; status: "berjalan" | "lengkap" | "sebagian" | "gagal" | "belum_dibaca"; aktif: boolean;
    sebab: string | null; pesan: string | null; jumlahDaftar: number | null; sisaDetail: number | null; ditolak: Ditolak[];
    mulaiPada: string | null; selesaiPada: string | null; lengkapPada: string | null; akun: string | null; pemicu: string | null;
    pemicuOleh: string | null; penuhTertundaPada: string | null;
};
export type RevisiSetoran = Dasar & Setoran & {
    id: number; orang: string; noFormKasir: string | null; buktiUrl: string | null; giroNomor: string | null; giroJatuhTempo: string | null;
    catatan: string | null; oleh: string; pada: string;
};
export type Penjelasan =
    | { id: number; jenis: "selisih"; orang: string; pelunasan: Uang; setoran: Uang; penjelasan: string; tindakLanjut: TindakLanjut; oleh: string; pada: string; berlaku: boolean | null }
    | { id: number; jenis: "tak_teralokasi"; pelunasanId: number; sisa: Uang; penjelasan: string; oleh: string; pada: string; berlaku: boolean | null };
export type TindakLanjut = "setor_susulan" | "koreksi_incaso" | "lapor_om";
export type Hari = {
    ok: true; tanggal: string; sekarang: string;
    hari: { terkunci: boolean; sebab: "tutup" | "kunci" | "otomatis_20" | null; kunciBerikutnya: string | null; bolehDiubah: boolean; hariKerja: boolean;
        berubahSejakDitutup: boolean | null; event: EventHari[] };
    baca: StatusBaca | null;
    segarUntukTutup: boolean;
    incaso: { lengkap: boolean; sebab: null | "SESI_SINKRON" | "BACA_BELUM_LENGKAP"; pesan: string | null };
    total: { pelunasan: Uang | null; setoran: Uang; selisih: Uang | null; takTeralokasi: Uang | null; takTeralokasiBelumDijelaskan: number | null;
        nonKas: Uang | null; klop: number | null; jumlahOrang: number };
    orang: BarisOrang[];
    takTeralokasi: Ember[] | null;
    nonKas: { pelunasanId: number; nomor: string; metode: string; chequeAmount: Uang }[] | null;
    penghalangTutup: { bisaDitutup: boolean; alasan: string[] } | null;
    sidik: string | null;
    riwayat: { setoran: RevisiSetoran[]; penjelasan: Penjelasan[] };
    pegawai: { kode: string; orang: string; nama: string }[];
};
export type Rincian = { orang: string; pelunasan: { pelunasanId: number; nomor: string; metode: string; chequeAmount: Uang; bagian: Uang;
    faktur: { fakturId: number; nomorFaktur: string | null; invoicePayment: Uang }[] }[] } | null;

export const bacaHari = (tanggal: string): Promise<Load<Hari>> =>
    baca(`/api/kasir?tanggal=${encodeURIComponent(tanggal)}`, (j) => j as unknown as Hari, "Data Kasir hari ini gagal dimuat.");

export const bacaRincian = (tanggal: string, orang: string): Promise<Load<Rincian>> =>
    baca(`/api/kasir?${new URLSearchParams({ tanggal, orang })}`, (j) => (j.rincian ?? null) as Rincian, "Rincian faktur gagal dimuat.");

/**
 * Jawaban tulis Kasir (§8.2). `ragu` = TIDAK PASTI: putus/abort/timeout (status 0), badan bukan JSON (halaman proxy), `kode: TIDAK_PASTI`,
 * ≥ 500 tanpa kode PASTI yang dikenal, atau 2xx tanpa `ok: true`. Selain itu `tolak` = pasti tidak tersimpan (401/403 tanpa kode = bawaan).
 */
export type Jawab = { jenis: "ok"; data: Record<string, unknown> }
    | { jenis: "tolak"; http: number; kode: string; pesan: string; field?: string; alasan?: string[]; data: Record<string, unknown> }
    | { jenis: "ragu" };

/** Kode ≥ 500 yang tetap PASTI: route Kasir (GALAT_INTERNAL, SESI_SINKRON) + segarkan baca-saja (BACA_GAGAL 502, SESI_SINKRON 503). */
const PASTI_5XX = new Set(["GALAT_INTERNAL", "SESI_SINKRON", "BACA_GAGAL"]);

export function nilaiJawab(status: number, data: Record<string, unknown> | null): Jawab {
    if (status === 0 || data === null) return { jenis: "ragu" };
    if (status >= 200 && status < 300) return data.ok === true ? { jenis: "ok", data } : { jenis: "ragu" };
    const kode = typeof data.kode === "string" ? data.kode : "";
    if (kode === "TIDAK_PASTI" || (status >= 500 && !PASTI_5XX.has(kode))) return { jenis: "ragu" };
    const pesan = typeof data.error === "string" && data.error && data.error !== "Unauthorized" && data.error !== "Forbidden" ? data.error : "";
    return { jenis: "tolak", http: status, kode, pesan: pesan || pesanBawaan(status), data,
        ...(typeof data.field === "string" ? { field: data.field } : {}),
        ...(Array.isArray(data.alasan) ? { alasan: data.alasan.map(String) } : {}) };
}

function pesanBawaan(status: number) {
    if (status === 401) return "Sesi login berakhir; masuk ulang lalu coba lagi. Tidak ada yang tersimpan.";
    if (status === 403) return "Akun Anda tidak berhak melakukan aksi ini; minta admin menambahkan izinnya. Tidak ada yang tersimpan.";
    return "Server menolak permintaan. Tidak ada yang tersimpan.";
}

/** POST JSON atau FormData (multipart: bagian `data` + berkas `bukti`, §8.4). */
export async function kirimKasir(url: string, body: Record<string, unknown> | FormData): Promise<Jawab> {
    const form = body instanceof FormData;
    const j = await ambilJson(url, {
        method: "POST", credentials: "include",
        headers: form ? undefined : { "Content-Type": "application/json" },
        body: form ? body : JSON.stringify(body),
    });
    return nilaiJawab(j.status, j.data);
}

/** POST /api/kasir/segarkan (§7, baca-saja). */
export const segarkan = (tanggal: string, opsi: { penuh?: boolean; konfirmasiHapus?: boolean } = {}) =>
    kirimKasir("/api/kasir/segarkan", { tanggal, ...(opsi.penuh ? { penuh: true } : {}), ...(opsi.konfirmasiHapus ? { konfirmasiHapus: true } : {}) });

/** Batas server §8.4 (Rp 100 miliar per kolom). */
export const MAKS_NOMINAL = 100_000_000_000;

/**
 * Isian manusia ("Rp 1.250.000", "1.250.000,50", kosong = 0) -> teks desimal untuk server ("1250000", "1250000.5"); `null` + sebab bila
 * tidak sah (negatif, > 2 desimal, di luar batas). Sen dihitung TEPAT lewat keSen (bukan float).
 */
export function nominalKeTeks(isian: string): { teks: string; sen: number } | { galat: string } {
    const v = parseLocaleNumber(isian);
    if (!Number.isFinite(v)) return { galat: "Isi angka rupiah yang sah, mis. 1.250.000." };
    if (v < 0) return { galat: "Nominal tidak boleh negatif." };
    if (v > MAKS_NOMINAL) return { galat: "Nominal maksimal Rp 100.000.000.000." };
    try {
        const sen = keSen(v);
        return { teks: String(v), sen };
    } catch {
        return { galat: "Maksimal 2 angka di belakang koma." };
    }
}

/** Teks uang server -> sen (null bila kosong/rusak). */
export function senDari(t: Uang | null | undefined): number | null {
    if (t == null) return null;
    try { return keSen(t); } catch { return null; }
}

/** "Rp 1.250.000"; negatif = "−Rp 400.000". */
export function rp(t: Uang | number | null | undefined): string {
    if (t == null || t === "") return "—";
    const n = Number(t);
    if (!Number.isFinite(n)) return "—";
    return `${n < 0 ? "−" : ""}${rupiah(Math.abs(n))}`;
}
export const rpSen = (sen: number) => rp(sen / 100);

/** Klop = sama persis ATAU sama dengan pelunasan dibulatkan ke atas ke kelipatan Rp 100 (owner 7 Okt). */
export const bulatAtas100 = (sen: number) => Math.ceil(sen / 10_000) * 10_000;

/** "16.20" WITA. */
export function jamWita(iso: string | null | undefined) {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Makassar", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

/** YYYY-MM-DD -> "Senin, 5 Okt 2026". */
export function tanggalPanjang(ymd: string) {
    const d = new Date(`${ymd}T12:00:00+08:00`);
    return Number.isNaN(d.getTime()) ? ymd
        : new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Makassar", weekday: "long", day: "numeric", month: "short", year: "numeric" }).format(d);
}

/** Panjang per CODE POINT sesudah trim (= char_length Postgres, §8.1). */
export const panjang = (s: string) => [...s.trim()].length;

export const LABEL_STATUS: Record<StatusOrang, { label: string; tone: Tone }> = {
    klop: { label: "Klop", tone: "pos" },
    selisih: { label: "Selisih", tone: "warn" },
    belum_setor: { label: "Belum setor", tone: "neg" },
    setoran_tanpa_pelunasan: { label: "Setoran tanpa pelunasan", tone: "warn" },
};
export const LABEL_METODE: Record<string, string> = { CASH_OTHER: "Tunai", BANK_TRANSFER: "Transfer", BANK_CHEQUE: "Giro", OTHERS: "Non-kas" };
export const labelMetode = (m: string) => LABEL_METODE[m] ?? `metode ${m}`;
export const LABEL_TINDAK: Record<TindakLanjut, string> = { setor_susulan: "Setor susulan", koreksi_incaso: "Pelunasan Incaso dikoreksi", lapor_om: "Lapor ke OM" };
export function labelEmber(e: Pick<Ember, "alasan" | "arah">) {
    if (e.alasan === "jumlah_invoice_payment_beda") return e.arah === "lebih_bayar" ? "Lebih bayar (uang melebihi jumlah faktur)" : "Kredit (jumlah faktur melebihi uang)";
    return { tanpa_baris_faktur: "Tanpa baris faktur", metode_tak_dikenal: "Metode pembayaran tak dikenal", nominal_negatif: "Nominal negatif" }[e.alasan];
}
export const namaTampil = (b: { orang: string; nama: string }) => (b.orang === "" ? "Tanpa salesman" : b.nama && b.nama !== b.orang ? `${b.orang} · ${b.nama}` : b.orang);

/** Kalimat izin tanpa nama kunci mentah. */
export const ALASAN = {
    catat: "Akun Anda belum berhak mencatat setoran atau penjelasan Kasir; minta admin menambahkan izin Catat Kasir ke grup Anda.",
    tutup: "Akun Anda belum berhak menutup hari Kasir; minta admin menambahkan izin Tutup hari Kasir ke grup Anda.",
    buka: "Membuka kembali hari yang terkunci hanya untuk OM/Admin.",
    hapus: "Minta OM/Admin mengonfirmasi penghapusan ini — hanya mereka yang boleh.",
};
