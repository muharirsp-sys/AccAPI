// scripts/reconcile-sales-history-batch.mjs
// Tujuan: bandingkan agregat batch (jumlah faktur, nilai) terhadap cache Accurate (Postgres
//   sales_invoice/sales_return, diisi lib/sync.ts) untuk periode yang sama.
// Catatan: cache Accurate TIDAK punya breakdown diskon/pajak/retur per baris (hanya total_amount
//   per faktur) -- reconciliation ini hanya menutup jumlah faktur + total nilai. Breakdown per
//   principal/produk/diskon/pajak untuk bulan percobaan tetap harus dicek manual vs laporan Accurate
//   (lihat runbook Task 7).
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
    if (batch.stage !== "validated") {
        console.error(`Batch #${batchId} belum 'validated' (stage saat ini: ${batch.stage}) — jalankan validate dulu.`);
        process.exit(1);
    }

    const ours = (await salesDb.execute({
        sql: `SELECT COUNT(DISTINCT referensi) AS jumlah_faktur, SUM(dpp) + SUM(ppn) AS nilai_bersih_pajak
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
        `SELECT COALESCE(SUM(total_amount), 0) AS total_retur
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
    const ourNilai = Number(ours.nilai_bersih_pajak || 0);
    const accFaktur = Number(accurateInvoice.rows[0].jumlah_faktur || 0);
    const accNilai = Number(accurateInvoice.rows[0].total_nilai || 0);
    const accRetur = Number(accurateReturn.rows[0].total_retur || 0);

    const diff = {
        jumlah_faktur: { kita: ourFaktur, accurate: accFaktur, selisih: ourFaktur - accFaktur },
        nilai: { kita: ourNilai, accurate: accNilai, selisih: ourNilai - accNilai },
        retur_accurate_saja: accRetur,
        missing_customers: missingCustomers,
    };

    const cocok = diff.jumlah_faktur.selisih === 0 && Math.abs(diff.nilai.selisih) <= TOLERANCE_RP && missingCustomers.length === 0;
    const stage = cocok ? "reconciled" : "reconcile_failed";

    await salesDb.execute({
        sql: "UPDATE import_batch SET stage = ?, diff_json = ? WHERE id = ?",
        args: [stage, JSON.stringify(diff), batchId],
    });

    console.log(`Batch #${batchId} periode ${period}:`);
    console.log(`  Jumlah faktur — kita: ${ourFaktur}, Accurate: ${accFaktur}, selisih: ${diff.jumlah_faktur.selisih}`);
    console.log(`  Nilai bersih+pajak — kita: Rp${ourNilai.toLocaleString("id-ID")}, Accurate: Rp${accNilai.toLocaleString("id-ID")}, selisih: Rp${diff.nilai.selisih.toLocaleString("id-ID")}`);
    console.log(`  (Retur di Accurate periode ini: Rp${accRetur.toLocaleString("id-ID")} — cek manual, belum ada retur di sisi kita)`);
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
