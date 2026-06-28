/*
 * Tujuan: Bulk build Sales History DB dengan strategi latest-wins, tanpa secondary index saat load.
 * Caller: dijalankan manual untuk rebuild data besar History Penjualan dari Data_Penjualan/**.xlsx.
 * Dependensi: @libsql/client + xlsx (SheetJS). Input: Mapping_Customer.xlsx dan Data_Penjualan/**.xlsx.
 * Main Functions: main, prepareFinalDb, loadCustomers, loadSalesLatestWins, createFinalIndexes, validateFinalDb.
 * Side Effects: Membuat DB final baru; hanya import referensi INV/; membaca file Excel lokal; index dibuat setelah load selesai.
 * Catatan: file diproses dari mtime terbaru ke terlama. Referensi yang sudah muncul di file baru dilewati di file lama,
 *   sehingga file UPDATE/FIX terbaru menang tanpa menulis seluruh duplikat ke raw staging.
 *
 * Jalankan:
 *   node scripts/build-sales-history-staging.mjs
 *   SALES_HISTORY_IMPORT_YEAR=2025 node scripts/build-sales-history-staging.mjs
 */
import { createClient } from "@libsql/client";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const RUN_ID = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
const BUILD_DIR = process.env.SALES_HISTORY_BUILD_DIR || "runtime/sales-history-build";
const FINAL_DB_PATH = process.env.SALES_HISTORY_FINAL_DB_PATH || join(BUILD_DIR, `sales-history-inv-final-${RUN_ID}.db`);
const FINAL_DB_URL = process.env.SALES_HISTORY_DATABASE_URL || `file:${FINAL_DB_PATH}`;
const MAPPING_FILE = "Mapping_Customer.xlsx";
const SALES_DIR = "Data_Penjualan";
const ONLY_YEAR = clean(process.env.SALES_HISTORY_IMPORT_YEAR);
const ONLY_FILE = clean(process.env.SALES_HISTORY_IMPORT_FILE).toLowerCase();
const BATCH_SIZE = Math.max(Number(process.env.SALES_HISTORY_BUILD_BATCH) || 2000, 100);

if (!existsSync(BUILD_DIR)) mkdirSync(BUILD_DIR, { recursive: true });

const db = createClient({ url: FINAL_DB_URL });
const seenRefs = new Set();

function clean(value) {
    return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

function stripCode(name) {
    return clean(name).replace(/\s*\{[^}]*\}\s*$/, "").trim();
}

function isInvoiceRef(ref) {
    return clean(ref).toUpperCase().startsWith("INV/");
}

function num(value) {
    const n = Number(String(value ?? "").replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : 0;
}

function toIso(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        const ms = Math.round((value - 25569) * 86400 * 1000);
        const date = new Date(ms);
        return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
    }
    const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(clean(value));
    if (match) return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
    return "";
}

function colIndex(header, ...names) {
    const normalized = header.map((h) => clean(h).toUpperCase());
    for (const name of names) {
        const i = normalized.indexOf(name.toUpperCase());
        if (i >= 0) return i;
    }
    return -1;
}

function listXlsx(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        if (name.startsWith("~$")) continue;
        const path = join(dir, name);
        const stat = statSync(path);
        if (stat.isDirectory()) out.push(...listXlsx(path));
        else if (name.toLowerCase().endsWith(".xlsx")) out.push({ path, mtime: stat.mtimeMs });
    }
    return out;
}

async function exec(sql, args = []) {
    return db.execute({ sql, args });
}

async function batch(statements) {
    for (let i = 0; i < statements.length; i += BATCH_SIZE) {
        await db.batch(statements.slice(i, i + BATCH_SIZE), "write");
    }
}

async function prepareFinalDb() {
    await exec("PRAGMA journal_mode = OFF");
    await exec("PRAGMA synchronous = OFF");
    await exec("PRAGMA temp_store = MEMORY");
    await exec("PRAGMA locking_mode = EXCLUSIVE");
    await exec("DROP TABLE IF EXISTS sales_history_item");
    await exec("DROP TABLE IF EXISTS invoice_map");
    await exec("DROP TABLE IF EXISTS customer_map");
    await exec(`CREATE TABLE customer_map (
        kode TEXT PRIMARY KEY,
        nama TEXT NOT NULL,
        alamat TEXT NOT NULL,
        kota TEXT NOT NULL
    )`);
    await exec(`CREATE TABLE invoice_map (
        referensi TEXT PRIMARY KEY,
        kode_cust TEXT NOT NULL,
        principal TEXT NOT NULL,
        tanggal TEXT NOT NULL
    )`);
    await exec(`CREATE TABLE sales_history_item (
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
}

async function loadCustomers() {
    const workbook = XLSX.readFile(MAPPING_FILE);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    const header = rows[0] || [];
    const iKode = colIndex(header, "KODE0", "KODE", "CUSTOMERNO", "NO");
    const iNama = colIndex(header, "NAME", "NAMA");
    const iAlamat = colIndex(header, "ADDRESS", "ALAMAT");
    const iKota = colIndex(header, "KOTANAMA", "KOTA");
    if (iKode < 0 || iNama < 0) throw new Error("Mapping_Customer.xlsx: kolom KODE0/NAME tidak ditemukan");

    const statements = [];
    const seenCustomers = new Set();
    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const kode = clean(row[iKode]);
        if (!kode || seenCustomers.has(kode)) continue;
        seenCustomers.add(kode);
        statements.push({
            sql: "INSERT INTO customer_map (kode, nama, alamat, kota) VALUES (?,?,?,?)",
            args: [
                kode,
                stripCode(row[iNama]),
                clean(row[iAlamat]),
                clean(iKota >= 0 ? row[iKota] : ""),
            ],
        });
    }
    await batch(statements);
    log(`customer_map: ${statements.length} customer.`);
}

function selectedSalesFiles() {
    let files = listXlsx(SALES_DIR).sort((a, b) => b.mtime - a.mtime);
    if (ONLY_YEAR) files = files.filter((f) => f.path.replace(/\\/g, "/").includes(`Data_Penjualan/${ONLY_YEAR}/`));
    if (ONLY_FILE) files = files.filter((f) => f.path.toLowerCase().includes(ONLY_FILE));
    if (files.length === 0) throw new Error("Tidak ada file .xlsx yang cocok dengan filter import.");
    return files;
}

async function loadSalesLatestWins() {
    const files = selectedSalesFiles();
    let totalInvoices = 0;
    let totalItems = 0;
    let importedFiles = 0;
    let skippedKnownRefs = 0;

    for (const { path } of files) {
        const sourceFile = path.replace(/.*Data_Penjualan[\\/]/, "");
        let workbook;
        try {
            workbook = XLSX.readFile(path);
        } catch (error) {
            console.warn(`SKIP (gagal baca): ${path} - ${error.message}`);
            continue;
        }

        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
        const header = rows[0] || [];
        const iNota = colIndex(header, "NO_NOTA", "NONOTA", "NO NOTA");
        const iKode = colIndex(header, "KODE_CUST", "KODECUST");
        const iPrin = colIndex(header, "PRINCIPAL", "PRINCIPLE");
        const iTgl = colIndex(header, "TANGGAL", "TGL");
        const iCustomer = colIndex(header, "CUSTOMER", "NAMA CUSTOMER", "Nama Customer");
        const iNpwp = colIndex(header, "NPWP", "KTP / NPWP");
        const iKodeBarang = colIndex(header, "KODE_BARANG", "KODE BARANG", "Kode Barang");
        const iNamaBarang = colIndex(header, "NAMA_BARANG", "NAMA BARANG", "Nama Barang");
        const iQty = colIndex(header, "QTY", "Qty");
        const iSatuan = colIndex(header, "SATUAN", "Satuan", "UNIT", "Unit");
        const iHarga = colIndex(header, "HARGA", "Harga");
        const iPotongan = colIndex(header, "POTONGAN", "Nilai Disc");
        const iNilaiJual = colIndex(header, "NILAI_JUAL", "Nilai Bruto");
        const iDpp = colIndex(header, "DPP");
        const iPpn = colIndex(header, "NILAI_PAJAK", "Nilai Pajak");
        const required = [iNota, iKode, iPrin, iCustomer, iKodeBarang, iNamaBarang, iQty, iHarga];
        if (required.some((i) => i < 0)) {
            console.warn(`SKIP (kolom kurang): ${path}`);
            continue;
        }

        const invoiceRows = new Map();
        const itemStatements = [];
        const knownInFile = new Set();
        for (let r = 1; r < rows.length; r++) {
            const row = rows[r];
            const ref = clean(row[iNota]);
            if (!ref || !isInvoiceRef(ref)) continue;
            if (seenRefs.has(ref)) {
                if (!knownInFile.has(ref)) {
                    knownInFile.add(ref);
                    skippedKnownRefs += 1;
                }
                continue;
            }
            const tanggal = toIso(iTgl >= 0 ? row[iTgl] : "");
            if (!invoiceRows.has(ref)) {
                invoiceRows.set(ref, {
                    sql: "INSERT INTO invoice_map (referensi, kode_cust, principal, tanggal) VALUES (?,?,?,?)",
                    args: [ref, clean(row[iKode]), clean(row[iPrin]), tanggal],
                });
            }
            const qty = num(row[iQty]);
            const hargaSatuan = num(row[iHarga]);
            const hargaTotal = iNilaiJual >= 0 ? num(row[iNilaiJual]) : qty * hargaSatuan;
            itemStatements.push({
                sql: `INSERT INTO sales_history_item (
                    referensi, nomor_faktur, tanggal, customer_nama, customer_npwp,
                    kode_objek, nama_produk, qty, satuan, harga_satuan, harga_total,
                    diskon_rp, dpp, ppn, source_file
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                args: [
                    ref,
                    ref,
                    tanggal,
                    clean(row[iCustomer]),
                    clean(iNpwp >= 0 ? row[iNpwp] : ""),
                    clean(row[iKodeBarang]),
                    clean(row[iNamaBarang]),
                    qty,
                    clean(iSatuan >= 0 ? row[iSatuan] : ""),
                    hargaSatuan,
                    hargaTotal,
                    iPotongan >= 0 ? num(row[iPotongan]) : 0,
                    iDpp >= 0 ? num(row[iDpp]) : hargaTotal,
                    iPpn >= 0 ? num(row[iPpn]) : 0,
                    sourceFile,
                ],
            });
        }

        const invoiceStatements = [...invoiceRows.values()];
        if (invoiceStatements.length === 0) {
            log(`${sourceFile}: 0 faktur baru.`);
            continue;
        }
        await batch(invoiceStatements);
        await batch(itemStatements);
        for (const ref of invoiceRows.keys()) seenRefs.add(ref);
        importedFiles += 1;
        totalInvoices += invoiceStatements.length;
        totalItems += itemStatements.length;
        log(`${sourceFile}: ${invoiceStatements.length} faktur baru, ${itemStatements.length} item.`);
    }

    log(`files_with_new_inv: ${importedFiles}/${files.length} files.`);
    log(`skipped_known_refs: ${skippedKnownRefs}`);
    log(`invoice_map: ${totalInvoices} rows.`);
    log(`sales_history_item: ${totalItems} rows.`);
    if (totalInvoices === 0) throw new Error("Tidak ada referensi INV/ yang berhasil di-load. Cek filter/file/header.");
    return { files: files.length, importedFiles, totalInvoices, totalItems, skippedKnownRefs };
}

async function createFinalIndexes() {
    await exec("CREATE INDEX idx_shi_referensi ON sales_history_item(referensi)");
    await exec("CREATE INDEX idx_shi_tanggal ON sales_history_item(tanggal)");
    await exec("CREATE INDEX idx_shi_customer ON sales_history_item(customer_nama)");
    await exec("CREATE INDEX idx_shi_nama_produk ON sales_history_item(nama_produk)");
    await exec("CREATE INDEX idx_shi_kode_objek ON sales_history_item(kode_objek)");
    await exec("CREATE INDEX idx_shi_source ON sales_history_item(source_file)");
    await exec("CREATE INDEX idx_im_principal ON invoice_map(principal)");
    await exec("CREATE INDEX idx_im_kode_cust ON invoice_map(kode_cust)");
    await exec("CREATE INDEX idx_im_principal_kode_cust ON invoice_map(principal, kode_cust)");
    await exec("CREATE INDEX idx_im_principal_tanggal ON invoice_map(principal, tanggal DESC)");
    await exec("CREATE INDEX idx_im_kode_cust_tanggal ON invoice_map(kode_cust, tanggal DESC)");
    await exec("CREATE INDEX idx_im_kode_cust_principal_tanggal ON invoice_map(kode_cust, principal, tanggal DESC)");
    await exec("CREATE INDEX idx_im_tanggal_principal ON invoice_map(tanggal DESC, principal)");
    await exec("CREATE INDEX idx_im_tanggal ON invoice_map(tanggal DESC)");
    await exec("CREATE INDEX idx_cm_nama ON customer_map(nama COLLATE NOCASE)");
}

async function validateFinalDb() {
    const check = await exec("PRAGMA integrity_check");
    const result = String(check.rows[0]?.integrity_check || check.rows[0]?.["integrity_check"] || "");
    if (result !== "ok") throw new Error(`Final DB integrity_check gagal: ${result}`);
    const counts = await exec(`SELECT
        (SELECT COUNT(*) FROM customer_map) AS customers,
        (SELECT COUNT(*) FROM invoice_map) AS invoices,
        (SELECT COUNT(*) FROM sales_history_item) AS items,
        (SELECT COUNT(*) FROM sales_history_item WHERE satuan <> '') AS items_with_satuan,
        (SELECT COUNT(*) FROM sales_history_item WHERE referensi NOT LIKE 'INV/%') AS non_inv_items,
        (SELECT COUNT(*) FROM invoice_map im LEFT JOIN sales_history_item shi ON shi.referensi = im.referensi WHERE shi.referensi IS NULL) AS invoices_without_items`);
    log(`final_counts: ${JSON.stringify(counts.rows[0])}`);
}

async function main() {
    log(`final_db: ${resolve(FINAL_DB_PATH)}`);
    await prepareFinalDb();
    await loadCustomers();
    const totals = await loadSalesLatestWins();
    log(`load_summary: ${JSON.stringify(totals)}`);
    log("create final indexes...");
    await createFinalIndexes();
    await validateFinalDb();
    log("Selesai.");
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => db.close());
