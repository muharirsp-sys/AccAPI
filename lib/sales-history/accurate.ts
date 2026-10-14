/*
 * Tujuan: Ubah satu faktur Accurate (`sales_invoice.raw_data`, jawaban detail.do) menjadi baris History Penjualan.
 * Caller: app/api/cron/sales-history-accurate/route.ts.
 * Dependensi: tidak ada — murni, tanpa DB/jaringan.
 * Main Functions: fakturKeHistory, namaPrincipal.
 * Side Effects: tidak ada.
 * Catatan: pemetaan dicocokkan baris-per-baris dengan data closing Mei 2026 di produksi (14 Okt 2026):
 *   grossAmount = NILAI_JUAL, itemCashDiscount = POTONGAN (sudah termasuk diskon persen), dppAmount = DPP,
 *   tax1Amount = NILAI_PAJAK, description = REM, kode customer = kode dalam kurung kurawal nama customer,
 *   principal = charField1 master barang (nama yang sama persis dengan kolom PRINCIPAL berkas closing).
 */

export const SUMBER_ACCURATE = "accurate";

// Perusahaan yang berganti nama: data lama dan baru disatukan ke nama baru (owner 14 Okt 2026).
const ALIAS: Record<string, string> = { "ADNA SENTRAL NIAGA, PT": "GUMINDO BOGAMANIS, PT" };
export const namaPrincipal = (nama: string) => ALIAS[nama] ?? nama;
export const ALIAS_PRINCIPAL = Object.entries(ALIAS);

export type BarisHistory = {
    referensi: string; nomorFaktur: string; tanggal: string; customerNama: string; customerNpwp: string;
    kodeObjek: string; namaProduk: string; qty: number; satuan: string; hargaSatuan: number; hargaTotal: number;
    diskonRp: number; dpp: number; ppn: number; sourceFile: string; keterangan: string;
};
export type FakturHistory = { referensi: string; kodeCust: string; principal: string; tanggal: string; items: BarisHistory[] };

type Obj = Record<string, unknown>;
const teks = (v: unknown) => String(v ?? "").replace(/[\r\n]+/g, " ").trim();
const angka = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * `null` bila bukan faktur INV atau belum ada rincian barang (list.do tidak membawa `detailItem`;
 * faktur itu terambil lagi setelah penambal mengisi rinciannya, karena `synced_at` ikut berubah).
 * `principalBarang(kodeBarang)` = charField1 master barang; `dikenal` = principal yang sudah ada di History.
 */
export function fakturKeHistory(raw: unknown, principalBarang: (kode: string) => string, dikenal: Set<string>): FakturHistory | null {
    const f = (typeof raw === "string" ? JSON.parse(raw) : raw ?? {}) as Obj;
    const referensi = teks(f.number);
    const rinci = Array.isArray(f.detailItem) ? (f.detailItem as Obj[]) : [];
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(teks(f.transDate));
    if (!referensi.toUpperCase().startsWith("INV/") || rinci.length === 0 || !m) return null;
    const tanggal = `${m[3]}-${m[2]}-${m[1]}`;
    const cust = (f.customer ?? {}) as Obj;
    const customerNama = teks(cust.name);
    // "ANNISA, TK {C-ANN028}" -> C-ANN028; cadangan: customerNo tanpa akhiran cabang (C-ANN028-HZ).
    const kodeCust = /\{([^}]+)\}\s*$/.exec(customerNama)?.[1].trim() ?? teks(cust.customerNo ?? f.customerNo).replace(/-[A-Z0-9]{2}$/, "");
    const items = rinci.map((d): BarisHistory => {
        const barang = (d.item ?? {}) as Obj;
        return {
            referensi, nomorFaktur: referensi, tanggal, customerNama,
            customerNpwp: teks(cust.npwpNo).replace(/^0+/, ""), // berkas closing menyimpan NPWP sebagai angka (nol depan hilang)
            kodeObjek: teks(barang.no ?? d.itemNo),
            namaProduk: teks(barang.name ?? d.detailName),
            qty: angka(d.quantity),
            satuan: teks((d.itemUnit as Obj | undefined)?.name),
            hargaSatuan: angka(d.unitPrice),
            hargaTotal: angka(d.grossAmount),
            diskonRp: angka(d.itemCashDiscount),
            dpp: angka(d.dppAmount),
            ppn: angka(d.tax1Amount),
            sourceFile: SUMBER_ACCURATE,
            keterangan: teks(f.description),
        };
    });
    // Satu principal per faktur (sama dengan berkas closing). Faktur cabang MIX memuat beberapa principal:
    // ambil yang pertama dikenal History; charField1 sampah ("Toko Aswan") tidak menang atas nama PT yang sah.
    const kandidat = items.map((i) => namaPrincipal(principalBarang(i.kodeObjek))).filter(Boolean);
    const principal = kandidat.find((p) => dikenal.has(p)) ?? kandidat[0] ?? teks(f.branchName);
    return { referensi, kodeCust, principal, tanggal, items };
}
