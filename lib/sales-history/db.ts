/*
 * Tujuan: Klien DB TERPISAH untuk Sales History (file SQLite sendiri, isolasi dari ERP utama).
 * Caller: app/api/sales-history/* route.
 * Dependensi: @libsql/client + drizzle (mirror lib/db.ts). DB: SALES_HISTORY_DATABASE_URL || file:sales-history-inv.db.
 * Main Functions: salesClient, salesDb, salesHistoryItem, customerMap, invoiceMap, ensureSalesHistorySchema.
 * Side Effects: Membuka/membuat sales-history.db dan menjalankan DDL idempotent + index saat schema dipastikan.
 *   Kolom item mencakup qty+satuan dari Data_Penjualan.
 * Catatan: 1 tabel flat denormalized (1 row/item) — tanpa join di jutaan baris, baca tercepat.
 *   ensureSalesHistorySchema() idempotent (CREATE IF NOT EXISTS) — dipanggil sekali via promise cache.
 */
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { sqliteTable, integer, text, real, index } from "drizzle-orm/sqlite-core";
import { mkdirSync } from "node:fs";

const databaseUrl = process.env.SALES_HISTORY_DATABASE_URL || "file:sales-history-inv.db";
const databaseFile = databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : null;
if (databaseFile?.startsWith("/")) {
    mkdirSync(databaseFile.replace(/\/[^/]*$/, ""), { recursive: true });
}

export const salesClient = createClient({ url: databaseUrl });
export const salesDb = drizzle(salesClient);

export const salesHistoryItem = sqliteTable(
    "sales_history_item",
    {
        id: integer("id").primaryKey({ autoIncrement: true }),
        referensi: text("referensi").notNull(),       // INV/2508/CS0003 — kunci cascade
        nomorFaktur: text("nomor_faktur").notNull(),
        tanggal: text("tanggal").notNull(),            // ISO yyyy-mm-dd
        customerNama: text("customer_nama").notNull(),
        customerNpwp: text("customer_npwp").notNull(),
        kodeObjek: text("kode_objek").notNull(),
        namaProduk: text("nama_produk").notNull(),
        qty: real("qty").notNull(),
        satuan: text("satuan").notNull(),
        hargaSatuan: real("harga_satuan").notNull(),
        hargaTotal: real("harga_total").notNull(),
        diskonRp: real("diskon_rp").notNull(),         // % dihitung saat render = diskonRp/hargaTotal
        dpp: real("dpp").notNull(),
        ppn: real("ppn").notNull(),
        sourceFile: text("source_file").notNull(),     // nama file asal -> re-import idempotent
        keterangan: text("keterangan").notNull().default(""), // kolom REM sumber — referensi PO/SO, format bebas per principal
    },
    (t) => [
        index("idx_shi_referensi").on(t.referensi),
        index("idx_shi_tanggal").on(t.tanggal),
        index("idx_shi_customer").on(t.customerNama),
        index("idx_shi_nama_produk").on(t.namaProduk),
        index("idx_shi_kode_objek").on(t.kodeObjek),
        index("idx_shi_source").on(t.sourceFile),
    ],
);

// Mapping customer (sumber otoritatif nama+alamat) — dari Mapping_Customer.xlsx.
export const customerMap = sqliteTable("customer_map", {
    kode: text("kode").primaryKey(),               // KODE0, mis. C-800004
    nama: text("nama").notNull(),
    alamat: text("alamat").notNull(),
    kota: text("kota").notNull(),
});

// Mapping faktur -> customer + principal — dari Data_Penjualan/*.xlsx (NO_NOTA = referensi e-Faktur).
export const invoiceMap = sqliteTable(
    "invoice_map",
    {
        referensi: text("referensi").primaryKey(),  // NO_NOTA = INV/2401/AB0001
        kodeCust: text("kode_cust").notNull(),
        principal: text("principal").notNull(),
        tanggal: text("tanggal").notNull(),          // ISO yyyy-mm-dd
    },
    (t) => [
        index("idx_im_principal").on(t.principal),
        index("idx_im_kode_cust").on(t.kodeCust),
        index("idx_im_principal_kode_cust").on(t.principal, t.kodeCust),
        index("idx_im_principal_tanggal").on(t.principal, t.tanggal),
        index("idx_im_kode_cust_tanggal").on(t.kodeCust, t.tanggal),
        index("idx_im_kode_cust_principal_tanggal").on(t.kodeCust, t.principal, t.tanggal),
        index("idx_im_tanggal_principal").on(t.tanggal, t.principal),
        index("idx_im_tanggal").on(t.tanggal),
    ],
);

let schemaReady: Promise<void> | null = null;
export function ensureSalesHistorySchema(): Promise<void> {
    if (!schemaReady) {
        schemaReady = (async () => {
            await salesClient.execute("PRAGMA journal_mode = TRUNCATE");
            await salesClient.execute(`CREATE TABLE IF NOT EXISTS sales_history_item (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                referensi TEXT NOT NULL,
                nomor_faktur TEXT NOT NULL,
                tanggal TEXT NOT NULL,
                customer_nama TEXT NOT NULL,
                customer_npwp TEXT NOT NULL,
                kode_objek TEXT NOT NULL,
                nama_produk TEXT NOT NULL,
                qty REAL NOT NULL,
                satuan TEXT NOT NULL DEFAULT '',
                harga_satuan REAL NOT NULL,
                harga_total REAL NOT NULL,
                diskon_rp REAL NOT NULL,
                dpp REAL NOT NULL,
                ppn REAL NOT NULL,
                source_file TEXT NOT NULL
            )`);
            const itemColumns = await salesClient.execute("PRAGMA table_info(sales_history_item)");
            if (!itemColumns.rows.some((row) => String(row.name || "") === "satuan")) {
                await salesClient.execute("ALTER TABLE sales_history_item ADD COLUMN satuan TEXT NOT NULL DEFAULT ''");
            }
            if (!itemColumns.rows.some((row) => String(row.name || "") === "keterangan")) {
                await salesClient.execute("ALTER TABLE sales_history_item ADD COLUMN keterangan TEXT NOT NULL DEFAULT ''");
            }
            await salesClient.execute(`CREATE INDEX IF NOT EXISTS idx_shi_referensi ON sales_history_item(referensi)`);
            await salesClient.execute(`CREATE INDEX IF NOT EXISTS idx_shi_tanggal ON sales_history_item(tanggal)`);
            await salesClient.execute(`CREATE INDEX IF NOT EXISTS idx_shi_customer ON sales_history_item(customer_nama)`);
            await salesClient.execute(`CREATE INDEX IF NOT EXISTS idx_shi_nama_produk ON sales_history_item(nama_produk)`);
            await salesClient.execute(`CREATE INDEX IF NOT EXISTS idx_shi_kode_objek ON sales_history_item(kode_objek)`);
            await salesClient.execute(`CREATE INDEX IF NOT EXISTS idx_shi_source ON sales_history_item(source_file)`);
            await salesClient.execute(`CREATE TABLE IF NOT EXISTS customer_map (
                kode TEXT PRIMARY KEY,
                nama TEXT NOT NULL,
                alamat TEXT NOT NULL,
                kota TEXT NOT NULL
            )`);
            await salesClient.execute(`CREATE INDEX IF NOT EXISTS idx_cm_nama ON customer_map(nama COLLATE NOCASE)`);
            await salesClient.execute(`CREATE TABLE IF NOT EXISTS invoice_map (
                referensi TEXT PRIMARY KEY,
                kode_cust TEXT NOT NULL,
                principal TEXT NOT NULL,
                tanggal TEXT NOT NULL
            )`);
            await salesClient.execute(`CREATE INDEX IF NOT EXISTS idx_im_principal ON invoice_map(principal)`);
            await salesClient.execute(`CREATE INDEX IF NOT EXISTS idx_im_kode_cust ON invoice_map(kode_cust)`);
            await salesClient.execute(`CREATE INDEX IF NOT EXISTS idx_im_principal_kode_cust ON invoice_map(principal, kode_cust)`);
            await salesClient.execute(`CREATE INDEX IF NOT EXISTS idx_im_principal_tanggal ON invoice_map(principal, tanggal DESC)`);
            await salesClient.execute(`CREATE INDEX IF NOT EXISTS idx_im_kode_cust_tanggal ON invoice_map(kode_cust, tanggal DESC)`);
            await salesClient.execute(`CREATE INDEX IF NOT EXISTS idx_im_kode_cust_principal_tanggal ON invoice_map(kode_cust, principal, tanggal DESC)`);
            await salesClient.execute(`CREATE INDEX IF NOT EXISTS idx_im_tanggal_principal ON invoice_map(tanggal DESC, principal)`);
            await salesClient.execute(`CREATE INDEX IF NOT EXISTS idx_im_tanggal ON invoice_map(tanggal DESC)`);
        })();
    }
    return schemaReady;
}
