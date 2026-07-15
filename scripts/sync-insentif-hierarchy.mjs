/**
 * Tujuan: Sinkronkan assignment SPV->Sales dan SM->SPV dari target insentif terbaru.
 * Caller: Developer/admin setelah import target lama atau sebelum mengaktifkan scoping hierarki.
 * Dependensi: pg, PostgreSQL DATABASE_URL (sales_targets dan tabel assignment).
 * Main Functions: latestBySalesCode dan transaksi bulk-upsert assignment.
 * Side Effects: Upsert spv_sales_assignment dan sm_spv_assignment; tidak mengubah user identity.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl?.startsWith("postgres")) throw new Error("DATABASE_URL PostgreSQL wajib di-set.");
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const client = await pool.connect();

const source = (await client.query(`
    SELECT DISTINCT ON (sales_code)
        sales_code AS "salesCode", TRIM(spv_name) AS "spvName", TRIM(sm_name) AS "smName"
    FROM sales_targets
    WHERE TRIM(COALESCE(spv_name, '')) <> ''
    ORDER BY sales_code, period_year DESC, period_month DESC, updated_at DESC
`)).rows;

const latestBySalesCode = new Map();
for (const row of source) if (!latestBySalesCode.has(row.salesCode)) latestBySalesCode.set(row.salesCode, row);

const latestSmBySpv = new Map();
for (const row of latestBySalesCode.values()) {
    if (row.smName && !latestSmBySpv.has(row.spvName)) latestSmBySpv.set(row.spvName, row.smName);
}

const now = new Date();
try {
    await client.query("BEGIN");
    const salesRows = [...latestBySalesCode.values()];
    if (salesRows.length) {
        await client.query(`
            INSERT INTO spv_sales_assignment (id, sales_code, spv_name, created_at, updated_at)
            SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamp[], $4::timestamp[])
            ON CONFLICT (sales_code) DO UPDATE SET spv_name = EXCLUDED.spv_name, updated_at = EXCLUDED.updated_at
        `, [salesRows.map(() => randomUUID()), salesRows.map((r) => r.salesCode), salesRows.map((r) => r.spvName), salesRows.map(() => now)]);
    }
    const spvRows = [...latestSmBySpv];
    if (spvRows.length) {
        await client.query(`
            INSERT INTO sm_spv_assignment (id, spv_name, sm_name, created_at, updated_at)
            SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamp[], $4::timestamp[])
            ON CONFLICT (spv_name) DO UPDATE SET sm_name = EXCLUDED.sm_name, updated_at = EXCLUDED.updated_at
        `, [spvRows.map(() => randomUUID()), spvRows.map(([spvName]) => spvName), spvRows.map(([, smName]) => smName), spvRows.map(() => now)]);
    }

    const spvSalesCount = salesRows.length
        ? Number((await client.query("SELECT COUNT(*) count FROM spv_sales_assignment WHERE sales_code = ANY($1::text[])", [salesRows.map((r) => r.salesCode)])).rows[0].count)
        : 0;
    const smSpvCount = spvRows.length
        ? Number((await client.query("SELECT COUNT(*) count FROM sm_spv_assignment WHERE spv_name = ANY($1::text[])", [spvRows.map(([spvName]) => spvName)])).rows[0].count)
        : 0;
    if (spvSalesCount !== salesRows.length || smSpvCount !== spvRows.length) {
        throw new Error("Self-check gagal: assignment hasil upsert tidak sama dengan mapping sumber terbaru.");
    }
    await client.query("COMMIT");
} catch (error) {
    await client.query("ROLLBACK");
    throw error;
} finally {
    client.release();
    await pool.end();
}

console.log(`Hierarchy siap: ${latestBySalesCode.size} Sales -> SPV, ${latestSmBySpv.size} SPV -> SM.`);
console.log("Identitas akun tetap null; link manual hanya bila nama akun sudah dikonfirmasi.");
