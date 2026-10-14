/*
 * Tujuan: Salin faktur Accurate (Postgres `sales_invoice`, rincian dari detail.do) ke History Penjualan (SQLite) — bertahap, idempoten.
 * Caller: cron VPS (Bearer CRON_SECRET), sesudah sync-accurate / webhook-backfill.
 * Dependensi: lib/db (Postgres, baca saja), lib/sales-history/{db,accurate}.
 * Main Functions: GET.
 * Side Effects: Tulis sales-history-inv.db: invoice_map (INSERT OR REPLACE), sales_history_item source_file='accurate'
 *   (hapus+isi ulang per faktur), sync_cursor; satukan principal ADNA -> GUMINDO. TIDAK menulis ke Accurate.
 * Catatan: kursor keyset (synced_at, id) memakai idx_sales_invoice_synced_at; synced_at hanya berubah bila raw_data berubah,
 *   jadi faktur yang disunting / baru ditambal rinciannya otomatis tersalin ulang. Faktur yang sudah punya baris dari
 *   berkas closing / CSV e-Faktur dilewati (berkas itu otoritas). raw_data diambil lewat primary key per potongan
 *   (pola aman memori: lihat promo-recap). `?limit=` = batas faktur yang diperiksa per run (bawaan 20.000).
 *   ponytail: faktur yang DIHAPUS di Accurate tetap tinggal di History; tambahkan sapuan hapus bila itu jadi masalah.
 */
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireCronSecret } from "@/lib/api-security";
import { ensureSalesHistorySchema, salesClient } from "@/lib/sales-history/db";
import { ALIAS_PRINCIPAL, fakturKeHistory, SUMBER_ACCURATE } from "@/lib/sales-history/accurate";

export const runtime = "nodejs";
export const maxDuration = 3600;

const POTONG = 500;
type Baris = Record<string, unknown>;

export async function GET(req: Request) {
    const gate = requireCronSecret(req);
    if (gate.response) return gate.response;
    const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get("limit")) || 20_000, POTONG), 300_000);

    await ensureSalesHistorySchema();
    for (const [lama, baru] of ALIAS_PRINCIPAL) {
        await salesClient.execute({ sql: "UPDATE invoice_map SET principal = ? WHERE principal = ?", args: [baru, lama] });
    }
    const dikenal = new Set((await salesClient.execute("SELECT DISTINCT principal FROM invoice_map")).rows.map((r) => String(r.principal)));
    const barang = await db.execute(sql`SELECT no, CASE WHEN pg_input_is_valid(raw_data #>> '{}', 'jsonb')
        THEN (raw_data #>> '{}')::jsonb ->> 'charField1' END AS principal FROM item`);
    const principalBarang = new Map(barang.rows.map((r: Baris) => [String(r.no), String(r.principal ?? "").trim()]));

    const kursor = (await salesClient.execute("SELECT synced_at, last_id FROM sync_cursor WHERE name = 'accurate'")).rows[0];
    let at = String(kursor?.synced_at ?? "1970-01-01T00:00:00Z");
    let lastId = Number(kursor?.last_id ?? 0);
    let diperiksa = 0, disalin = 0, barisItem = 0, dilewatiBerkas = 0, tanpaRincian = 0;

    while (diperiksa < limit) {
        // synced_at sebagai TEKS: Date JS memotong mikrodetik, kursor bisa macet di satu milidetik.
        const potongan = (await db.execute(sql`SELECT id, number, synced_at::text AS at FROM sales_invoice
            WHERE number LIKE 'INV/%' AND (synced_at, id) > (${at}::timestamptz, ${lastId})
            ORDER BY synced_at, id LIMIT ${POTONG}`)).rows as Baris[];
        if (potongan.length === 0) break;
        diperiksa += potongan.length;

        const refs = potongan.map((r) => String(r.number));
        const milikBerkas = new Set((await salesClient.execute({
            sql: `SELECT DISTINCT referensi FROM sales_history_item WHERE source_file <> ? AND referensi IN (${refs.map(() => "?").join(",")})`,
            args: [SUMBER_ACCURATE, ...refs],
        })).rows.map((r) => String(r.referensi)));
        dilewatiBerkas += milikBerkas.size;
        const ids = potongan.filter((r) => !milikBerkas.has(String(r.number))).map((r) => Number(r.id));

        const tulis: Array<{ sql: string; args: Array<string | number> }> = [];
        if (ids.length > 0) {
            const mentah = (await db.execute(sql`SELECT raw_data #>> '{}' AS raw FROM sales_invoice
                WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)).rows as Baris[];
            for (const { raw } of mentah) {
                let f;
                try { f = fakturKeHistory(raw, (kode) => principalBarang.get(kode) ?? "", dikenal); } catch { f = null; }
                if (!f) { tanpaRincian += 1; continue; }
                tulis.push({ sql: "DELETE FROM sales_history_item WHERE referensi = ? AND source_file = ?", args: [f.referensi, SUMBER_ACCURATE] });
                tulis.push({ sql: "INSERT OR REPLACE INTO invoice_map (referensi, kode_cust, principal, tanggal) VALUES (?,?,?,?)", args: [f.referensi, f.kodeCust, f.principal, f.tanggal] });
                for (const i of f.items) {
                    tulis.push({
                        sql: `INSERT INTO sales_history_item (referensi, nomor_faktur, tanggal, customer_nama, customer_npwp, kode_objek, nama_produk,
                              qty, satuan, harga_satuan, harga_total, diskon_rp, dpp, ppn, source_file, keterangan) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                        args: [i.referensi, i.nomorFaktur, i.tanggal, i.customerNama, i.customerNpwp, i.kodeObjek, i.namaProduk,
                            i.qty, i.satuan, i.hargaSatuan, i.hargaTotal, i.diskonRp, i.dpp, i.ppn, i.sourceFile, i.keterangan],
                    });
                }
                disalin += 1;
                barisItem += f.items.length;
            }
        }
        const akhir = potongan[potongan.length - 1];
        at = String(akhir.at);
        lastId = Number(akhir.id);
        // Kursor maju dalam transaksi yang sama dengan datanya: run yang terputus mengulang potongan, tidak melompatinya.
        tulis.push({ sql: "INSERT OR REPLACE INTO sync_cursor (name, synced_at, last_id) VALUES ('accurate', ?, ?)", args: [at, lastId] });
        await salesClient.batch(tulis, "write");
    }

    const sisa = Number((await db.execute(sql`SELECT count(*)::int AS n FROM sales_invoice
        WHERE number LIKE 'INV/%' AND (synced_at, id) > (${at}::timestamptz, ${lastId})`)).rows[0]?.n ?? 0);
    console.log(`[SALES HISTORY ACCURATE] ${diperiksa} diperiksa, ${disalin} faktur (${barisItem} baris) disalin, ${dilewatiBerkas} milik berkas, ${tanpaRincian} tanpa rincian, ${sisa} sisa`);
    return NextResponse.json({ ok: true, diperiksa, disalin, barisItem, dilewatiBerkas, tanpaRincian, sisa, kursor: { at, lastId } });
}
