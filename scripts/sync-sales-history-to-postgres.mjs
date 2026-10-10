// scripts/sync-sales-history-to-postgres.mjs
// Tujuan: mirror baris published=1 dari sales-history-inv.db (SQLite, isolasi dari ERP utama - lihat
//   lib/sales-history/db.ts) ke tabel sales_history_export di Postgres (db/schema.ts) supaya Metabase
//   bisa membacanya. Metabase HANYA connect ke Postgres (lihat docker-compose.metabase.yml +
//   db/metabase_readonly.sql) - tidak bisa baca file SQLite ini langsung.
// Catatan: TIDAK live/real-time. Jalankan manual (atau cron) setiap kali ada batch baru yang di-publish.
//   customer_npwp SENGAJA tidak dimirror - tidak perlu untuk BI, tidak perlu tersebar ke Metabase.
//   Idempotent: upsert per item_id (ON CONFLICT DO UPDATE). TIDAK menghapus baris di Postgres kalau
//   baris sumbernya kembali jadi published=0 di SQLite - saat ini tidak ada jalur "unpublish" di
//   pipeline manapun (lihat scripts/publish-sales-history-batch.mjs), jadi ini bukan gap aktif, hanya
//   dicatat sebagai batasan kalau suatu saat ada fitur unpublish.
// Jalankan: node scripts/sync-sales-history-to-postgres.mjs
import { createClient } from "@libsql/client";
import { Pool } from "pg";

const SALES_DB_URL = process.env.SALES_HISTORY_DATABASE_URL || "file:sales-history-inv.db";
const salesDb = createClient({ url: SALES_DB_URL });
const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });

const CHUNK_SIZE = Math.max(Number(process.env.SALES_HISTORY_SYNC_CHUNK) || 500, 50);

const COLUMNS = [
    "item_id", "referensi", "jenis_transaksi", "tanggal", "principal", "kode_cust",
    "customer_nama", "kode_objek", "nama_produk", "qty", "satuan", "harga_satuan",
    "harga_total", "diskon_rp", "dpp", "ppn", "batch_id",
];

function buildUpsertQuery(rows) {
    const valuesSql = rows
        .map((_, i) => `(${COLUMNS.map((__, j) => `$${i * COLUMNS.length + j + 1}`).join(", ")})`)
        .join(", ");
    const args = rows.flatMap((r) => COLUMNS.map((c) => r[c]));
    const updateSet = COLUMNS.filter((c) => c !== "item_id").map((c) => `${c} = EXCLUDED.${c}`).join(", ");
    return {
        text: `INSERT INTO sales_history_export (${COLUMNS.join(", ")})
               VALUES ${valuesSql}
               ON CONFLICT (item_id) DO UPDATE SET ${updateSet}, synced_at = now()`,
        values: args,
    };
}

async function main() {
    const rows = (await salesDb.execute(`
        SELECT shi.id AS item_id, shi.referensi, shi.jenis_transaksi, shi.tanggal,
               CASE WHEN im.principal_norm != '' THEN im.principal_norm ELSE im.principal END AS principal,
               shi.customer_nama AS kode_cust,
               COALESCE(cm.nama, shi.customer_nama) AS customer_nama,
               shi.kode_objek, shi.nama_produk, shi.qty, shi.satuan, shi.harga_satuan,
               shi.harga_total, shi.diskon_rp, shi.dpp, shi.ppn, shi.batch_id
        FROM sales_history_item shi
        JOIN invoice_map im ON im.referensi = shi.referensi
        LEFT JOIN customer_map cm ON cm.kode = shi.customer_nama
        WHERE shi.published = 1
    `)).rows;

    console.log(`Sinkron ${rows.length} baris published ke Postgres sales_history_export...`);
    let synced = 0;
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
        const chunk = rows.slice(i, i + CHUNK_SIZE);
        const { text, values } = buildUpsertQuery(chunk);
        await pgPool.query(text, values);
        synced += chunk.length;
        if (synced % 5000 === 0 || synced === rows.length) console.log(`  ${synced}/${rows.length}`);
    }
    console.log(`Selesai. ${synced} baris ter-sinkron ke sales_history_export.`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await salesDb.close();
    await pgPool.end();
});
