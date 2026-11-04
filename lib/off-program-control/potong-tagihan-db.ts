/*
 * Tujuan: Baca data untuk aturan Potong Tagihan (potong-tagihan.ts): faktur tersinkron per nomor dan potongan OPC yang sudah
 *   tercatat per faktur, plus kunci per faktur agar dua pencatatan bersamaan tidak memakai sisa tagihan yang sama.
 * Caller: app/api/off-program-control/batches/[id]/finance-payment/route.ts, app/api/off-program-control/faktur-potong/route.ts.
 * Dependensi: db (Postgres), sales_invoice (indeks idx_sales_invoice_number, 0040), off_potong_tagihan.
 * Main Functions: cariFakturPotong, potonganTerpakai, kunciFakturPotong.
 * Side Effects: baca DB; kunciFakturPotong mengambil advisory lock transaksi.
 */
import { inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { offPotongTagihan, salesInvoiceCache } from "@/db/schema";
import { nomorFakturKunci, type FakturPotong } from "./potong-tagihan";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Baca = Pick<typeof db, "select"> | Tx;

/** Faktur per kunci nomor. Kolom kecil saja (tanpa raw_data). Nomor dicari apa adanya dan huruf besar. */
export async function cariFakturPotong(nomor: string[], executor: Baca = db): Promise<Map<string, FakturPotong[]>> {
    const cari = Array.from(new Set(nomor.flatMap((n) => [n.trim(), nomorFakturKunci(n)]).filter(Boolean)));
    const peta = new Map<string, FakturPotong[]>();
    if (cari.length === 0) return peta;
    const rows = await executor.select({
        id: salesInvoiceCache.id, number: salesInvoiceCache.number, customerNo: salesInvoiceCache.customerNo,
        customerName: salesInvoiceCache.customerName, outstanding: salesInvoiceCache.outstanding,
    }).from(salesInvoiceCache).where(inArray(salesInvoiceCache.number, cari));
    for (const r of rows) {
        const kunci = nomorFakturKunci(r.number);
        peta.set(kunci, [...(peta.get(kunci) ?? []), { ...r, number: r.number ?? kunci }]);
    }
    return peta;
}

/** Σ potongan OPC yang sudah tercatat per kunci nomor faktur. */
export async function potonganTerpakai(nomor: string[], executor: Baca = db): Promise<Map<string, number>> {
    const kunci = Array.from(new Set(nomor.map(nomorFakturKunci).filter(Boolean)));
    const peta = new Map<string, number>();
    if (kunci.length === 0) return peta;
    const rows = await executor.select({ no: offPotongTagihan.invoiceNo, jumlah: sql<number>`sum(${offPotongTagihan.amount})` })
        .from(offPotongTagihan).where(inArray(sql`upper(${offPotongTagihan.invoiceNo})`, kunci)).groupBy(offPotongTagihan.invoiceNo);
    for (const r of rows) peta.set(nomorFakturKunci(r.no), (peta.get(nomorFakturKunci(r.no)) ?? 0) + Number(r.jumlah || 0));
    return peta;
}

/** Kunci per faktur (urutan tetap = tanpa deadlock) untuk sisa transaksi; dipanggil sebelum membaca ulang `potonganTerpakai`. */
export async function kunciFakturPotong(tx: Tx, nomor: string[]) {
    for (const k of Array.from(new Set(nomor.map(nomorFakturKunci))).sort()) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`opc_potong:${k}`}, 0))`);
    }
}
