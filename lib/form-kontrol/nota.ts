/*
 * Tujuan: Nota belum lunas toko + hasil tagih kunjungan (owner 16 Nov 2026) — bagian MURNI (tanpa DB/Accurate, diuji nota.test.ts):
 *   baris faktur Accurate (list.do) / cache -> Nota (umur, nilai keluar, tertagih, sisa, jatuh tempo), ringkasan per toko, dan pemeriksa isian
 *   tagihan dari layar (tertagih + nominal | tidak tertagih + alasan).
 * Caller: lib/form-kontrol/nota-db.ts (bacaNotaToko, ringkasNotaRute), app/api/form-kontrol/ao-control (periksaTagihan),
 *   app/(dashboard)/form-kontrol/visit/[custCode]/Nota.tsx (tipe + teks).
 * Dependensi: ./constants (ALASAN_TIDAK_TERTAGIH, TOKO_TUTUP_CODE).
 * Main Functions: tanggalIso, notaDariBaris, ringkasNota, periksaTagihan, tagihanTokoTutup.
 * Side Effects: Tidak ada.
 *
 * Definisi (owner 16 Nov 2026, "berapa yang keluar, berapa yang tertagih"): keluar = nilai faktur (totalAmount, termasuk PPN); sisa = primeOwing
 * Accurate (sisa piutang sesudah pelunasan yang diinput Incaso, retur, potongan); tertagih = keluar − sisa. Umur = hari sejak tanggal faktur
 * (WITA). Hanya faktur dengan sisa > Rp 0,50 (pembulatan Accurate) yang dihitung; faktur retur bernilai negatif tidak ikut.
 */
import { ALASAN_TIDAK_TERTAGIH, TOKO_TUTUP_CODE } from "./constants";

export type Nota = {
    id: number;
    nomor: string;
    /** YYYY-MM-DD. */
    tanggal: string;
    jatuhTempo: string | null;
    /** Nilai faktur (keluar). */
    nilai: number;
    /** Sudah dibayar / dipotong (nilai − sisa). */
    tertagih: number;
    sisa: number;
    /** Hari sejak tanggal faktur s.d. hari ini WITA. */
    umur: number;
    /** Hari lewat jatuh tempo (> 0), null = belum jatuh tempo / tanpa jatuh tempo. */
    lewatTempo: number | null;
};
export type RingkasanNota = { jumlah: number; nilai: number; tertagih: number; sisa: number; umurMaks: number; lewatTempo: number };
/** Pembayaran yang tercatat Incaso (cache pelunasan Kasir ↔ Incaso) untuk satu nota. */
export type BayarNota = { fakturId: number; tanggal: string; nomor: string; metode: string; nominal: number };
export type NotaToko = {
    /** accurate = dibaca langsung saat ini; sinkron = cache sales_invoice (Accurate tidak terbaca), bisa tertinggal ± 1 jam. */
    sumber: "accurate" | "sinkron";
    dibacaPada: string;
    nota: Nota[];
    ringkas: RingkasanNota;
    bayar: BayarNota[];
    /** Daftar dari Accurate lebih panjang dari batas baca — angka mungkin kurang. */
    terpotong: boolean;
};

const SISA_MIN = 0.5;

/** "dd/MM/yyyy" (Accurate) atau "YYYY-MM-DD" -> "YYYY-MM-DD"; selain itu null. */
export function tanggalIso(v: unknown): string | null {
    const t = String(v ?? "").trim();
    const a = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(t);
    if (a) return `${a[3]}-${a[2]}-${a[1]}`;
    return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
}

const hari = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
const angka = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

/**
 * Baris faktur (list.do: id, number, transDate, dueDate, totalAmount, primeOwing — atau kolom cache yang dipetakan ke nama itu) -> Nota yang
 * masih bersisa, urut paling tua dulu. Baris rusak (tanggal/angka tak terbaca) dilewati — bukan dikarang.
 */
export function notaDariBaris(rows: readonly Record<string, unknown>[], hariIni: string): Nota[] {
    const kini = hari(hariIni);
    const per = new Map<number, Nota>();
    for (const r of rows) {
        const id = angka(r.id), nilai = angka(r.totalAmount), sisa = angka(r.primeOwing), tanggal = tanggalIso(r.transDate);
        if (!Number.isFinite(id) || !Number.isFinite(nilai) || !Number.isFinite(sisa) || !tanggal || sisa <= SISA_MIN) continue;
        const jatuhTempo = tanggalIso(r.dueDate);
        const lewat = jatuhTempo ? Math.round(kini - hari(jatuhTempo)) : 0;
        per.set(id, {
            id, nomor: String(r.number ?? "").trim(), tanggal, jatuhTempo, nilai,
            tertagih: Math.max(0, Math.round((nilai - sisa) * 100) / 100), sisa,
            umur: Math.max(0, Math.round(kini - hari(tanggal))), lewatTempo: lewat > 0 ? lewat : null,
        });
    }
    return [...per.values()].sort((a, b) => b.umur - a.umur || a.nomor.localeCompare(b.nomor));
}

export function ringkasNota(nota: readonly Nota[]): RingkasanNota {
    const jumlahkan = (k: "nilai" | "tertagih" | "sisa") => Math.round(nota.reduce((s, n) => s + n[k], 0) * 100) / 100;
    return { jumlah: nota.length, nilai: jumlahkan("nilai"), tertagih: jumlahkan("tertagih"), sisa: jumlahkan("sisa"),
        umurMaks: nota.reduce((m, n) => Math.max(m, n.umur), 0), lewatTempo: nota.filter((n) => n.lewatTempo !== null).length };
}

/** Hasil tagih satu kunjungan (ao_control_daily.tagih_*). */
export type Tagihan =
    | { status: "tertagih"; nominal: number; catatan: string | null }
    | { status: "tidak_tertagih"; alasan: string; catatan: string | null };

const NOMINAL_MAKS = 10_000_000_000;

/**
 * Isian `tagihan` dari layar: undefined = tidak dikirim (kolom tidak diubah), null = dikosongkan (toko tanpa nota), selain itu harus sah:
 * tertagih + nominal rupiah > 0 (≤ 10 miliar, 2 desimal) | tidak_tertagih + kode ALASAN_TIDAK_TERTAGIH. Catatan ≤ 300 huruf; "LAINNYA" wajib
 * bercatatan. Kelengkapan (wajib bila toko punya nota) dijaga layar — nota dibaca langsung dari Accurate, cache server bisa tertinggal.
 */
export function periksaTagihan(v: unknown): { tagihan: Tagihan | null | undefined } | { error: string } {
    if (v === undefined) return { tagihan: undefined };
    if (v === null) return { tagihan: null };
    if (typeof v !== "object" || Array.isArray(v)) return { error: "Isian tagihan tidak terbaca." };
    const o = v as Record<string, unknown>;
    const catatan = typeof o.catatan === "string" && o.catatan.trim() ? o.catatan.trim().slice(0, 300) : null;
    if (o.status === "tertagih") {
        // Dinilai SESUDAH dibulatkan ke sen: 0,004 = Rp 0,00 akan ditolak CHECK DB (tagih_nominal > 0) sebagai 500, bukan 400.
        const n = Math.round(angka(o.nominal) * 100) / 100;
        if (!Number.isFinite(n) || n <= 0 || n > NOMINAL_MAKS) return { error: "Nominal tertagih harus lebih dari Rp 0." };
        return { tagihan: { status: "tertagih", nominal: n, catatan } };
    }
    if (o.status === "tidak_tertagih") {
        const alasan = typeof o.alasan === "string" ? o.alasan.trim() : "";
        if (!ALASAN_TIDAK_TERTAGIH.some((a) => a.kode === alasan)) return { error: "Pilih alasan nota tidak tertagih." };
        if (alasan === "LAINNYA" && !catatan) return { error: "Alasan Lainnya wajib diberi catatan." };
        return { tagihan: { status: "tidak_tertagih", alasan, catatan } };
    }
    return { error: "Pilih Tertagih atau Tidak tertagih." };
}

/** Toko tutup (R15): tidak ditanya — nota otomatis tidak tertagih beralasan toko tutup. */
export const tagihanTokoTutup = (reasonCode: string | null | undefined): Tagihan | null =>
    reasonCode === TOKO_TUTUP_CODE ? { status: "tidak_tertagih", alasan: "TOKO_TUTUP", catatan: null } : null;
