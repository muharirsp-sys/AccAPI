/*
 * Tujuan: Riwayat beli toko (O3, owner 12 Okt 2026 sesi 13) — "kalau toko sudah pernah order, munculkan average pengambilannya selama
 *   sebulan". Logika MURNI (tanpa DB, aman diimpor klien): jendela tanggal, bulan teramati, agregasi baris faktur per barang + satuan,
 *   jumlah usulan tombol Tambah, satuan saat Tambah, sisip baris order, baca jawaban API.
 * Caller: app/api/customers/riwayat-beli/route.ts (server), components/order/RiwayatBeli.tsx (klien), lib/riwayat-beli.test.ts.
 * Dependensi: tidak ada.
 * Main Functions: jendelaRiwayat, bulanTeramati, ringkasRiwayat, jumlahTambah, satuanTambah, sisipkanBaris, bacaRiwayat, urlRiwayat.
 * Side Effects: Tidak ada.
 */

export const HARI_PER_BULAN = 30;
export const BULAN_BAWAAN = 3;

const MS_HARI = 86_400_000;
const keHari = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / MS_HARI;
const dariHari = (n: number) => new Date(n * MS_HARI).toISOString().slice(0, 10);
const bulat2 = (n: number) => Math.round(n * 100) / 100;

/** Jendela `bulan` × 30 hari TERMASUK `sampai` (hari ini WITA): 3 bulan = 90 hari. Tanggal YYYY-MM-DD. */
export function jendelaRiwayat(sampai: string, bulan: number): { dari: string; sampai: string } {
    return { dari: dariHari(keHari(sampai) - (bulan * HARI_PER_BULAN - 1)), sampai };
}

/**
 * ponytail: rata-rata per bulan = total qty barang+satuan dalam jendela ÷ BULAN TERAMATI; satu bulan = 30 hari. Bulan teramati = bulan
 *   jendela (bawaan 3 = 90 hari), KECUALI faktur paling awal toko di cache lebih baru dari awal jendela (toko baru / cache baru mulai,
 *   MSM sejak 24 Jul 2026): (hari ini − faktur itu + 1) ÷ 30, minimal 1 — toko yang baru 2 minggu belanja tidak dibagi 3.
 *   Batas: bulan kalender & musiman tidak dibedakan; retur (sales_return) TIDAK dikurangkan; baris harga 0 (bonus promo) tidak dihitung;
 *   faktur tanpa rincian barang (masuk lewat list.do, bukan detail.do) tidak bisa dihitung per barang — jumlahnya dilaporkan (`tanpaRincian`)
 *   sehingga rata-rata bisa lebih kecil dari kenyataan. Jalan naik: backfill rincian lewat detail.do, lalu kurangi retur per barang.
 */
export function bulanTeramati(o: { dari: string; sampai: string; bulan: number; palingAwal: string | null }): number {
    if (!o.palingAwal || o.palingAwal <= o.dari) return o.bulan;
    return Math.max(1, (keHari(o.sampai) - keHari(o.palingAwal) + 1) / HARI_PER_BULAN);
}

/** Satu baris hasil SQL: satu baris barang faktur, atau satu baris per faktur tanpa rincian (`code` null), atau satu baris `faktur` null
 * (tak ada faktur dalam jendela; tetap membawa tanggal data paling awal). Angka masih TEKS (dibaca di sini, bukan di-cast di SQL). */
export type BarisFaktur = { faktur: string | null; tanggal: string | null; adaRincian: boolean; code: string | null; nama: string | null; satuan: string | null; qty: string | null; harga: string | null };
export type BarangRiwayat = { code: string; name: string; unit: string; totalQty: number; rataPerBulan: number; jumlahFaktur: number; terakhirBeli: string };
export type Jendela = { bulan: number; dari: string; sampai: string; bulanTeramati: number };
export type RingkasanRiwayat = { jumlahFaktur: number; tanpaRincian: number; dataSejak: string | null };

/** Agregasi per barang + SATUAN (KRT dan PCS barang yang sama = dua baris; satuan tidak dikonversi). Urut rata-rata terbesar. */
export function ringkasRiwayat(rows: readonly BarisFaktur[], o: { dari: string; sampai: string; bulan: number; palingAwal: string | null }):
    { jendela: Jendela; ringkasan: RingkasanRiwayat; items: BarangRiwayat[] } {
    const faktur = new Map<string, boolean>();
    const per = new Map<string, { code: string; name: string; unit: string; total: number; faktur: Set<string>; terakhir: string }>();
    for (const r of rows) {
        if (!r.faktur) continue;
        faktur.set(r.faktur, (faktur.get(r.faktur) ?? false) || r.adaRincian);
        const code = (r.code ?? "").trim();
        const unit = (r.satuan ?? "").trim().toUpperCase();
        const qty = Number(r.qty);
        if (!code || !unit || !r.qty || !Number.isFinite(qty) || qty <= 0) continue;
        // Harga 0 = bonus promo (pemberian, bukan pengambilan toko). Harga tak terkirim (null) bukan bonus.
        if (r.harga !== null && r.harga.trim() !== "" && Number(r.harga) === 0) continue;
        const k = `${code}|${unit}`;
        const x = per.get(k) ?? { code, name: "", unit, total: 0, faktur: new Set<string>(), terakhir: "" };
        x.total += qty;
        x.faktur.add(r.faktur);
        if (!x.name && r.nama?.trim()) x.name = r.nama.trim();
        if ((r.tanggal ?? "") > x.terakhir) x.terakhir = r.tanggal ?? "";
        per.set(k, x);
    }
    const bulan = bulanTeramati(o);
    const items = [...per.values()].map((x): BarangRiwayat => ({
        code: x.code, name: x.name, unit: x.unit, totalQty: bulat2(x.total), rataPerBulan: bulat2(x.total / bulan), jumlahFaktur: x.faktur.size, terakhirBeli: x.terakhir,
    })).sort((a, b) => b.rataPerBulan - a.rataPerBulan || b.terakhirBeli.localeCompare(a.terakhirBeli) || a.code.localeCompare(b.code) || a.unit.localeCompare(b.unit));
    return {
        jendela: { bulan: o.bulan, dari: o.dari, sampai: o.sampai, bulanTeramati: bulat2(bulan) },
        ringkasan: { jumlahFaktur: faktur.size, tanpaRincian: [...faktur.values()].filter((ada) => !ada).length, dataSejak: o.palingAwal },
        items,
    };
}

// ---------------------------------------------------------------- klien (panel "Biasa diambil toko ini")

/** Barang riwayat dari API: + apakah KINI bisa diorder untuk pelanggan ini (aturan barang order O1) dan alasannya bila tidak. */
export type BarangRiwayatOrder = BarangRiwayat & { bisaDiorder: boolean; alasan: string | null };
export type Riwayat = { jendela: Jendela; ringkasan: RingkasanRiwayat; items: BarangRiwayatOrder[] };

export const urlRiwayat = (customerNo: string, bulan = BULAN_BAWAAN) =>
    `/api/customers/riwayat-beli?${new URLSearchParams({ customerNo: customerNo.trim(), bulan: String(bulan) })}`;

/** Tombol Tambah: jumlah = pembulatan ke atas rata-rata per bulan, minimal 1 (bisa diubah di barisnya). */
export const jumlahTambah = (rata: number) => Math.max(1, Math.ceil(rata));

/** Kunci "barang + satuan sudah ada di order". */
export const kunciBaris = (code: string, unit: string) => `${code.trim()}|${unit.trim().toUpperCase()}`;

/**
 * Satuan baris baru dari Tambah: harus ada di satuan master barang (dibaca ulang dari pencarian barang cabang pelanggan) — ejaan master
 * dipakai. Sales tidak bisa memesan satuan tanpa harga sah (harga tidak pernah dikirim sales); petugas Order Baru boleh (harga petugas).
 */
export function satuanTambah(b: { units: readonly { unit: string; price: number | null }[]; hargaUntuk: string }, unit: string, peran: "sales" | "petugas", kunciHargaKini: string): { unit: string } | { alasan: string } {
    const u = b.units.find((x) => x.unit.trim().toUpperCase() === unit.trim().toUpperCase());
    if (!u) return { alasan: `Satuan ${unit} tidak ada lagi di daftar harga barang ini. Cari barangnya lewat "Cari barang" dan pilih satuan lain.` };
    if (peran === "sales" && b.hargaUntuk === kunciHargaKini && u.price === null) {
        return { alasan: `Harga ${unit} belum ada di Accurate untuk cabang pelanggan; barang ini belum bisa dikirim. Minta petugas melengkapinya.` };
    }
    return { unit: u.unit };
}

/** Baris dari Tambah mengisi baris kosong PERTAMA (belum memilih barang); tidak ada = ditambah di akhir. */
export function sisipkanBaris<L extends { code: string }>(lines: readonly L[], baru: L): L[] {
    const i = lines.findIndex((l) => !l.code.trim());
    return i < 0 ? [...lines, baru] : lines.map((l, k) => (k === i ? baru : l));
}

const teks = (v: unknown) => (typeof v === "string" ? v : "");
const angka = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

/** Jawaban 200 API -> Riwayat; bentuk tak terbaca = null (pemanggil menampilkannya sebagai galat, BUKAN riwayat kosong). */
export function bacaRiwayat(d: Record<string, unknown>): Riwayat | null {
    const j = (d.jendela ?? {}) as Record<string, unknown>, r = (d.ringkasan ?? {}) as Record<string, unknown>;
    const jendela: Jendela = { bulan: angka(j.bulan), dari: teks(j.dari), sampai: teks(j.sampai), bulanTeramati: angka(j.bulanTeramati) };
    const ringkasan: RingkasanRiwayat = { jumlahFaktur: angka(r.jumlahFaktur), tanpaRincian: angka(r.tanpaRincian), dataSejak: typeof r.dataSejak === "string" ? r.dataSejak : null };
    if (!Array.isArray(d.items) || !jendela.dari || Number.isNaN(jendela.bulanTeramati) || Number.isNaN(ringkasan.jumlahFaktur) || Number.isNaN(ringkasan.tanpaRincian)) return null;
    const items = d.items.flatMap((raw): BarangRiwayatOrder[] => {
        const x = (raw ?? {}) as Record<string, unknown>;
        if (!teks(x.code) || !teks(x.unit) || Number.isNaN(angka(x.rataPerBulan))) return [];
        return [{ code: teks(x.code), name: teks(x.name), unit: teks(x.unit), totalQty: angka(x.totalQty), rataPerBulan: angka(x.rataPerBulan),
            jumlahFaktur: angka(x.jumlahFaktur), terakhirBeli: teks(x.terakhirBeli), bisaDiorder: x.bisaDiorder === true, alasan: teks(x.alasan) || null }];
    });
    return { jendela, ringkasan, items };
}
