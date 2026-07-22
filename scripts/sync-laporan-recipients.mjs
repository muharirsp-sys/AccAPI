/**
 * Tujuan: Sinkronkan mapping email laporan SPV, SM, dan Principal ke PostgreSQL.
 * Caller: Operator/deployment, `node scripts/sync-laporan-recipients.mjs [path.csv] [--check]`.
 * Dependensi: pg, DATABASE_URL, CSV kolom Keyword dan Email.
 * Main Functions: parseCsv, mergeRecipients, syncRecipients.
 * Side Effects: Dalam satu transaksi, upsert mapping CSV dan nonaktifkan keyword yang tidak tercantum.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const csvPath = path.resolve(args.find((arg) => arg !== "--check") || path.join(__dirname, "../config/mapping_laporan.csv"));

function parseCsv(text) {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
    if (lines[0]?.toLowerCase() !== "keyword,email") {
        throw new Error("Header CSV harus: Keyword,Email");
    }
    return lines.slice(1).map((line, index) => {
        const match = line.match(/^([^,]+),\s*(?:"([^"]*)"|(.*))$/);
        if (!match) throw new Error(`Format CSV tidak valid pada baris data ${index + 1}`);
        return { keyword: match[1].trim().toUpperCase(), emails: (match[2] ?? match[3] ?? "").trim() };
    }).filter((row) => row.keyword && row.emails);
}

function mergeRecipients(rows) {
    const merged = new Map();
    for (const row of rows) {
        const emails = merged.get(row.keyword) || new Map();
        for (const rawEmail of row.emails.split(/[;,]/)) {
            const email = rawEmail.trim();
            if (email) emails.set(email.toLowerCase(), email);
        }
        merged.set(row.keyword, emails);
    }
    return [...merged].map(([keyword, emails]) => ({
        id: randomUUID(),
        keyword,
        emails: [...emails.values()].join(", "),
    }));
}

async function syncRecipients(items) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL belum diisi");
    const { default: pg } = await import("pg");
    const { Client } = pg;
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
        await client.query("BEGIN");
        const payload = JSON.stringify(items);
        await client.query(
            `UPDATE report_recipient
             SET active = false, updated_at = NOW()
             WHERE active = true AND NOT (UPPER(keyword) = ANY($1::text[]))`,
            [items.map((item) => item.keyword)],
        );
        await client.query(
            `WITH incoming AS (
                 SELECT * FROM jsonb_to_recordset($1::jsonb)
                 AS x(id text, keyword text, emails text)
             )
             UPDATE report_recipient AS target
             SET keyword = incoming.keyword, emails = incoming.emails, active = true, updated_at = NOW()
             FROM incoming
             WHERE UPPER(target.keyword) = incoming.keyword`,
            [payload],
        );
        await client.query(
            `WITH incoming AS (
                 SELECT * FROM jsonb_to_recordset($1::jsonb)
                 AS x(id text, keyword text, emails text)
             )
             INSERT INTO report_recipient (id, keyword, emails, active, created_at, updated_at)
             SELECT incoming.id, incoming.keyword, incoming.emails, true, NOW(), NOW()
             FROM incoming
             WHERE NOT EXISTS (
                 SELECT 1 FROM report_recipient target WHERE UPPER(target.keyword) = incoming.keyword
             )`,
            [payload],
        );
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        await client.end();
    }
}

const items = mergeRecipients(parseCsv(fs.readFileSync(csvPath, "utf8")));
if (items.length === 0) throw new Error("CSV tidak menghasilkan mapping penerima");
if (checkOnly) {
    console.log(`Validasi selesai: ${items.length} keyword unik dari ${csvPath}`);
} else {
    await syncRecipients(items);
    console.log(`Sinkronisasi selesai: ${items.length} keyword aktif dari ${csvPath}`);
}
