/*
 * Tujuan: Item Super di Postgres (owner 13 Nov 2026): ganti daftar per principal, ringkasan untuk Admin, saran per kunjungan (riwayat beli toko
 *   dari History Penjualan SQLite), dan tulis penawaran di transaksi merchandising.
 * Caller: app/api/form-kontrol/item-super/** , app/api/form-kontrol/merchandising/route.ts, lib/supervisor-review/kontrol-db.ts.
 * Dependensi: lib/db, db/schema (itemSuper, tawaranItemSuper, jksMaster, kunjunganLuarRute, salesProfile), ./item-super (murni),
 *   ./constants (kodeJksUntuk), lib/sales-history/db (dimuat saat dipakai).
 * Main Functions: gantiItemSuper, ringkasanItemSuper, daftarItemSuper, riwayatBeliToko, muatSaranKunjungan.
 * Side Effects: gantiItemSuper menulis item_super (DELETE + INSERT satu transaksi); riwayatBeliToko membaca SQLite History Penjualan.
 */
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { itemSuper, jksMaster, kunjunganLuarRute, salesProfile, tawaranItemSuper } from "@/db/schema";
import { kodeJksUntuk } from "./constants";
import { RIWAYAT_HARI, channelToko, pilihSaran, type Channel, type SaranItemSuper } from "./item-super";

/** Unggahan menggantikan SELURUH daftar principal yang ada di berkas (semua channel + daftar MT per sales); principal lain tidak disentuh. */
export async function gantiItemSuper(saran: readonly SaranItemSuper[], periode: string, oleh: string) {
    const principal = [...new Set(saran.map((s) => s.principle))];
    return db.transaction(async (tx) => {
        const lama = principal.length ? await tx.delete(itemSuper).where(inArray(itemSuper.principle, principal)).returning({ id: itemSuper.id }) : [];
        for (let i = 0; i < saran.length; i += 500) {
            await tx.insert(itemSuper).values(saran.slice(i, i + 500).map((s) => ({ id: randomUUID(), ...s, periode, diunggahOleh: oleh })));
        }
        return { principal, ditulis: saran.length, diganti: lama.length };
    });
}

/** Ringkasan per principal × channel (+ jumlah daftar MT per sales) untuk tab Item Super. */
export async function ringkasanItemSuper() {
    return (await db.execute(sql`SELECT principle, channel, count(*) FILTER (WHERE sales_code = '')::int AS "jumlahChannel",
            count(DISTINCT sales_code) FILTER (WHERE sales_code <> '')::int AS "jumlahSales", min(periode) AS periode, max(diunggah_pada) AS "diunggahPada"
        FROM ${itemSuper} GROUP BY principle, channel ORDER BY principle, channel`)).rows as {
            principle: string; channel: string; jumlahChannel: number; jumlahSales: number; periode: string; diunggahPada: string }[];
}

export async function daftarItemSuper(principle: string) {
    return db.select({ channel: itemSuper.channel, salesCode: itemSuper.salesCode, peringkat: itemSuper.peringkat, kodeBarang: itemSuper.kodeBarang,
        kodeLain: itemSuper.kodeLain, namaBarang: itemSuper.namaBarang, kontribusi: itemSuper.kontribusi, omzetRata: itemSuper.omzetRata,
        jumlahToko: itemSuper.jumlahToko }).from(itemSuper).where(eq(itemSuper.principle, principle))
        .orderBy(asc(itemSuper.channel), asc(itemSuper.salesCode), asc(itemSuper.peringkat));
}

/**
 * Kode barang -> tanggal beli terakhir toko (semua principal) dalam RIWAYAT_HARI SEBELUM `tanggal` (hari kunjungan tidak ikut: faktur hari itu
 * masuk History di tengah hari dan akan menggeser daftar saran wajib antara layar dibuka dan Simpan), dari History Penjualan
 * (invoice_map.kode_cust = kode toko tanpa akhiran divisi; indeks idx_im_kode_cust_tanggal). null = History tidak bisa dibaca (layar menyebutnya,
 * saran tetap tampil). Tanpa ensureSalesHistorySchema: janji yang gagal sekali tersimpan seumur proses, sedangkan kueri ini hanya membaca.
 */
export async function riwayatBeliToko(custCode: string, tanggal: string): Promise<Map<string, string> | null> {
    try {
        const { salesClient } = await import("@/lib/sales-history/db");
        const [y, m, d] = tanggal.split("-").map(Number);
        const dari = new Date(Date.UTC(y, m - 1, d) - RIWAYAT_HARI * 86_400_000).toISOString().slice(0, 10);
        const kode = [...new Set(kodeJksUntuk(custCode))];
        const r = await salesClient.execute({
            sql: `SELECT shi.kode_objek AS kode, MAX(shi.tanggal) AS terakhir FROM invoice_map im JOIN sales_history_item shi ON shi.referensi = im.referensi
                  WHERE im.kode_cust IN (${kode.map(() => "?").join(", ")}) AND im.tanggal >= ? AND im.tanggal < ? AND im.referensi LIKE 'INV/%'
                  GROUP BY shi.kode_objek`,
            args: [...kode, dari, tanggal],
        });
        return new Map(r.rows.map((x) => [String(x.kode), String(x.terakhir).slice(0, 10)]));
    } catch {
        return null;
    }
}

/**
 * Saran item super satu kunjungan + jawaban yang sudah tersimpan. Channel toko = jks_master (luar rute: channel profil sales). Dipakai GET saran
 * (layar) DAN POST merchandising (validasi server: daftar wajib dihitung ulang, bukan dipercaya dari layar).
 */
export async function muatSaranKunjungan(k: { salesCode: string; custCode: string; principle: string; tanggal: string }) {
    const [[jks], [luar], [profil]] = await Promise.all([
        db.select({ channel: jksMaster.channel }).from(jksMaster).where(and(eq(jksMaster.salesCode, k.salesCode), eq(jksMaster.custCode, k.custCode),
            eq(jksMaster.principle, k.principle))).limit(1),
        db.select({ id: kunjunganLuarRute.id }).from(kunjunganLuarRute).where(and(eq(kunjunganLuarRute.salesCode, k.salesCode),
            eq(kunjunganLuarRute.custCode, k.custCode), eq(kunjunganLuarRute.principle, k.principle), eq(kunjunganLuarRute.tanggal, k.tanggal),
            isNull(kunjunganLuarRute.dibatalkanPada))).limit(1),
        db.select({ channel: salesProfile.channel }).from(salesProfile).where(eq(salesProfile.salesCode, k.salesCode)).limit(1),
    ]);
    const channel = channelToko(jks?.channel ?? (luar ? profil?.channel : null));
    const [daftar, tersimpan, riwayat] = await Promise.all([
        db.select().from(itemSuper).where(and(eq(itemSuper.principle, k.principle), eq(itemSuper.channel, channel),
            inArray(itemSuper.salesCode, ["", k.salesCode]))),
        db.select({ kodeBarang: tawaranItemSuper.kodeBarang, ditawarkan: tawaranItemSuper.ditawarkan, dipesan: tawaranItemSuper.dipesan,
            alasan: tawaranItemSuper.alasan, catatan: tawaranItemSuper.catatan }).from(tawaranItemSuper)
            .where(and(eq(tawaranItemSuper.salesCode, k.salesCode), eq(tawaranItemSuper.custCode, k.custCode), eq(tawaranItemSuper.principle, k.principle),
                eq(tawaranItemSuper.tanggal, k.tanggal))),
        riwayatBeliToko(k.custCode, k.tanggal),
    ]);
    const saran = pilihSaran(daftar.map((d) => ({ ...d, channel: d.channel as Channel })), { principle: k.principle, channel, salesCode: k.salesCode },
        riwayat ?? new Map());
    return { channel, ...saran, tersimpan, riwayatTerbaca: riwayat !== null, adaDaftar: daftar.length > 0 };
}

/** Saran per kunjungan bulan itu milik salesman (Supervisor Review kontrol): jumlah tawaran per status. */
export async function tawaranBulan(salesCodes: string[], dari: string, sampai: string) {
    if (salesCodes.length === 0) return [];
    return db.select({ salesCode: tawaranItemSuper.salesCode, custCode: tawaranItemSuper.custCode, tanggal: tawaranItemSuper.tanggal,
        kodeBarang: tawaranItemSuper.kodeBarang, ditawarkan: tawaranItemSuper.ditawarkan, dipesan: tawaranItemSuper.dipesan, alasan: tawaranItemSuper.alasan })
        .from(tawaranItemSuper).where(and(inArray(tawaranItemSuper.salesCode, salesCodes), gte(tawaranItemSuper.tanggal, dari),
            sql`${tawaranItemSuper.tanggal} <= ${sampai}`));
}
