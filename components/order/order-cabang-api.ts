/*
 * Tujuan: Panggilan API Order per cabang untuk layar O2: cari pelanggan, cari barang (hasil kosong dibedakan: tak cocok vs cabang tanpa
 *   barang lewat `cabangTanpaBarang`), baca satu pelanggan/barang dari kodenya (rute hari ini, draf, pemulihan), cakupan cabang salesman,
 *   dan pratinjau order (harga + promo + `sidik`) — semuanya dengan jawaban yang membedakan galat berkode dari "kosong".
 * Caller: components/order/{useCari.ts,PemilihPelanggan.tsx,PemilihBarang.tsx}, app/(dashboard)/sales/OrderSales.tsx,
 *   app/(dashboard)/orders/{OrderBaru,AntreFaktur}.tsx.
 * Dependensi: ./order-cabang (murni), app/(dashboard)/form-kontrol/lapangan (ambilJson).
 * Main Functions: cariPelanggan, cariBarang, bacaPelangganKode, cocokkanTokoRute, bacaBarangKode, muatCakupan, hitungPratinjau.
 * Side Effects: HTTP GET /api/customers/search, /api/customers/rute, /api/items/search; POST /api/orders/preview (tanpa menyimpan apa pun).
 */
import { ambilJson } from "@/app/(dashboard)/form-kontrol/lapangan";
import {
    bacaBarang, bacaPelanggan, galatDariJawaban, kunciHarga, urlCariBarang, urlCariPelanggan,
    type BarangPilih, type Cakupan, type Galat, type PelangganPilih, type Peran, type PriceInfo, type Result, type Suggestion,
} from "./order-cabang";

/** `batal` = permintaan sengaja dibatalkan (ketikan baru) — pemanggil mengabaikannya, bukan galat dan bukan kosong. */
export type Hasil<T> = { ok: true; data: T } | { ok: false; galat: Galat } | { ok: false; batal: true };

const bacaCakupan = (d: Record<string, unknown>): Cakupan => {
    const c = (d.cakupan ?? {}) as Record<string, unknown>;
    return { semua: c.semua === true, branchId: typeof c.branchId === "number" ? c.branchId : null, branchName: typeof c.branchName === "string" ? c.branchName : null };
};

type Minta = { batal: true } | { galat: Galat } | { d: Record<string, unknown> };

async function minta(url: string, signal: AbortSignal | undefined, peran: Peran): Promise<Minta> {
    const j = await ambilJson(url, { credentials: "include", signal });
    if (signal?.aborted) return { batal: true };
    const ok = j.status >= 200 && j.status < 300 && j.data !== null && j.data.ok !== false;
    return ok ? { d: j.data as Record<string, unknown> } : { galat: galatDariJawaban(j, peran) };
}

export async function cariPelanggan(o: { q: string; branchId?: number | null; limit?: number }, signal: AbortSignal, peran: Peran): Promise<Hasil<{ cakupan: Cakupan; items: PelangganPilih[] }>> {
    const r = await minta(urlCariPelanggan(o), signal, peran);
    if ("batal" in r) return { ok: false, batal: true };
    if ("galat" in r) return { ok: false, galat: r.galat };
    const items = (Array.isArray(r.d.items) ? r.d.items : []).map(bacaPelanggan).filter((p): p is PelangganPilih => p !== null);
    return { ok: true, data: { cakupan: bacaCakupan(r.d), items } };
}

/**
 * Barang cabang pelanggan. Hasil kosong dibedakan oleh server (`cabangTanpaBarang`, kontrak O1 §3): "tidak ada yang cocok dengan ketikan"
 * vs "cabang ini memang belum punya barang yang bisa diorder" (belum tersinkron / semua non-jual).
 */
export async function cariBarang(o: { q: string; pelanggan: PelangganPilih; tanggal: string; limit?: number }, signal: AbortSignal, peran: Peran): Promise<Hasil<{ items: BarangPilih[]; cabangKosong: boolean }>> {
    const untuk = kunciHarga(o.pelanggan.id, o.tanggal);
    const r = await minta(urlCariBarang({ q: o.q, customerId: o.pelanggan.id, tanggal: o.tanggal, limit: o.limit }), signal, peran);
    if ("batal" in r) return { ok: false, batal: true };
    if ("galat" in r) return { ok: false, galat: r.galat };
    const items = (Array.isArray(r.d.items) ? r.d.items : []).map((b) => bacaBarang(b, untuk)).filter((b): b is BarangPilih => b !== null);
    return { ok: true, data: { items, cabangKosong: items.length === 0 && r.d.cabangTanpaBarang === true } };
}

/** Satu pelanggan dari kodenya (kode persis, tanpa membedakan huruf besar). null = tidak ditemukan di hasil pencarian (nonaktif / luar cabang / belum ada). */
export async function bacaPelangganKode(kode: string, signal: AbortSignal, peran: Peran): Promise<Hasil<PelangganPilih | null>> {
    const r = await cariPelanggan({ q: kode, limit: 10 }, signal, peran);
    if (!r.ok) return r;
    const cocok = r.data.items.find((p) => p.customerNo.toUpperCase() === kode.trim().toUpperCase()) ?? null;
    return { ok: true, data: cocok };
}

/** Toko rute (kode JKS) -> pelanggan cabang Anda. `pelanggan` null = tidak bisa dipilih; `alasan` = kalimat server (per toko). */
export type TokoRuteCocok = { kode: string; pelanggan: PelangganPilih | null; alasan: string };

/** Kode per permintaan /api/customers/rute (= batas server). Rute lebih panjang dipecah, tidak dipotong diam-diam (KC3). */
export const BATAS_KODE_RUTE = 200;

/**
 * Kode toko "Toko di rute hari ini" (kode JKS, TANPA akhiran cabang) -> pelanggan Accurate di cabang salesman (FK-MSM butir 6): server
 * mencocokkan kode persis ATAU kode + "-" + akhiran, dibatasi cabang Anda, dan hanya menerima tepat satu pelanggan aktif per toko.
 * Lebih dari BATAS_KODE_RUTE kode = beberapa permintaan berurutan; satu gagal = galat untuk semuanya (bukan daftar sebagian).
 */
export async function cocokkanTokoRute(kode: string[], signal: AbortSignal | undefined, peran: Peran): Promise<Hasil<TokoRuteCocok[]>> {
    const data: TokoRuteCocok[] = [];
    for (let i = 0; i < kode.length; i += BATAS_KODE_RUTE) {
        const r = await minta(`/api/customers/rute?${new URLSearchParams(kode.slice(i, i + BATAS_KODE_RUTE).map((k) => ["kode", k]))}`, signal, peran);
        if ("batal" in r) return { ok: false, batal: true };
        if ("galat" in r) return { ok: false, galat: r.galat };
        for (const x of (Array.isArray(r.d.rute) ? r.d.rute : []) as Record<string, unknown>[]) {
            data.push({ kode: String(x.kode ?? ""), pelanggan: x.pelanggan ? bacaPelanggan(x.pelanggan) : null, alasan: typeof x.alasan === "string" ? x.alasan : "" });
        }
    }
    return { ok: true, data };
}

export async function bacaBarangKode(kode: string, pelanggan: PelangganPilih, tanggal: string, signal: AbortSignal, peran: Peran): Promise<Hasil<BarangPilih | null>> {
    const r = await cariBarang({ q: kode, pelanggan, tanggal, limit: 10 }, signal, peran);
    if (!r.ok) return r;
    return { ok: true, data: r.data.items.find((b) => b.no.toUpperCase() === kode.trim().toUpperCase()) ?? null };
}

/**
 * Cakupan cabang salesman (probe pencarian pelanggan tanpa kata kunci). `blokir` = jawaban PASTI bahwa akun belum bisa memakai layar
 * (belum tertaut ke karyawan Accurate / karyawan tidak aktif); bedakan dari galat sementara (putus, server sibuk).
 */
export async function muatCakupan(signal?: AbortSignal): Promise<{ cakupan: Cakupan } | { blokir: Galat } | { galat: Galat }> {
    const j = await ambilJson(urlCariPelanggan({ limit: 1 }), { credentials: "include", signal });
    if (j.status >= 200 && j.status < 300 && j.data !== null && j.data.ok !== false) return { cakupan: bacaCakupan(j.data) };
    const g = galatDariJawaban(j, "sales");
    return g.blokirSales ? { blokir: g } : { galat: g };
}

// ------------------------------------------------------------------ pratinjau (harga per cabang pelanggan + promo)

export type WrongUnit = { code: string; unit: string; known_units: string[] };
/**
 * siap: harga ada (tanpaHarga = kode tanpa harga di cabang pelanggan, tidak ikut netto); `sidik` = sidik pratinjau LENGKAP (semua baris
 *   berharga) yang WAJIB dibawa simpan — null pada pratinjau sebagian (ada baris tanpa harga) atau bila server tak mengirimnya, dan
 *   `channelMasalah` tidak kosong = simpan akan ditolak CHANNEL_BEDA_MASTER;
 * satuan: SATUAN_SALAH per baris; barang: BARANG_* (hapus/ganti barisnya); galat: selain itu (menolak=true → pasti ditolak saat simpan).
 */
export type Pratinjau =
    | { status: "memuat" }
    | { status: "siap"; result: Result | null; suggestions: Suggestion[]; prices: PriceInfo[]; tanpaHarga: string[]; sidik: string | null; channelMasalah: string; catatan?: Galat }
    | { status: "satuan"; wrong: WrongUnit[]; galat: Galat }
    | { status: "barang"; galat: Galat }
    | { status: "galat"; galat: Galat };

const KODE_BARANG = new Set(["BARANG_TIDAK_ADA", "BARANG_SUSPENDED", "BARANG_BEDA_CABANG", "HARGA_PETUGAS_TIDAK_DIIZINKAN"]);

/**
 * Pratinjau server: `customer_no` WAJIB (cabang harga + aturan cabang dari pelanggan). `price` per baris = HARGA PETUGAS (hanya Order Baru;
 * kosong/tidak dikirim = harga master; sales tidak pernah mengirimnya). HARGA_BELUM_ADA → pratinjau kedua hanya dari baris berharga
 * (tanpa sidik: order dengan baris tanpa harga memang tidak bisa disimpan).
 */
export async function hitungPratinjau(o: { channel: string; orderDate: string; customerNo: string; lines: { code: string; unit: string; quantity: string; price?: string | null }[]; peran: Peran }): Promise<Pratinjau> {
    const panggil = (ls: typeof o.lines) => ambilJson("/api/orders/preview", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: o.channel, order_date: o.orderDate, customer_no: o.customerNo.trim(),
            lines: ls.map((l) => ({ code: l.code.trim(), unit: l.unit, quantity: l.quantity, ...(l.price ? { price: l.price.trim() } : {}) })) }),
    });
    const siap = (d: Record<string, unknown>, tanpaHarga: string[], catatan?: Galat): Pratinjau => ({
        status: "siap", result: (d.result as Result) ?? null, suggestions: (d.suggestions as Suggestion[]) ?? [], prices: (d.prices as PriceInfo[]) ?? [], tanpaHarga,
        sidik: tanpaHarga.length === 0 && !catatan && typeof d.sidik === "string" && d.sidik ? d.sidik : null,
        channelMasalah: typeof d.channel_masalah === "string" ? d.channel_masalah : "", catatan,
    });
    const j = await panggil(o.lines);
    if (j.status >= 200 && j.status < 300 && j.data?.ok) return siap(j.data, []);
    const g = galatDariJawaban(j, o.peran);
    const d = j.data ?? {};
    if (g.kode === "SATUAN_SALAH" && Array.isArray(d.wrong_unit)) return { status: "satuan", wrong: d.wrong_unit as WrongUnit[], galat: g };
    if (KODE_BARANG.has(g.kode)) return { status: "barang", galat: g };
    if (g.kode === "HARGA_BELUM_ADA" && Array.isArray(d.missing)) {
        const tanpaHarga = [...new Set((d.missing as unknown[]).map(String))];
        const berharga = o.lines.filter((l) => !tanpaHarga.includes(l.code.trim()));
        if (berharga.length === 0) return { status: "siap", result: null, suggestions: [], prices: [], tanpaHarga, sidik: null, channelMasalah: "" };
        const k = await panggil(berharga);
        if (k.status >= 200 && k.status < 300 && k.data?.ok) return siap(k.data, tanpaHarga);
        return { status: "siap", result: null, suggestions: [], prices: [], tanpaHarga, sidik: null, channelMasalah: "", catatan: galatDariJawaban(k, o.peran) };
    }
    return { status: "galat", galat: g };
}
