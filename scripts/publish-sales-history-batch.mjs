// scripts/publish-sales-history-batch.mjs
// Tujuan: satu-satunya cara baris sales_history_item/invoice_map jadi published=1 (terlihat dashboard).
//   Menolak jika batch belum stage='reconciled'.
// Jalankan: node scripts/publish-sales-history-batch.mjs --batch <id>
import { createClient } from "@libsql/client";

const DB_URL = process.env.SALES_HISTORY_DATABASE_URL || "file:sales-history-inv.db";
const db = createClient({ url: DB_URL });

const args = process.argv.slice(2);
const batchId = Number(args[args.indexOf("--batch") + 1]);
if (!Number.isInteger(batchId) || batchId <= 0) {
    console.error("Wajib: --batch <id>");
    process.exit(1);
}

async function main() {
    const batch = (await db.execute({ sql: "SELECT * FROM import_batch WHERE id = ?", args: [batchId] })).rows[0];
    if (!batch) {
        console.error(`Batch #${batchId} tidak ditemukan`);
        process.exit(1);
    }
    if (batch.stage !== "reconciled") {
        console.error(`Batch #${batchId} stage='${batch.stage}', bukan 'reconciled' — tidak boleh publish.`);
        process.exit(1);
    }

    await db.execute({ sql: "UPDATE sales_history_item SET published = 1 WHERE batch_id = ?", args: [batchId] });
    await db.execute({ sql: "UPDATE invoice_map SET published = 1 WHERE batch_id = ?", args: [batchId] });
    await db.execute({ sql: "UPDATE import_batch SET stage = 'published' WHERE id = ?", args: [batchId] });

    console.log(`Batch #${batchId}: published. Data periode ${batch.period} sekarang terlihat di dashboard Sales History.`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => db.close());
