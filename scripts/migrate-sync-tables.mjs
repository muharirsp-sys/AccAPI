// Audit F3: tabel cache sync baru + retype kolom uang (hanya saat tabel kosong).
// Jalankan: node scripts/migrate-sync-tables.mjs  (idempotent)
import { createClient } from "@libsql/client";

const client = createClient({ url: process.env.DATABASE_URL || "file:sqlite.db" });

await client.execute(`CREATE TABLE IF NOT EXISTS sales_invoice (
    id INTEGER PRIMARY KEY,
    number TEXT, trans_date TEXT, customer_no TEXT, customer_name TEXT,
    total_amount REAL, outstanding REAL, status TEXT,
    raw_data TEXT, last_update TEXT
)`);
await client.execute("CREATE INDEX IF NOT EXISTS idx_sales_invoice_trans_date ON sales_invoice(trans_date)");
await client.execute("CREATE INDEX IF NOT EXISTS idx_sales_invoice_customer_no ON sales_invoice(customer_no)");

await client.execute(`CREATE TABLE IF NOT EXISTS sales_return (
    id INTEGER PRIMARY KEY,
    number TEXT, trans_date TEXT, customer_no TEXT, customer_name TEXT,
    total_amount REAL, status TEXT,
    raw_data TEXT, last_update TEXT
)`);
await client.execute("CREATE INDEX IF NOT EXISTS idx_sales_return_trans_date ON sales_return(trans_date)");
await client.execute("CREATE INDEX IF NOT EXISTS idx_sales_return_customer_no ON sales_return(customer_no)");
console.log("OK: sales_invoice + sales_return + index");

// Retype unitPrice/balance INTEGER -> REAL. SQLite tak bisa ALTER type; tabel kosong -> recreate.
// Guard keras: hanya jika 0 baris (kalau sudah berisi, biarkan — jangan pernah drop data).
async function retypeIfEmpty(table, ddl) {
    const n = (await client.execute(`SELECT COUNT(*) c FROM ${table}`)).rows[0].c;
    if (Number(n) > 0) { console.log(`SKIP retype ${table}: berisi ${n} baris`); return; }
    await client.execute(`DROP TABLE ${table}`);
    await client.execute(ddl);
    console.log(`OK: ${table} dibuat ulang (REAL)`);
}
await retypeIfEmpty("item", `CREATE TABLE item (
    id INTEGER PRIMARY KEY, no TEXT NOT NULL, name TEXT NOT NULL,
    itemType TEXT, unitPrice REAL, raw_data TEXT, last_update TEXT
)`);
await retypeIfEmpty("customer", `CREATE TABLE customer (
    id INTEGER PRIMARY KEY, customerNo TEXT NOT NULL, name TEXT NOT NULL,
    balance REAL, raw_data TEXT, last_update TEXT
)`);
console.log("Selesai.");
client.close();
