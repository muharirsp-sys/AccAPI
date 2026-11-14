/*
 * Tujuan: Aturan MURNI order kunjungan Form Kontrol (owner 14 Nov 2026, dua alur order salesman): stok toko saat kunjungan (dari riwayat
 *   pengambilan), rujukan order kunjungan (Web Sales / sistem principal), saran jumlah order, dan limit kredit toko.
 *   Salesman input di AccAPI: Pilih toko → ORDER → halaman order (stok toko, item super WAJIB ditawarkan dulu, lalu input order) → Kirim order
 *   (antrean Web Sales) → merchandising. Salesman input di sistem principal: halaman order yang sama TANPA input order; tombol
 *   "Sudah input order" mencatat langkah ini saja (tidak ada yang dikirim ke Accurate) → merchandising.
 * Caller: app/api/form-kontrol/order-kunjungan/route.ts (server), lib/form-kontrol/db.ts, app/(dashboard)/form-kontrol/visit/[custCode]/order/*
 *   dan Kunjungan.tsx (klien), app/(dashboard)/form-kontrol/tabs/TabAo.tsx (limit), lib/form-kontrol/order-kunjungan.test.ts.
 * Dependensi: tidak ada (aman diimpor klien).
 * Main Functions: periksaStok, periksaRefOrder, gabungRefOrder, refWebsales, nomorDariRef, saranOrder, sisaLimit, ringkasLimit.
 * Side Effects: Tidak ada.
 */

/** Rujukan order kunjungan salesman tipe principal (tidak ada dokumen AccAPI/Accurate). */
export const REF_PRINCIPAL = "principal";
const AWALAN_WEBSALES = "websales:";
/** Batas baris stok per simpan (riwayat 3 bulan satu toko jarang lebih dari puluhan barang). */
export const MAKS_BARIS_STOK = 300;

export type IsianStok = { kodeBarang: string; namaBarang: string; satuan: string; stok: number; rataBulan: number | null };

const teks = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const angka = (v: unknown): number | null => {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(",", ".")) : NaN;
    return Number.isFinite(n) ? n : null;
};

/**
 * Isian stok dari layar → baris sah atau kalimat penolakan. Stok bilangan ≥ 0 (maks. 2 desimal; satuan bisa KRT setengah), kode + satuan wajib,
 * pasangan kode+satuan sekali saja. Kosong / null = tidak ada stok yang dicatat (toko tanpa riwayat / riwayat tak terbaca).
 */
export function periksaStok(isian: unknown): { baris: IsianStok[] } | { error: string } {
    if (isian == null) return { baris: [] };
    if (!Array.isArray(isian)) return { error: "Isian stok toko tidak terbaca." };
    if (isian.length > MAKS_BARIS_STOK) return { error: `Stok toko paling banyak ${MAKS_BARIS_STOK} barang sekali simpan.` };
    const baris: IsianStok[] = [];
    for (const x of isian as Record<string, unknown>[]) {
        const kodeBarang = teks(x?.kodeBarang).slice(0, 80);
        const satuan = teks(x?.satuan).toUpperCase().slice(0, 30);
        if (!kodeBarang || !satuan) return { error: "Kode barang dan satuan stok toko wajib." };
        const stok = angka(x.stok);
        if (stok === null || stok < 0 || Math.abs(Math.round(stok * 100) - stok * 100) > 1e-6) {
            return { error: `Stok ${kodeBarang} (${satuan}) harus angka 0 atau lebih, paling banyak 2 desimal.` };
        }
        if (stok > 1_000_000) return { error: `Stok ${kodeBarang} (${satuan}) terlalu besar; periksa lagi angkanya.` };
        if (baris.some((b) => b.kodeBarang === kodeBarang && b.satuan === satuan)) return { error: `Stok ${kodeBarang} (${satuan}) terkirim dua kali.` };
        const rata = angka(x.rataBulan);
        baris.push({ kodeBarang, satuan, stok, namaBarang: teks(x.namaBarang).slice(0, 200) || kodeBarang,
            rataBulan: rata === null || rata < 0 ? null : Math.round(rata * 100) / 100 });
    }
    return { baris };
}

export const refWebsales = (id: string) => `${AWALAN_WEBSALES}${id}`;

/**
 * Rujukan order yang dicatat ke kunjungan harus sesuai tipe salesman: tipe principal = REF_PRINCIPAL; tipe AccAPI = websales:<id permintaan>
 * (id dari jawaban POST /websales/orders). Kembali = kalimat penolakan atau null (sah).
 */
export function periksaRefOrder(ref: unknown, sumberOrder: "accapi" | "principal"): string | null {
    const r = teks(ref);
    if (sumberOrder === "principal") return r === REF_PRINCIPAL ? null : "Salesman input di sistem principal hanya mencatat \"Sudah input order\".";
    if (!r.startsWith(AWALAN_WEBSALES) || !/^[A-Za-z0-9-]{1,64}$/.test(r.slice(AWALAN_WEBSALES.length))) {
        return "Order kunjungan dicatat dari nomor permintaan Order Sales yang terkirim.";
    }
    return null;
}

/** Order kedua pada kunjungan yang sama (mis. barang tertinggal) menambah rujukan, tidak menimpa: "websales:a,websales:b". */
export function gabungRefOrder(lama: string | null | undefined, baru: string): string {
    const ada = (lama ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return ada.includes(baru) ? ada.join(",") : [...ada, baru].join(",");
}

/** Nomor permintaan pendek untuk tampilan ("#1a2b3c4d"); rujukan principal = null. */
export function nomorDariRef(ref: string | null | undefined): string[] {
    return (ref ?? "").split(",").map((s) => s.trim()).filter((s) => s.startsWith(AWALAN_WEBSALES)).map((s) => `#${s.slice(AWALAN_WEBSALES.length, AWALAN_WEBSALES.length + 8)}`);
}

/** Saran jumlah order = kebutuhan sebulan (rata-rata pengambilan dibulatkan ke atas) dikurangi stok toko sekarang, minimal 0. */
export function saranOrder(rataBulan: number, stok: number | null): number {
    if (!Number.isFinite(rataBulan) || rataBulan <= 0) return 0;
    return Math.max(0, Math.ceil(rataBulan - (stok ?? 0)));
}

/** Limit kredit toko (pelanggan cabang = principal rute di Accurate): limit null = tidak diatur di Accurate; piutang = saldo sinkron terakhir. */
export type LimitToko = { limit: number | null; piutang: number | null };

/** Sisa limit = limit − piutang (boleh negatif = sudah melewati limit); null bila limit tidak diatur. */
export function sisaLimit(l: LimitToko): number | null {
    return l.limit === null ? null : l.limit - (l.piutang ?? 0);
}

/** Ringkasan satu baris untuk kartu rute: "Limit 5 jt · sisa 900 rb" / "Limit 5 jt · lewat 200 rb" / "Limit tidak diatur". */
export function ringkasLimit(l: LimitToko, ringkas: (n: number) => string): { teks: string; lewat: boolean } {
    const sisa = sisaLimit(l);
    if (l.limit === null || sisa === null) return { teks: "Limit tidak diatur", lewat: false };
    return sisa < 0 ? { teks: `Limit ${ringkas(l.limit)} · lewat ${ringkas(-sisa)}`, lewat: true }
        : { teks: `Limit ${ringkas(l.limit)} · sisa ${ringkas(sisa)}`, lewat: false };
}
