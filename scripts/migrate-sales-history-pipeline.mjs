// scripts/migrate-sales-history-pipeline.mjs
// Tujuan: tambah tabel batch-tracking + raw capture + kolom staging/publish untuk pipeline
//   Raw -> Staging/Mapping -> Validated -> Reconciled -> Published di sales-history-inv.db.
// Jalankan: node scripts/migrate-sales-history-pipeline.mjs  (idempotent)
import { createClient } from "@libsql/client";

const DB_URL = process.env.SALES_HISTORY_DATABASE_URL || "file:sales-history-inv.db";
const db = createClient({ url: DB_URL });

async function addColumnIfMissing(table, column, ddl) {
    const info = await db.execute(`PRAGMA table_info(${table})`);
    if (!info.rows.some((row) => String(row.name || "") === column)) {
        await db.execute(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
        console.log(`OK: ${table}.${column} ditambahkan`);
    } else {
        console.log(`SKIP: ${table}.${column} sudah ada`);
    }
}

async function main() {
    await db.execute(`CREATE TABLE IF NOT EXISTS import_batch (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        period TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'raw',
        imported_by TEXT NOT NULL DEFAULT '',
        imported_at TEXT NOT NULL,
        row_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        fail_count INTEGER NOT NULL DEFAULT 0,
        diff_json TEXT NOT NULL DEFAULT '{}',
        notes TEXT NOT NULL DEFAULT ''
    )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_import_batch_period ON import_batch(period)`);
    console.log("OK: import_batch");

    await db.execute(`CREATE TABLE IF NOT EXISTS sales_history_raw_item (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id INTEGER NOT NULL,
        source_file TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        raw_json TEXT NOT NULL
    )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_raw_item_batch ON sales_history_raw_item(batch_id)`);
    console.log("OK: sales_history_raw_item");

    await db.execute(`CREATE TABLE IF NOT EXISTS principal_alias (
        alias TEXT PRIMARY KEY,
        principal TEXT NOT NULL
    )`);
    console.log("OK: principal_alias (kosong — isi manual bila ada alias principal yang diketahui)");

    // PENTING -- grandfathering data lama: kolom `published` di bawah ini default 0 untuk SEMUA baris
    // yang sudah ada (batch_id=0 dari sebelum pipeline ini dibuat). Begitu filter published=1 di
    // lib/sales-history/service.ts di-deploy, seluruh data lama itu langsung HILANG dari dashboard
    // Sales History -- bukan bug, tapi juga TIDAK otomatis diperbaiki oleh script manapun (sengaja,
    // supaya publish selalu lewat scripts/publish-sales-history-batch.mjs atau keputusan sadar).
    // Contoh (jalankan manual, sekali, setelah menilai data lama sudah cukup dipercaya):
    // UPDATE invoice_map SET published = 1 WHERE batch_id = 0;
    // UPDATE sales_history_item SET published = 1 WHERE batch_id = 0;
    await addColumnIfMissing("sales_history_item", "batch_id", "batch_id INTEGER NOT NULL DEFAULT 0");
    await addColumnIfMissing("sales_history_item", "flags", "flags TEXT NOT NULL DEFAULT ''");
    await addColumnIfMissing("sales_history_item", "published", "published INTEGER NOT NULL DEFAULT 0");
    // 'PENJUALAN' (referensi INV/) atau 'RETUR' (referensi RJN/ atau SRT/ -- keduanya sama secara bisnis:
    // Retur Penjualan). Data lama (batch_id=0) tidak punya baris retur sama sekali (dulu di-skip saat
    // impor), jadi default 'PENJUALAN' untuk baris lama aman -- bukan klaim bahwa baris lama tidak
    // pernah retur, hanya bahwa retur lama tidak pernah masuk sama sekali ke tabel ini.
    await addColumnIfMissing("sales_history_item", "jenis_transaksi", "jenis_transaksi TEXT NOT NULL DEFAULT 'PENJUALAN'");
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_shi_batch ON sales_history_item(batch_id)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_shi_published ON sales_history_item(published)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_shi_jenis ON sales_history_item(jenis_transaksi)`);

    // Sama seperti sales_history_item di atas: invoice_map.published juga default 0 untuk baris lama
    // (batch_id=0) -- perlu UPDATE manual yang sama untuk grandfathering.
    await addColumnIfMissing("invoice_map", "batch_id", "batch_id INTEGER NOT NULL DEFAULT 0");
    await addColumnIfMissing("invoice_map", "principal_norm", "principal_norm TEXT NOT NULL DEFAULT ''");
    await addColumnIfMissing("invoice_map", "published", "published INTEGER NOT NULL DEFAULT 0");
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_im_batch ON invoice_map(batch_id)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_im_published ON invoice_map(published)`);

    console.log("Selesai.");
}

main().then(() => db.close());
