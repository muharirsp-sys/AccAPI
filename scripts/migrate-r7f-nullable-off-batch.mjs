// Tujuan: Phase R7f migration — ubah `claim_workflow.off_batch_id` menjadi
//         nullable supaya direct kwitansi / manual claim source dapat
//         dibuat tanpa OFF batch.
// Caller: `node scripts/migrate-r7f-nullable-off-batch.mjs` (dry-run default)
//         atau `node scripts/migrate-r7f-nullable-off-batch.mjs --apply`
//         (eksekusi dengan backup otomatis).
// Side Effects (--apply):
//   - Buat backup: `sqlite-backup-r7f-YYYYMMDD-HHmmss.db` di project root.
//   - Rebuild tabel `claim_workflow` dengan `off_batch_id` nullable.
//   - Re-create indexes + foreign keys.
//   - PRAGMA foreign_key_check di akhir.
//   - Tidak menghapus data; row count harus sama sebelum/sesudah.
// Aturan:
//   - Refuse non-lokal DATABASE_URL.
//   - Default dry-run (tidak menyentuh DB sama sekali).
//   - --apply WAJIB explicit. Tanpa flag, hanya inspect schema + report rencana.
//   - Backup harus berhasil sebelum migration eksekusi. Bila backup gagal,
//     STOP tanpa modifikasi DB.

import { createClient } from "@libsql/client";
import { existsSync, readFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv() {
    const envPath = resolve(process.cwd(), ".env");
    if (!existsSync(envPath)) return;
    const content = readFileSync(envPath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
    }
}
loadEnv();

const databaseUrl = process.env.DATABASE_URL || "file:sqlite.db";
const filePath = databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : "";
if (!filePath || filePath.startsWith("/app/")) {
    console.error(`[migrate-r7f] REFUSED: DATABASE_URL bukan SQLite lokal (${databaseUrl}).`);
    process.exit(2);
}

const APPLY = process.argv.includes("--apply");
const db = createClient({ url: databaseUrl });

function timestamp() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${y}${m}${day}-${hh}${mm}${ss}`;
}

async function inspectColumn() {
    const cols = await db.execute("PRAGMA table_info('claim_workflow')");
    const offCol = cols.rows.find((r) => String(r.name) === "off_batch_id");
    if (!offCol) {
        return { exists: false, notNull: false };
    }
    return {
        exists: true,
        notNull: Number(offCol.notnull) === 1,
        type: String(offCol.type),
        dflt_value: offCol.dflt_value,
    };
}

/**
 * Pre-flight check: pastikan semua kolom R7a ada di tabel claim_workflow.
 * Kalau operator lupa run R7a migration dulu, INSERT … SELECT di rebuild
 * akan fail di tengah jalan dengan pesan yang membingungkan. Refuse di
 * awal sebelum membuat backup atau menyentuh DB.
 */
async function ensureR7aColumns() {
    const cols = await db.execute("PRAGMA table_info('claim_workflow')");
    const present = new Set(cols.rows.map((r) => String(r.name)));
    const required = ["source_type", "source_ref_id", "aggregate_status"];
    const missing = required.filter((c) => !present.has(c));
    if (missing.length > 0) {
        console.error(`[migrate-r7f] FAILED pre-flight: kolom R7a hilang di claim_workflow: ${missing.join(", ")}.`);
        console.error("[migrate-r7f] Jalankan dulu: node scripts/init-db.mjs && node scripts/migrate-r7a-default-submission.mjs");
        process.exit(8);
    }
}

async function inspectIndexes() {
    const idxRes = await db.execute("PRAGMA index_list('claim_workflow')");
    const out = [];
    for (const idx of idxRes.rows) {
        const name = String(idx.name);
        // PRAGMA index_info tidak menerima parameter binding di SQLite,
        // jadi escape manual: hanya allow whitelist alphanumerics + _-.
        // Index name dari PRAGMA index_list system-controlled, tapi
        // tetap defensive validate.
        if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
            throw new Error(`Invalid index name: ${name}`);
        }
        const info = await db.execute(`PRAGMA index_info('${name.replace(/'/g, "''")}')`);
        out.push({
            name,
            unique: Number(idx.unique) === 1,
            origin: String(idx.origin),
            partial: Number(idx.partial) === 1,
            columns: info.rows.map((c) => String(c.name)),
        });
    }
    return out;
}

async function rowCount() {
    const res = await db.execute("SELECT COUNT(*) AS n FROM claim_workflow");
    return Number(res.rows[0].n || 0);
}

async function tableSqlOriginal() {
    const res = await db.execute({
        sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='claim_workflow'",
        args: [],
    });
    return res.rows[0]?.sql ? String(res.rows[0].sql) : null;
}

async function userIndexes() {
    // Indexes user-defined (origin='c' from CREATE INDEX). Auto-indexes
    // (origin='u'/'pk') yang dibuat oleh UNIQUE constraint akan ikut
    // terbentuk ulang otomatis oleh CREATE TABLE baru.
    const res = await db.execute(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='claim_workflow' AND sql IS NOT NULL"
    );
    return res.rows.map((r) => ({ name: String(r.name), sql: String(r.sql) }));
}

async function main() {
    console.log("");
    console.log("Phase R7f migration — claim_workflow.off_batch_id → nullable");
    console.log(`Database: ${databaseUrl}`);
    console.log(`Mode: ${APPLY ? "APPLY (will rewrite table)" : "DRY-RUN (no changes)"}`);
    console.log("");

    const before = await inspectColumn();
    console.log("BEFORE:");
    console.log(`  off_batch_id exists  : ${before.exists}`);
    console.log(`  off_batch_id NOT NULL: ${before.notNull}`);
    if (before.exists) {
        console.log(`  off_batch_id type    : ${before.type}`);
    }
    const indexes = await inspectIndexes();
    console.log("  indexes:");
    for (const idx of indexes) {
        console.log(`    - ${idx.name} unique=${idx.unique} origin=${idx.origin} cols=[${idx.columns.join(",")}]`);
    }
    const rowsBefore = await rowCount();
    console.log(`  row count            : ${rowsBefore}`);
    console.log("");

    if (!before.exists) {
        console.error("[migrate-r7f] off_batch_id column tidak ada. Schema tidak dikenal. STOP.");
        process.exit(3);
    }

    // Pre-flight: pastikan R7a sudah di-apply sebelum melanjutkan. Tanpa
    // kolom R7a, rebuild INSERT akan fail mid-apply dengan pesan
    // "no such column" yang membingungkan. Refuse di sini supaya
    // operator dapat menjalankan R7a dulu tanpa modifikasi DB.
    await ensureR7aColumns();

    if (!before.notNull) {
        console.log("[migrate-r7f] off_batch_id sudah nullable. Tidak ada perubahan.");
        console.log("Migration not needed. Idempotent — exit 0.");
        return;
    }

    if (!APPLY) {
        console.log("[DRY-RUN] Rencana eksekusi (jalankan dengan --apply untuk mengeksekusi):");
        console.log("  1. Backup sqlite.db ke sqlite-backup-r7f-<timestamp>.db");
        console.log("  2. PRAGMA foreign_keys=OFF");
        console.log("  3. BEGIN IMMEDIATE TRANSACTION");
        console.log("  4. Buat tabel claim_workflow_new dengan off_batch_id NULL allowed (kolom + index lain identik)");
        console.log("  5. INSERT INTO claim_workflow_new SELECT * FROM claim_workflow");
        console.log("  6. DROP TABLE claim_workflow");
        console.log("  7. ALTER TABLE claim_workflow_new RENAME TO claim_workflow");
        console.log("  8. Re-create user indexes:");
        const userIdx = await userIndexes();
        for (const idx of userIdx) {
            console.log(`       - ${idx.name}`);
        }
        console.log("  9. COMMIT");
        console.log(" 10. PRAGMA foreign_key_check");
        console.log(" 11. PRAGMA foreign_keys=ON");
        console.log(" 12. Verifikasi row count sama dengan sebelum migration");
        console.log("");
        console.log("Tidak ada modifikasi DB. Re-run dengan --apply untuk eksekusi.");
        return;
    }

    // APPLY mode
    const backupPath = `sqlite-backup-r7f-${timestamp()}.db`;
    console.log(`[apply] Membuat backup: ${backupPath}`);
    try {
        copyFileSync(filePath, backupPath);
    } catch (err) {
        console.error(`[migrate-r7f] FAILED backup ke ${backupPath}:`, err);
        process.exit(4);
    }
    console.log(`[apply] Backup OK.`);

    const originalSql = await tableSqlOriginal();
    if (!originalSql) {
        console.error("[migrate-r7f] Tidak dapat membaca CREATE TABLE original. STOP.");
        process.exit(5);
    }

    // Bangun CREATE TABLE baru dengan off_batch_id nullable.
    // Strategi: ganti pattern `off_batch_id` ... NOT NULL menjadi nullable.
    // Lebih aman: hardcode definisi tabel baru sesuai schema target R7f.
    // Schema target identik dengan db/schema.ts current claimWorkflow,
    // hanya off_batch_id tanpa NOT NULL.
    const newTableSql = `CREATE TABLE claim_workflow_new (
        id TEXT PRIMARY KEY,
        off_batch_id TEXT,
        claim_workflow_no TEXT NOT NULL UNIQUE,
        principle_code TEXT NOT NULL,
        principle_name TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'off_program',
        source_ref_id TEXT,
        aggregate_status TEXT,
        status TEXT NOT NULL DEFAULT 'Draft',
        total_dpp REAL NOT NULL DEFAULT 0,
        total_ppn REAL NOT NULL DEFAULT 0,
        total_pph REAL NOT NULL DEFAULT 0,
        total_claim REAL NOT NULL DEFAULT 0,
        total_paid REAL NOT NULL DEFAULT 0,
        remaining_amount REAL NOT NULL DEFAULT 0,
        no_claim TEXT,
        no_claim_assigned_at INTEGER,
        no_claim_assigned_by TEXT,
        submitted_to_principal_at INTEGER,
        claim_letter_pdf_path TEXT,
        claim_letter_generated_at INTEGER,
        claim_letter_generated_by TEXT,
        summary_pdf_path TEXT,
        summary_generated_at INTEGER,
        summary_generated_by TEXT,
        receipt_pdf_path TEXT,
        receipt_generated_at INTEGER,
        receipt_generated_by TEXT,
        closed_at INTEGER,
        closed_by TEXT,
        close_note TEXT,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (off_batch_id) REFERENCES off_batch(id)
    )`;

    try {
        await db.execute("PRAGMA foreign_keys=OFF");
        await db.execute("BEGIN IMMEDIATE TRANSACTION");
        try {
            console.log("[apply] Creating claim_workflow_new...");
            await db.execute(newTableSql);

            console.log("[apply] Copying rows...");
            await db.execute(`
                INSERT INTO claim_workflow_new
                SELECT
                    id, off_batch_id, claim_workflow_no, principle_code, principle_name,
                    COALESCE(source_type, 'off_program'),
                    source_ref_id, aggregate_status,
                    status,
                    total_dpp, total_ppn, total_pph, total_claim,
                    total_paid, remaining_amount,
                    no_claim, no_claim_assigned_at, no_claim_assigned_by,
                    submitted_to_principal_at,
                    claim_letter_pdf_path, claim_letter_generated_at, claim_letter_generated_by,
                    summary_pdf_path, summary_generated_at, summary_generated_by,
                    receipt_pdf_path, receipt_generated_at, receipt_generated_by,
                    closed_at, closed_by, close_note,
                    created_by, created_at, updated_at
                FROM claim_workflow
            `);
            const userIdx = await userIndexes();

            console.log("[apply] Dropping old table...");
            await db.execute("DROP TABLE claim_workflow");

            console.log("[apply] Renaming new table...");
            await db.execute("ALTER TABLE claim_workflow_new RENAME TO claim_workflow");

            console.log("[apply] Re-creating user indexes...");
            for (const idx of userIdx) {
                // SQL idx menyebut tabel claim_workflow yang sekarang sudah valid.
                await db.execute(idx.sql);
            }

            await db.execute("COMMIT");
        } catch (innerErr) {
            await db.execute("ROLLBACK").catch(() => {});
            throw innerErr;
        }
        // FK check di luar transaksi (PRAGMA tidak bekerja di dalam tx).
        const fk = await db.execute("PRAGMA foreign_key_check");
        if (fk.rows.length > 0) {
            console.error("[migrate-r7f] foreign_key_check menemukan masalah:", fk.rows);
            console.error(`[migrate-r7f] Backup tersedia di ${backupPath}. Restore manual jika perlu.`);
            process.exit(6);
        }
        await db.execute("PRAGMA foreign_keys=ON");

        const after = await inspectColumn();
        const rowsAfter = await rowCount();
        console.log("");
        console.log("AFTER:");
        console.log(`  off_batch_id NOT NULL: ${after.notNull}`);
        console.log(`  row count            : ${rowsAfter}`);
        if (rowsAfter !== rowsBefore) {
            console.error(`[migrate-r7f] FAILED row count mismatch: before=${rowsBefore} after=${rowsAfter}.`);
            console.error(`[migrate-r7f] Backup tersedia di ${backupPath}. Restore manual.`);
            process.exit(7);
        }
        console.log("");
        console.log("Migration applied successfully. Backup: " + backupPath);
    } catch (err) {
        console.error("[migrate-r7f] FAILED:", err);
        console.error(`[migrate-r7f] Backup tersedia di ${backupPath}. Restore manual jika DB rusak.`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error("[migrate-r7f] UNCAUGHT:", err);
    process.exit(1);
});
