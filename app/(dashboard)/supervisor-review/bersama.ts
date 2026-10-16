/*
 * Tujuan: Helper murni + pembaca data layar Supervisor Review (SR-2): format angka Indonesia, definisi kolom ringkasan (satu daftar untuk
 *   tabel, baris TOTAL, dan rincian ponsel), label status, dan GET /api/supervisor-review.
 * Caller: ./SupervisorReview.tsx, ./Rincian.tsx.
 * Dependensi: lib/supervisor-review/kontrak (tipe jawaban), lib/promo-ui (rupiah), ../form-kontrol/shared (ambilFk: galat berkalimat Indonesia).
 * Main Functions: bacaSupervisorReview, KOLOM, STATUS, angka, rp, tanggalPanjang, namaBaris, kunciBaris.
 * Side Effects: bacaSupervisorReview melakukan fetch GET; sisanya pure.
 */
import type { Load } from "@/components/fiori/interactive";
import { rupiah } from "@/lib/promo-ui";
import type { Angka, BarisSalesman, JawabanSupervisorReview, StatusSalesman } from "@/lib/supervisor-review/kontrak";
import { ambilFk } from "../form-kontrol/shared";

export const TANPA_HP = "No HP belum diisi — Admin: tab Hierarki";
export const TANPA_SALESMAN = "Tanpa salesman terpetakan";
export const TANPA_RINCIAN = "Faktur tanpa salesman terpetakan tidak dipecah per toko — periksa kode salesman faktur di Accurate.";

const NF = [0, 1, 2].map((maks) => new Intl.NumberFormat("id-ID", { maximumFractionDigits: maks }));
/** 1234.5 → "1.234,5" (maks. `maks` desimal, koma desimal). */
export const angka = (n: number, maks: 0 | 1 | 2 = 0) => NF[maks].format(n);
/** "Rp 1.250.000" (dibulatkan: nilai per-EC bisa berpecahan). */
export const rp = (n: number) => rupiah(Math.round(n));

export const tanggalPanjang = (ymd: string) =>
    new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Makassar" }).format(new Date(`${ymd}T12:00:00+08:00`));

/** Kolom ringkasan spec §2 — satu daftar untuk baris salesman, baris TOTAL cabang, dan rincian ponsel. */
export const KOLOM: { key: keyof Angka; header: string; teks: (a: Angka) => string }[] = [
    { key: "registeredOutlet", header: "Registered Outlet", teks: (a) => angka(a.registeredOutlet) },
    { key: "callPlan", header: "Call Plan", teks: (a) => angka(a.callPlan) },
    { key: "callRute", header: "Call Rute", teks: (a) => angka(a.callRute) },
    { key: "callNonRute", header: "Call Non Rute", teks: (a) => angka(a.callNonRute) },
    { key: "ec", header: "EC", teks: (a) => angka(a.ec) },
    { key: "noo", header: "NOO", teks: (a) => angka(a.noo) },
    { key: "quantity", header: "Quantity", teks: (a) => angka(a.quantity, 2) },
    { key: "itemPerEc", header: "Item/EC", teks: (a) => angka(a.itemPerEc, 1) },
    { key: "nilaiOrder", header: "Nilai Order", teks: (a) => rp(a.nilaiOrder) },
    { key: "omzetPerEc", header: "Omzet/EC", teks: (a) => rp(a.omzetPerEc) },
    { key: "jamDiToko", header: "Time at Outlet (jam)", teks: (a) => angka(a.jamDiToko, 2) },
    { key: "jamPerjalanan", header: "Time Travel (jam)", teks: (a) => angka(a.jamPerjalanan, 2) },
];

/** Status = ikon + teks (bukan warna saja). */
export const STATUS: Record<StatusSalesman, { ikon: string; label: string }> = {
    belum: { ikon: "⚪", label: "Belum check-in" },
    di_toko: { ikon: "🟢", label: "Di toko" },
    sudah: { ikon: "🔵", label: "Sudah berkunjung" },
};

/** salesCode "" = baris "Tanpa salesman terpetakan" (satu per cabang), jadi kunci baris memuat cabang. */
export const kunciBaris = (b: Pick<BarisSalesman, "cabang" | "salesCode">) => `${b.cabang}/${b.salesCode}`;
export const namaBaris = (b: BarisSalesman) => (b.salesCode === "" ? TANPA_SALESMAN : b.nama || b.salesCode);

/** GET ringkasan. Galat jaringan/HTTP jadi status galat berkalimat Indonesia; bentuk jawaban yang tak dikenal juga galat (bukan kosong). */
export async function bacaSupervisorReview(q: { tanggal: string; cabang: string; principle: string }): Promise<Load<JawabanSupervisorReview>> {
    const p = new URLSearchParams({ tanggal: q.tanggal });
    if (q.cabang) p.set("cabang", q.cabang);
    if (q.principle) p.set("principle", q.principle);
    const umum = "Supervisor Review belum berhasil dimuat.";
    const l = await ambilFk(`/api/supervisor-review?${p}`, (j) => j as unknown as JawabanSupervisorReview, umum);
    const d = l.data;
    const larik = ["pilihanCabang", "pilihanPrinciple", "salesman", "totalCabang", "kunjungan", "penanda", "fakturBelumTerbaca"] as const;
    if (l.status === "siap" && !(d && larik.every((k) => Array.isArray(d[k])))) {
        return { status: "galat", error: `${umum} Jawaban server tidak dikenali.` };
    }
    return l;
}
