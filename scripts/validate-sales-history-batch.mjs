// scripts/validate-sales-history-batch.mjs
// Tujuan: cek kualitas data satu batch sebelum boleh direkonsiliasi.
// Jalankan: node scripts/validate-sales-history-batch.mjs --batch <id>
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

    const items = (await db.execute({
        sql: "SELECT id, referensi, kode_objek, tanggal, qty, dpp, ppn, harga_total FROM sales_history_item WHERE batch_id = ?",
        args: [batchId],
    })).rows;

    const invoiceRefs = new Set(
        (await db.execute({ sql: "SELECT referensi FROM invoice_map WHERE batch_id = ?", args: [batchId] })).rows
            .map((r) => String(r.referensi)),
    );
    const customerCodes = new Set(
        (await db.execute("SELECT kode FROM customer_map")).rows.map((r) => String(r.kode)),
    );
    const invoiceCustomers = new Map(
        (await db.execute({ sql: "SELECT referensi, kode_cust FROM invoice_map WHERE batch_id = ?", args: [batchId] })).rows
            .map((r) => [String(r.referensi), String(r.kode_cust)]),
    );

    const seen = new Set();
    let failCount = 0;
    for (const item of items) {
        const reasons = [];
        if (!invoiceRefs.has(item.referensi)) reasons.push("referensi tanpa header invoice_map");
        const kodeCust = invoiceCustomers.get(String(item.referensi));
        if (kodeCust && !customerCodes.has(kodeCust)) reasons.push(`kode_cust ${kodeCust} tidak ada di customer_map`);
        if (!String(item.tanggal).startsWith(batch.period)) reasons.push(`tanggal ${item.tanggal} di luar periode ${batch.period}`);
        if (Number(item.qty) === 0) reasons.push("qty = 0");
        if (Number(item.dpp) + Number(item.ppn) === 0 && Number(item.harga_total) !== 0) reasons.push("dpp+ppn = 0 padahal harga_total != 0");
        const dupKey = `${item.referensi}|${item.kode_objek}`;
        if (seen.has(dupKey)) reasons.push("duplikat referensi+kode_objek dalam batch ini");
        seen.add(dupKey);

        if (reasons.length) {
            failCount++;
            await db.execute({
                sql: "UPDATE sales_history_item SET flags = ? WHERE id = ?",
                args: [JSON.stringify(reasons), item.id],
            });
        }
    }

    const stage = failCount === 0 ? "validated" : "validation_failed";
    await db.execute({
        sql: "UPDATE import_batch SET stage = ?, fail_count = ?, notes = ? WHERE id = ?",
        args: [stage, failCount, `validate: ${items.length} dicek, ${failCount} gagal`, batchId],
    });

    console.log(`Batch #${batchId}: ${items.length} baris dicek, ${failCount} gagal -> stage=${stage}`);
    if (stage === "validated") {
        console.log(`Lanjut: node scripts/reconcile-sales-history-batch.mjs --batch ${batchId}`);
    } else {
        console.log(`Perbaiki baris gagal (lihat kolom flags di sales_history_item WHERE batch_id=${batchId}), lalu jalankan ulang.`);
    }
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => db.close());
