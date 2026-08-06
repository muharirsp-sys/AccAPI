// scripts/import-sales-history-batch.mjs
// Tujuan: import SATU file Data_Penjualan (satu bulan) melalui tahap Raw -> Staging/Mapping,
//   ditandai satu batch_id. Validasi/rekonsiliasi/publish adalah script terpisah (lihat Task 3-5).
// Jalankan:
//   node scripts/import-sales-history-batch.mjs --file "Data_Penjualan/2025/06 PENJUALAN JUNI 2025.xlsx" --period 2025-06
import { createClient } from "@libsql/client";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const DB_URL = process.env.SALES_HISTORY_DATABASE_URL || "file:sales-history-inv.db";
const db = createClient({ url: DB_URL });

const args = process.argv.slice(2);
const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : "";
};
const FILE = flag("file");
const PERIOD = flag("period"); // 'YYYY-MM'
if (!FILE || !/^\d{4}-\d{2}$/.test(PERIOD)) {
    console.error("Wajib: --file <path.xlsx> --period YYYY-MM");
    process.exit(1);
}

const clean = (v) => String(v ?? "").replace(/[\r\n]+/g, " ").trim();
const stripCode = (name) => clean(name).replace(/\s*\{[^}]*\}\s*$/, "").trim();
const isInvoiceRef = (ref) => clean(ref).toUpperCase().startsWith("INV/");
const num = (v) => {
    const n = Number(String(v ?? "").replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : 0;
};
function toIso(v) {
    if (typeof v === "number" && Number.isFinite(v)) {
        const ms = Math.round((v - 25569) * 86400 * 1000);
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
    }
    const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(clean(v));
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
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

async function mapPrincipal(rawPrincipal) {
    const alias = clean(rawPrincipal).toUpperCase();
    const row = await db.execute({ sql: "SELECT principal FROM principal_alias WHERE alias = ?", args: [alias] });
    return row.rows[0]?.principal ? String(row.rows[0].principal) : alias;
}

async function main() {
    const wb = XLSX.readFile(FILE);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
    const header = rows[0] || [];
    const dataRows = rows.slice(1);

    const now = new Date().toISOString();
    const batchInsert = await db.execute({
        sql: "INSERT INTO import_batch (source, period, stage, imported_at, row_count) VALUES (?, ?, 'raw', ?, ?)",
        args: [FILE, PERIOD, now, dataRows.length],
    });
    const batchId = Number(batchInsert.lastInsertRowid);
    console.log(`Batch #${batchId} dibuat: ${FILE} (${dataRows.length} baris)`);

    // --- Stage: Raw (disimpan utuh, tidak diubah) ---
    for (let i = 0; i < dataRows.length; i++) {
        await db.execute({
            sql: "INSERT INTO sales_history_raw_item (batch_id, source_file, row_index, raw_json) VALUES (?, ?, ?, ?)",
            args: [batchId, FILE, i, JSON.stringify(dataRows[i])],
        });
    }
    await db.execute({ sql: "UPDATE import_batch SET stage = 'staging' WHERE id = ?", args: [batchId] });
    console.log(`Batch #${batchId}: raw capture selesai (${dataRows.length} baris ke sales_history_raw_item)`);

    // --- Stage: Staging (clean) + Mapping (principal_norm) ---
    const idx = {
        ref: colIndex(header, "NO_NOTA", "REFERENSI"),
        tanggal: colIndex(header, "TANGGAL"),
        custKode: colIndex(header, "KODE_CUST", "KODE CUST"),
        principal: colIndex(header, "PRINCIPAL"),
        produk: colIndex(header, "NAMA_BARANG", "NAMA_PRODUK", "PRODUK"),
        qty: colIndex(header, "QTY"),
        satuan: colIndex(header, "SATUAN"),
        hargaSatuan: colIndex(header, "HARGA", "HARGA_SATUAN", "HARGA SATUAN"),
        hargaTotal: colIndex(header, "NILAI_JUAL", "HARGA_TOTAL", "HARGA TOTAL"),
        diskonRp: colIndex(header, "POTONGAN", "DISKON_RP", "DISKON"),
        dpp: colIndex(header, "DPP"),
        ppn: colIndex(header, "NILAI_PAJAK", "PPN"),
        npwp: colIndex(header, "NPWP"),
        kodeObjek: colIndex(header, "KODE_BARANG", "KODE_OBJEK", "KODE OBJEK"),
    };

    // Nama kolom asli Accurate (dikonfirmasi dari Data_Penjualan/2022-2025 xlsx nyata, 2026-08-06):
    // NAMA_BARANG (bukan NAMA_PRODUK), HARGA (bukan HARGA_SATUAN), NILAI_JUAL (bukan HARGA_TOTAL),
    // POTONGAN (bukan DISKON_RP), NILAI_PAJAK (bukan PPN), KODE_BARANG (bukan KODE_OBJEK).
    // Alias lama dipertahankan sebagai fallback kalau ada file dengan layout berbeda.
    const requiredCols = {
        ref: idx.ref, tanggal: idx.tanggal, principal: idx.principal, custKode: idx.custKode,
        produk: idx.produk, kodeObjek: idx.kodeObjek,
    };
    const missingCols = Object.entries(requiredCols)
        .filter(([, i]) => i < 0)
        .map(([name]) => name);
    if (missingCols.length > 0) {
        throw new Error(
            `Kolom wajib tidak ditemukan di header: ${missingCols.join(", ")}. Header aktual: ${JSON.stringify(header)}`,
        );
    }

    let success = 0;
    let failed = 0;
    const seenInvoiceRefs = new Set();
    for (const row of dataRows) {
        const referensi = clean(row[idx.ref]);
        if (!isInvoiceRef(referensi)) continue; // RJN/SRT di-skip, konsisten dgn pipeline lama

        const tanggal = toIso(row[idx.tanggal]);
        const principalRaw = clean(row[idx.principal]);
        const principalNorm = await mapPrincipal(principalRaw);
        const kodeCust = stripCode(row[idx.custKode]);

        if (!tanggal || !kodeCust || !principalNorm) {
            failed++;
            continue;
        }

        if (!seenInvoiceRefs.has(referensi)) {
            seenInvoiceRefs.add(referensi);
            await db.execute({
                sql: `INSERT INTO invoice_map (referensi, kode_cust, principal, tanggal, batch_id, principal_norm, published)
                      VALUES (?, ?, ?, ?, ?, ?, 0)
                      ON CONFLICT(referensi) DO UPDATE SET kode_cust=excluded.kode_cust, principal=excluded.principal,
                        tanggal=excluded.tanggal, batch_id=excluded.batch_id, principal_norm=excluded.principal_norm`,
                args: [referensi, kodeCust, principalRaw, tanggal, batchId, principalNorm],
            });
        }

        await db.execute({
            sql: `INSERT INTO sales_history_item
                  (referensi, nomor_faktur, tanggal, customer_nama, customer_npwp, kode_objek, nama_produk,
                   qty, satuan, harga_satuan, harga_total, diskon_rp, dpp, ppn, source_file, batch_id, flags, published)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0)`,
            args: [
                referensi, referensi, tanggal, kodeCust, clean(row[idx.npwp]), clean(row[idx.kodeObjek]),
                stripCode(row[idx.produk]), num(row[idx.qty]), clean(row[idx.satuan]),
                num(row[idx.hargaSatuan]), num(row[idx.hargaTotal]), num(row[idx.diskonRp]),
                num(row[idx.dpp]), num(row[idx.ppn]), FILE, batchId,
            ],
        });
        success++;
    }

    await db.execute({
        sql: "UPDATE import_batch SET success_count = ?, fail_count = ? WHERE id = ?",
        args: [success, failed, batchId],
    });
    console.log(`Batch #${batchId}: staging+mapping selesai — sukses=${success}, gagal_parse=${failed}`);
    if (success === 0 && dataRows.length > 0) {
        console.error(
            `PERINGATAN: Batch #${batchId} — 0 baris sukses dari ${dataRows.length} baris. Cek apakah header/kolom cocok atau file memang tidak berisi referensi INV/.`,
        );
    }
    console.log(`Lanjut: node scripts/validate-sales-history-batch.mjs --batch ${batchId}`);
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => db.close());
