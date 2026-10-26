/*
 * Tujuan: Faktur + retur Accurate cabang MIX FOOD → baris laporan Enigma (Enesis / PT Marketama Indah), 33 kolom template_enigma.xlsx.
 *   Pengganti workbook "Format Report Enigma Enesis.xlsx" (PASTE → Tabel3) beserta tiga rumus manualnya.
 * Caller: lib/enigma/jalankan.ts; uji lib/enigma/laporan.test.ts.
 * Dependensi: peta.json — barang: PRODUK_ID_DISTRIBUTOR → [PRODUK_ID_MI, ISI, HARGA karton termasuk PPN] (sheet BARANG / Tabel1),
 *   outlet: CUST_ID → TYPE_OUTLET (sheet CUST + riwayat unggah).
 * Main Functions: barisEnigma, KOLOM_ENIGMA, PEMASOK_MARKETAMA.
 * Side Effects: tidak ada (murni).
 * Rumus owner (26 Okt 2026) — Enigma menolak "QTY_CRT tidak sesuai dengan VALUE_BRUTO" bila harga ≠ harga acuan Enesis:
 *   PRICE_JUAL = UNIT "KRT" ? HARGA : HARGA PCS (HARGA/ISI) dari Tabel1, VALUE_BRUTO = PRICE_JUAL × QTY, VALUE_NETTO = VALUE_BRUTO − DISC_RUTIN.
 *   DISC_RUTIN = potongan faktur × (1 + PPN) — sama dengan isi Tabel3 Okt 2026 (POTONGAN × 1,11).
 */
import peta from "./peta.json";

export const KOLOM_ENIGMA = ["CUST_SHIP_ID_DIST", "CUST_SHIP_NM_SUBDIST", "CUST_SHIP_ID_SUBDIST", "CABANG", "PRINSIPAL", "SALES_TYPE", "CUST_ID",
    "CUST_NAME", "TYPE_OUTLET", "ADDRESS", "KELURAHAN", "KECAMATAN", "KABUPATEN", "KODE_POS", "SALESMAN_ID", "SALESMAN_DESC", "INVOICE_NUMBER",
    "DATE_INVOICE", "PRODUK_ID_MI", "PRODUK_ID_DISTRIBUTOR", "PRODUK_DESC", "PRICE_JUAL", "UNIT", "QTY", "QTY_CRT", "VALUE_BRUTO", "DISC_RUTIN",
    "DISC_PRINSIPAL", "DISC_1", "DISC_EXTRA", "DISC_2", "DISC_COD", "VALUE_NETTO"] as const;
export type BarisEnigma = Record<(typeof KOLOM_ENIGMA)[number], string | number>;

export const PEMASOK_MARKETAMA = 14150; // vendor "PT Marketama Indah" (S-MI) = preferedVendor 92 barang (probe 26 Okt 2026)
const SUBDIST = 1000718;
const OUTLET_BAWAAN = "MTI OTHERS"; // 71 dari 93 pelanggan yang sudah dipetakan
const BARANG = peta.barang as unknown as Record<string, [string, number, number]>;
const OUTLET = peta.outlet as Record<string, string>;

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {});
const angka = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const teks = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
const iso = (v: unknown) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(teks(v)); return m ? `${m[3]}-${m[2]}-${m[1]}` : ""; };

/**
 * Dokumen detail.do → baris Enigma untuk barang berpemasok Marketama. Faktur hanya `INV/`, retur tanpa `RSJ` (sama dengan ABCPI).
 * `lewat` = barang tanpa PRODUK_ID_MI (dibuang, dilaporkan — Enigma menolak isian kosong); `outletBaru` = pelanggan yang diberi
 * TYPE_OUTLET bawaan; `galat` = isian wajib Enigma yang kosong (unggahan dibatalkan).
 */
export function barisEnigma(dokumen: unknown[], retur: boolean) {
    const baris: BarisEnigma[] = [];
    const lewat = new Map<string, string>(), outletBaru = new Map<string, string>(), galat = new Set<string>();
    for (const f of dokumen.map(o)) {
        const nomor = teks(f.number);
        if (retur ? nomor.toUpperCase().startsWith("RSJ") : !nomor.toUpperCase().startsWith("INV/")) continue;
        const cust = o(f.customer);
        const custId = /\{([^}]+)\}\s*$/.exec(String(cust.name ?? ""))?.[1].trim() ?? teks(cust.customerNo).replace(/-[A-Z0-9]{1,4}$/, "");
        const tanda = retur ? -1 : 1;
        for (const d of (Array.isArray(f.detailItem) ? f.detailItem : []).map(o)) {
            const item = o(d.item);
            if (angka(item.preferedVendorId) !== PEMASOK_MARKETAMA) continue;
            const kode = teks(item.no ?? d.itemNo);
            const b = BARANG[kode];
            if (!b) { lewat.set(kode, teks(item.name ?? d.detailName)); continue; }
            const [produkMi, isi, hargaKrt] = b;
            const rasio = angka(d.unitRatio) || 1;
            const karton = teks(o(d.itemUnit).name).toUpperCase() === "KRT" || (rasio > 1 && rasio === isi);
            // Satuan menengah (rasio di antara 1 dan isi karton) dilaporkan dalam satuan terkecil agar harga per satuan tetap benar.
            const unit = karton ? "KRT" : rasio > 1 ? teks(o(item.unit1).name) || "PCS" : teks(o(d.itemUnit).name);
            const qty = (karton || rasio === 1 ? angka(d.quantity) : angka(d.quantity) * rasio) * tanda;
            const harga = karton ? hargaKrt : hargaKrt / isi;
            const bruto = harga * qty;
            const disc = angka(d.itemCashDiscount) * (d.useTax1 === false ? 1 : 1 + (angka(d.tax1Rate) || 11) / 100) * tanda;
            const outlet = OUTLET[custId];
            if (!outlet) outletBaru.set(custId, teks(cust.name));
            const sales = o(Array.isArray(d.salesmanList) ? d.salesmanList[0] : undefined);
            const slsId = teks(sales.number), slsNama = teks(d.salesmanName ?? sales.name ?? f.masterSalesmanName);
            if (!slsId || !slsNama) galat.add(`${nomor}: salesman kosong (SALESMAN_ID/DESC wajib di Enigma)`);
            baris.push({
                CUST_SHIP_ID_DIST: SUBDIST, CUST_SHIP_NM_SUBDIST: "SURYA PERKASA", CUST_SHIP_ID_SUBDIST: SUBDIST, CABANG: "CV. SURYA PERKASA",
                PRINSIPAL: "PT. MARKETAMA INDAH", SALES_TYPE: retur ? "RETUR" : "SALES", CUST_ID: custId, CUST_NAME: teks(cust.name),
                TYPE_OUTLET: outlet ?? OUTLET_BAWAAN, ADDRESS: teks(f.toAddress), KELURAHAN: "", KECAMATAN: "", KABUPATEN: "", KODE_POS: "",
                SALESMAN_ID: slsId, SALESMAN_DESC: slsNama, INVOICE_NUMBER: nomor, DATE_INVOICE: iso(f.transDate),
                PRODUK_ID_MI: produkMi, PRODUK_ID_DISTRIBUTOR: kode, PRODUK_DESC: teks(item.name ?? d.detailName),
                PRICE_JUAL: harga, UNIT: unit, QTY: qty, QTY_CRT: (angka(d.quantity) * rasio * tanda) / isi,
                VALUE_BRUTO: bruto, DISC_RUTIN: disc, DISC_PRINSIPAL: 0, DISC_1: 0, DISC_EXTRA: 0, DISC_2: 0, DISC_COD: 0, VALUE_NETTO: bruto - disc,
            });
        }
    }
    return { baris, lewat, outletBaru, galat };
}
