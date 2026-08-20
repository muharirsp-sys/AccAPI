// scripts/reconcile-sales-history-batch.mjs
// Tujuan: bandingkan agregat batch (jumlah faktur/retur, nilai) terhadap cache Accurate (Postgres
//   sales_invoice/sales_return, diisi lib/sync.ts) untuk periode yang sama. Penjualan (INV) dan
//   retur (RJN/SRT, jenis_transaksi='RETUR') dibandingkan TERPISAH ke cache masing-masing
//   (sales_invoice vs sales_return) -- keduanya harus cocok sebelum batch boleh 'reconciled'.
// Catatan: cache Accurate TIDAK punya breakdown diskon/pajak per baris (hanya total_amount per
//   faktur/retur) -- reconciliation ini hanya menutup jumlah + total nilai. Breakdown per
//   principal/produk/diskon/pajak tetap harus dicek manual vs laporan Accurate (lihat runbook Task 7).
// Catatan sign convention: belum diverifikasi ke data Accurate produksi asli apakah sales_return.
//   total_amount disimpan positif atau negatif (data kita sendiri sudah negatif utuh dari Accurate,
//   qty/harga/dpp/ppn retur semua negatif). Perbandingan retur di bawah memakai Math.abs() di kedua
//   sisi supaya tahan terhadap konvensi tanda yang berbeda -- kalau ternyata Accurate juga negatif,
//   ini tetap benar; kalau Accurate positif, ini juga tetap benar. Sengaja tidak diasumsikan satu sisi.
// Jalankan: node scripts/reconcile-sales-history-batch.mjs --batch <id>
import { createClient } from "@libsql/client";
import { Pool } from "pg";

const DB_URL = process.env.SALES_HISTORY_DATABASE_URL || "file:sales-history-inv.db";
const salesDb = createClient({ url: DB_URL });
const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });

const TOLERANCE_RP = Number(process.env.RECONCILE_TOLERANCE_RP || 1000);

const args = process.argv.slice(2);
const batchId = Number(args[args.indexOf("--batch") + 1]);
if (!Number.isInteger(batchId) || batchId <= 0) {
    console.error("Wajib: --batch <id>");
    process.exit(1);
}

async function main() {
    const batch = (await salesDb.execute({ sql: "SELECT * FROM import_batch WHERE id = ?", args: [batchId] })).rows[0];
    if (!batch) {
        console.error(`Batch #${batchId} tidak ditemukan`);
        process.exit(1);
    }
    // 'reconcile_failed' juga diterima: retry langsung tanpa perlu validate ulang (data belum berubah,
    // cuma dibandingkan lagi -- misal setelah cache Accurate disinkron ulang atau custCodes diperbaiki).
    if (batch.stage !== "validated" && batch.stage !== "reconcile_failed") {
        console.error(`Batch #${batchId} stage='${batch.stage}' — reconcile hanya boleh jalan dari stage 'validated' atau 'reconcile_failed'.`);
        process.exit(1);
    }

    const ours = (await salesDb.execute({
        sql: `SELECT
                COUNT(DISTINCT CASE WHEN jenis_transaksi = 'PENJUALAN' THEN referensi END) AS jumlah_faktur,
                SUM(CASE WHEN jenis_transaksi = 'PENJUALAN' THEN dpp + ppn ELSE 0 END) AS nilai_faktur,
                COUNT(DISTINCT CASE WHEN jenis_transaksi = 'RETUR' THEN referensi END) AS jumlah_retur,
                SUM(CASE WHEN jenis_transaksi = 'RETUR' THEN dpp + ppn ELSE 0 END) AS nilai_retur
              FROM sales_history_item WHERE batch_id = ?`,
        args: [batchId],
    })).rows[0];

    const custCodes = (await salesDb.execute({
        sql: "SELECT DISTINCT kode_cust FROM invoice_map WHERE batch_id = ?",
        args: [batchId],
    })).rows.map((r) => String(r.kode_cust));

    const period = String(batch.period); // 'YYYY-MM'
    const accurateInvoice = await pgPool.query(
        `SELECT COUNT(*)::int AS jumlah_faktur, COALESCE(SUM(total_amount), 0) AS total_nilai
         FROM sales_invoice
         WHERE to_char(trans_date::date, 'YYYY-MM') = $1 AND customer_no = ANY($2)`,
        [period, custCodes],
    );
    const accurateReturn = await pgPool.query(
        `SELECT COUNT(*)::int AS jumlah_retur, COALESCE(SUM(total_amount), 0) AS total_retur
         FROM sales_return
         WHERE to_char(trans_date::date, 'YYYY-MM') = $1 AND customer_no = ANY($2)`,
        [period, custCodes],
    );
    const accurateCustomersInPeriod = await pgPool.query(
        `SELECT DISTINCT customer_no FROM sales_invoice WHERE to_char(trans_date::date, 'YYYY-MM') = $1`,
        [period],
    );
    const missingCustomers = accurateCustomersInPeriod.rows
        .map((r) => String(r.customer_no))
        .filter((c) => !custCodes.includes(c));

    const ourFaktur = Number(ours.jumlah_faktur || 0);
    const ourNilai = Number(ours.nilai_faktur || 0);
    const accFaktur = Number(accurateInvoice.rows[0].jumlah_faktur || 0);
    const accNilai = Number(accurateInvoice.rows[0].total_nilai || 0);
    const ourJumlahRetur = Number(ours.jumlah_retur || 0);
    const ourNilaiRetur = Number(ours.nilai_retur || 0);
    const accJumlahRetur = Number(accurateReturn.rows[0].jumlah_retur || 0);
    const accNilaiRetur = Number(accurateReturn.rows[0].total_retur || 0);

    const returSelisihNilai = Math.abs(ourNilaiRetur) - Math.abs(accNilaiRetur);

    const diff = {
        jumlah_faktur: { kita: ourFaktur, accurate: accFaktur, selisih: ourFaktur - accFaktur },
        nilai: { kita: ourNilai, accurate: accNilai, selisih: ourNilai - accNilai },
        retur: {
            jumlah: { kita: ourJumlahRetur, accurate: accJumlahRetur, selisih: ourJumlahRetur - accJumlahRetur },
            nilai: { kita: ourNilaiRetur, accurate: accNilaiRetur, selisih_abs: returSelisihNilai },
        },
        missing_customers: missingCustomers,
    };

    const fakturCocok = diff.jumlah_faktur.selisih === 0 && Math.abs(diff.nilai.selisih) <= TOLERANCE_RP;
    const returCocok = diff.retur.jumlah.selisih === 0 && Math.abs(returSelisihNilai) <= TOLERANCE_RP;
    const cocok = fakturCocok && returCocok && missingCustomers.length === 0;
    const stage = cocok ? "reconciled" : "reconcile_failed";

    await salesDb.execute({
        sql: "UPDATE import_batch SET stage = ?, diff_json = ? WHERE id = ?",
        args: [stage, JSON.stringify(diff), batchId],
    });

    console.log(`Batch #${batchId} periode ${period}:`);
    console.log(`  [Faktur] Jumlah — kita: ${ourFaktur}, Accurate: ${accFaktur}, selisih: ${diff.jumlah_faktur.selisih}`);
    console.log(`  [Faktur] Nilai bersih+pajak — kita: Rp${ourNilai.toLocaleString("id-ID")}, Accurate: Rp${accNilai.toLocaleString("id-ID")}, selisih: Rp${diff.nilai.selisih.toLocaleString("id-ID")}`);
    console.log(`  [Retur]  Jumlah — kita: ${ourJumlahRetur}, Accurate: ${accJumlahRetur}, selisih: ${diff.retur.jumlah.selisih}`);
    console.log(`  [Retur]  Nilai bersih+pajak (abs) — kita: Rp${Math.abs(ourNilaiRetur).toLocaleString("id-ID")}, Accurate: Rp${Math.abs(accNilaiRetur).toLocaleString("id-ID")}, selisih: Rp${returSelisihNilai.toLocaleString("id-ID")}`);
    if (missingCustomers.length) {
        console.log(`  Customer di Accurate tapi tidak ada di batch: ${missingCustomers.join(", ")}`);
    }
    console.log(`-> stage=${stage}`);
    if (stage === "reconciled") {
        console.log(`Lanjut: node scripts/publish-sales-history-batch.mjs --batch ${batchId}`);
    } else {
        console.log(`Selisih di luar toleransi Rp${TOLERANCE_RP} — investigasi sebelum publish.`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await salesDb.close();
    await pgPool.end();
});
