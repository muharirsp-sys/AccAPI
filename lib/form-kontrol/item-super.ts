/*
 * Tujuan: Item Super di Form Kontrol (owner 13 Nov 2026) — baca berkas "Item Super per Channel per Principal" (sheet Item Super per Channel,
 *   Item Super MT per Sales, Ringkasan per Sales) menjadi SARAN, gabung varian, pilih saran untuk satu toko, dan periksa isian penawaran.
 * Caller: app/api/form-kontrol/item-super/** (server), lib/form-kontrol/item-super-db.ts, tabs/TabItemSuper.tsx + visit Kunjungan (klien).
 * Dependensi: ./constants (kunciNama) — MURNI, tanpa impor server, aman di klien.
 * Main Functions: ALASAN_ITEM_SUPER, SHEET_ITEM_SUPER, bacaItemSuper, tebakPetaItemSuper, pilihSaran, periksaTawaran, MAKS_SARAN_WAJIB.
 * Side Effects: tidak ada.
 *
 * Aturan (owner 13 Nov 2026):
 *  - "Gabung jadi satu saran": kode bertiga belas digit pertama sama (varian promo/banded/akhiran N/P) dan KODE DIGABUNG di berkas = SATU saran;
 *    kode utama = omzet rata-rata terbesar, varian di kodeLain; toko yang membeli kode mana pun dianggap sudah membeli item itu.
 *  - Saran per toko = item super principal × channel toko (MT: daftar khusus salesman bila ada); yang BELUM dibeli toko dalam RIWAYAT_HARI
 *    terakhir didahulukan menurut peringkat, maksimal MAKS_SARAN_WAJIB wajib dijawab di langkah Merchandising.
 *  - Penawaran: ditawarkan ya/tidak; ditawarkan → dipesan ya/tidak; tidak dipesan (termasuk tidak ditawarkan) → alasan wajib.
 */
import { kunciNama } from "./constants";

export const SHEET_ITEM_SUPER = { channel: "Item Super per Channel", mtSales: "Item Super MT per Sales", ringkasanSales: "Ringkasan per Sales" } as const;
/** ponytail: 10 saran wajib per kunjungan (beban isi salesman ±1 menit); naikkan bila SPV meminta. */
export const MAKS_SARAN_WAJIB = 10;
/** Riwayat beli toko yang dianggap "sudah membeli" (hari). */
export const RIWAYAT_HARI = 90;

export const ALASAN_ITEM_SUPER = [
    { kode: "STOK_ADA", label: "Stok di toko masih ada" },
    { kode: "TIDAK_LAKU", label: "Kurang laku / tidak ada permintaan di toko ini" },
    { kode: "HARGA", label: "Harga dianggap mahal / kalah pesaing" },
    { kode: "MODAL", label: "Modal toko terbatas" },
    { kode: "TAGIHAN", label: "Masih ada tagihan belum lunas" },
    { kode: "RAK_PENUH", label: "Tidak ada tempat display" },
    { kode: "BELI_LAIN", label: "Toko membeli dari pihak lain" },
    { kode: "STOK_KOSONG", label: "Stok di gudang kita kosong" },
    { kode: "PIC_TIDAK_ADA", label: "Pemilik/PIC tidak ada di tempat" },
    { kode: "TIDAK_SEMPAT", label: "Tidak sempat ditawarkan" },
    { kode: "LAINNYA", label: "Lainnya (tulis catatan)" },
] as const;
export const KODE_ALASAN_ITEM_SUPER: readonly string[] = ALASAN_ITEM_SUPER.map((a) => a.kode);

export type Channel = "GT" | "MT" | "NKA";
export type SaranItemSuper = {
    principle: string; channel: Channel; salesCode: string; kodeBarang: string; kodeLain: string[]; namaBarang: string; peringkat: number;
    kontribusi: number | null; omzetRata: number | null; jumlahToko: number | null;
};
export type BarisMentah = Record<string, unknown>;
export type PetaItemSuper = { principal: Record<string, string>; sales: Record<string, string> };

const teks = (v: unknown) => String(v ?? "").trim();
const angka = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : teks(v) && Number.isFinite(Number(teks(v))) ? Number(teks(v)) : null);
const channelSah = (v: unknown): Channel | null => { const c = teks(v).toUpperCase(); return c === "GT" || c === "MT" || c === "NKA" ? c : null; };
const kodeLainBerkas = (v: unknown) => teks(v).split(/[;,|]/).map((x) => x.trim()).filter(Boolean);

/** Nilai principal / sales di berkas untuk dipetakan Admin. `salesman` = nama di data penjualan per SALES (sheet Ringkasan per Sales). */
export function nilaiUntukPetaItemSuper(channel: readonly BarisMentah[], mtSales: readonly BarisMentah[], ringkasanSales: readonly BarisMentah[]) {
    const principal = [...new Set([...channel, ...mtSales].map((r) => teks(r["PRINCIPAL"])).filter(Boolean))].sort();
    const salesman = new Map<string, Set<string>>();
    for (const r of ringkasanSales) {
        const s = teks(r["SALES"]);
        if (!s) continue;
        const set = salesman.get(s) ?? new Set<string>();
        for (const n of teks(r["SALESMAN DI DATA PENJUALAN"]).split(";").map((x) => x.trim()).filter(Boolean)) set.add(n);
        salesman.set(s, set);
    }
    const sales = [...new Set(mtSales.map((r) => teks(r["SALES"])).filter(Boolean))].sort()
        .map((s) => ({ nilai: s, salesmanData: [...(salesman.get(s) ?? [])] }));
    return { principal, sales };
}

/**
 * Tebakan awal peta: principal sistem yang namanya memuat kata pertama nama berkas ("KINO INDONESIA. TBK, PT" -> "KINO…"), hanya bila tepat
 * satu; sales = profil yang namanya sama dengan nama di data penjualan (awalan kursi dibuang), hanya bila tepat satu. Tidak yakin = kosong.
 */
export function tebakPetaItemSuper(nilai: ReturnType<typeof nilaiUntukPetaItemSuper>, principalSistem: readonly string[],
    profil: readonly { salesCode: string; salesName: string }[]): PetaItemSuper {
    const principal: Record<string, string> = {};
    for (const p of nilai.principal) {
        const kata = kunciNama(p).split(/[^A-Z0-9]+/).filter((k) => k.length >= 3 && k !== "PT");
        const cocok = principalSistem.filter((s) => kata.length > 0 && kunciNama(s).split(/[^A-Z0-9]+/).includes(kata[0]));
        if (cocok.length === 1) principal[p] = cocok[0];
    }
    const nama = (s: string) => kunciNama(s.split("_").pop());
    const sales: Record<string, string> = {};
    for (const s of nilai.sales) {
        const kandidat = new Set(profil.filter((p) => s.salesmanData.some((d) => nama(d) === nama(p.salesName))).map((p) => p.salesCode));
        if (kandidat.size === 1) sales[s.nilai] = [...kandidat][0];
    }
    return { principal, sales };
}

/**
 * Gabung satu kelompok (principal × channel × sales) menjadi saran: kode bertiga belas digit sama + KODE DIGABUNG = satu saran (union-find
 * sederhana), kode utama = omzet terbesar, peringkat = peringkat terbaik anggota, omzet/jumlah toko = milik kode utama.
 */
function gabungVarian(baris: (SaranItemSuper & { kodeBerkas: string[] })[]): SaranItemSuper[] {
    const induk = new Map<string, string>();
    const cari = (k: string): string => { const p = induk.get(k) ?? k; if (p === k) return k; const r = cari(p); induk.set(k, r); return r; };
    const satukan = (a: string, b: string) => { const x = cari(a), y = cari(b); if (x !== y) induk.set(y, x); };
    const perAwalan = new Map<string, string>();
    for (const b of baris) {
        induk.set(b.kodeBarang, cari(b.kodeBarang));
        for (const k of b.kodeBerkas) satukan(b.kodeBarang, k);
        const awalan = b.kodeBarang.length >= 14 ? b.kodeBarang.slice(0, 13) : null;
        if (awalan) { const ada = perAwalan.get(awalan); if (ada) satukan(ada, b.kodeBarang); else perAwalan.set(awalan, b.kodeBarang); }
    }
    const kelompok = new Map<string, typeof baris>();
    for (const b of baris) kelompok.set(cari(b.kodeBarang), [...(kelompok.get(cari(b.kodeBarang)) ?? []), b]);
    return [...kelompok.values()].map((g) => {
        const utama = [...g].sort((a, b) => (b.omzetRata ?? 0) - (a.omzetRata ?? 0) || a.peringkat - b.peringkat)[0];
        const lain = [...new Set(g.flatMap((x) => [x.kodeBarang, ...x.kodeBerkas]))].filter((k) => k !== utama.kodeBarang).sort();
        return { principle: utama.principle, channel: utama.channel, salesCode: utama.salesCode, kodeBarang: utama.kodeBarang, namaBarang: utama.namaBarang,
            kontribusi: utama.kontribusi, omzetRata: utama.omzetRata, jumlahToko: utama.jumlahToko, kodeLain: lain, peringkat: Math.min(...g.map((x) => x.peringkat)) };
    }).sort((a, b) => a.peringkat - b.peringkat).map((s, i) => ({ ...s, peringkat: i + 1 }));
}

/**
 * Berkas -> saran per principal sistem. Baris principal/sales yang belum dipetakan DILEWATI dan dihitung di `lewat` (bukan galat: principal
 * yang tidak diunggah tidak boleh menghapus daftar lamanya). Kode ganda di satu kelompok = `galat` (berkas rusak; unggahan dibatalkan).
 */
export function bacaItemSuper(channel: readonly BarisMentah[], mtSales: readonly BarisMentah[], peta: PetaItemSuper) {
    const galat: { sheet: string; baris: number; pesan: string }[] = [];
    const lewat = { principal: new Set<string>(), sales: new Set<string>() };
    const kelompok = new Map<string, (SaranItemSuper & { kodeBerkas: string[] })[]>();
    const tambah = (sheet: string, baris: number, r: BarisMentah, ch: Channel | null, salesCode: string) => {
        const principalBerkas = teks(r["PRINCIPAL"]);
        const principle = peta.principal[principalBerkas];
        const kode = teks(r["KODE BARANG"]);
        if (!principalBerkas && !kode) return;
        if (!principle) { lewat.principal.add(principalBerkas); return; }
        const peringkat = angka(r["RANK"]);
        if (!kode || !ch || peringkat === null) { galat.push({ sheet, baris, pesan: "Kode barang, channel, atau rank kosong/tidak dikenal." }); return; }
        const k = `${principle}\u0000${ch}\u0000${salesCode}`;
        const daftar = kelompok.get(k) ?? [];
        if (daftar.some((d) => d.kodeBarang === kode)) { galat.push({ sheet, baris, pesan: `Kode ${kode} dobel untuk ${principalBerkas} ${ch}.` }); return; }
        daftar.push({ principle, channel: ch, salesCode, kodeBarang: kode, kodeBerkas: kodeLainBerkas(r["KODE DIGABUNG (KODE LAIN DI PENJUALAN)"]),
            namaBarang: teks(r["NAMA BARANG"]) || kode, peringkat, kontribusi: angka(r["KONTRIBUSI"]),
            omzetRata: angka(r["OMZET RATA-RATA / BULAN (ACUAN)"]), jumlahToko: angka(r["JUMLAH TOKO BELI"]), kodeLain: [] });
        kelompok.set(k, daftar);
    };
    // Header di baris 3 (judul + baris kosong di atasnya): nomor baris Excel = indeks + 4.
    channel.forEach((r, i) => tambah(SHEET_ITEM_SUPER.channel, i + 4, r, channelSah(r["CHANNEL"]), ""));
    mtSales.forEach((r, i) => {
        const salesBerkas = teks(r["SALES"]);
        const salesCode = peta.sales[salesBerkas];
        if (!salesCode) { if (salesBerkas) lewat.sales.add(salesBerkas); return; }
        tambah(SHEET_ITEM_SUPER.mtSales, i + 4, r, channelSah(r["KELOMPOK TOKO"]), salesCode);
    });
    const saran = [...kelompok.values()].flatMap(gabungVarian);
    const varianDigabung = [...kelompok.values()].reduce((n, g) => n + g.length, 0) - saran.length;
    return { saran, galat, varianDigabung, lewat: { principal: [...lewat.principal].sort(), sales: [...lewat.sales].sort() } };
}

/** Channel JKS toko -> channel item super (TT = GT). */
export const channelToko = (c: string | null | undefined): Channel => {
    const x = teks(c).toUpperCase();
    return x === "MT" || x === "NKA" ? x : "GT";
};

export type SaranToko = SaranItemSuper & { terakhirDibeli: string | null };
/**
 * Saran untuk satu toko: daftar khusus salesman (MT per sales) bila ada untuk channel itu, selain itu daftar channel. `riwayat` = kode barang
 * -> tanggal beli terakhir (YYYY-MM-DD) toko itu dalam RIWAYAT_HARI. wajib = belum dibeli (kode utama maupun varian), urut peringkat,
 * maks. MAKS_SARAN_WAJIB; lain = sisanya (sudah dibeli / di luar batas), hanya informasi.
 */
export function pilihSaran(semua: readonly SaranItemSuper[], toko: { principle: string; channel: Channel; salesCode: string },
    riwayat: ReadonlyMap<string, string>): { wajib: SaranToko[]; lain: SaranToko[] } {
    const khusus = semua.filter((s) => s.principle === toko.principle && s.channel === toko.channel && s.salesCode === toko.salesCode && s.salesCode);
    const daftar = (khusus.length ? khusus : semua.filter((s) => s.principle === toko.principle && s.channel === toko.channel && !s.salesCode))
        .slice().sort((a, b) => a.peringkat - b.peringkat)
        .map((s) => ({ ...s, terakhirDibeli: [s.kodeBarang, ...s.kodeLain].map((k) => riwayat.get(k) ?? "").sort().at(-1) || null }));
    const belum = daftar.filter((s) => !s.terakhirDibeli);
    const wajib = belum.slice(0, MAKS_SARAN_WAJIB);
    const kodeWajib = new Set(wajib.map((s) => s.kodeBarang));
    return { wajib, lain: daftar.filter((s) => !kodeWajib.has(s.kodeBarang)) };
}

export type IsianTawaran = { kodeBarang: string; ditawarkan: boolean; dipesan: boolean | null; alasan: string | null; catatan: string | null };
/**
 * Isian penawaran dari layar -> baris sah atau kalimat penolakan. Semua saran `wajib` harus dijawab; kode di luar saran toko ditolak (layar basi).
 * Tidak ditawarkan -> dipesan null; tidak dipesan -> alasan ALASAN_ITEM_SUPER wajib; LAINNYA -> catatan ≥ 5 huruf.
 */
export function periksaTawaran(isian: unknown, saran: { wajib: readonly { kodeBarang: string }[]; lain: readonly { kodeBarang: string }[] }):
    { baris: IsianTawaran[] } | { error: string } {
    if (isian == null) return saran.wajib.length ? { error: `Jawab penawaran ${saran.wajib.length} item super dulu.` } : { baris: [] };
    if (!Array.isArray(isian)) return { error: "Isian item super tidak terbaca." };
    const boleh = new Set([...saran.wajib, ...saran.lain].map((s) => s.kodeBarang));
    const baris: IsianTawaran[] = [];
    for (const x of isian as Record<string, unknown>[]) {
        const kodeBarang = teks(x?.kodeBarang);
        if (!boleh.has(kodeBarang)) return { error: `Item ${kodeBarang || "(tanpa kode)"} bukan saran item super toko ini; muat ulang kunjungan.` };
        if (baris.some((b) => b.kodeBarang === kodeBarang)) return { error: `Item ${kodeBarang} terkirim dua kali.` };
        if (typeof x.ditawarkan !== "boolean") return { error: `Pilih apakah item ${kodeBarang} ditawarkan.` };
        const dipesan = x.ditawarkan ? (typeof x.dipesan === "boolean" ? x.dipesan : undefined) : null;
        if (dipesan === undefined) return { error: `Pilih apakah item ${kodeBarang} dipesan toko.` };
        const alasan = dipesan === true ? null : teks(x.alasan) || null;
        if (dipesan !== true && (!alasan || !KODE_ALASAN_ITEM_SUPER.includes(alasan))) return { error: `Pilih alasan item ${kodeBarang} tidak dipesan.` };
        const catatan = teks(x.catatan).slice(0, 300) || null;
        if (alasan === "LAINNYA" && (catatan ?? "").length < 5) return { error: `Tulis catatan alasan "Lainnya" untuk item ${kodeBarang}.` };
        baris.push({ kodeBarang, ditawarkan: x.ditawarkan, dipesan, alasan, catatan });
    }
    const kurang = saran.wajib.filter((s) => !baris.some((b) => b.kodeBarang === s.kodeBarang));
    if (kurang.length) return { error: `${kurang.length} item super belum dijawab.` };
    return { baris };
}
