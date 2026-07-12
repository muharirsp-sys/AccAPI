// Audit F1: index untuk tabel off_* (idempotent — aman dijalankan berulang).
// Jalankan: node scripts/migrate-add-off-indexes.mjs
import { createClient } from "@libsql/client";

const url = process.env.DATABASE_URL || "file:sqlite.db";
const client = createClient({ url });

const INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_off_batch_created_at ON off_batch(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_off_batch_created_by ON off_batch(created_by, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_off_batch_periode ON off_batch(principle_code, tahun, bulan)",
    "CREATE INDEX IF NOT EXISTS idx_off_batch_item_batch ON off_batch_item(batch_id)",
    "CREATE INDEX IF NOT EXISTS idx_off_payment_batch ON off_payment(batch_id)",
    "CREATE INDEX IF NOT EXISTS idx_off_refund_batch ON off_refund(batch_id)",
    "CREATE INDEX IF NOT EXISTS idx_off_notification_batch ON off_notification(batch_id)",
    "CREATE INDEX IF NOT EXISTS idx_off_audit_log_batch ON off_audit_log(batch_id)"
];

for (const sql of INDEXES) {
    await client.execute(sql);
    console.log("OK:", sql.split(" ")[5]);
}
console.log("Selesai. ANALYZE...");
await client.execute("ANALYZE");
client.close();
