/* Pilihan item sync harga/satuan lanjutan (24 Okt 2026) di Postgres EVALUASI (AM040_DATABASE_URL, bukan produksi), skema
 * sekali-pakai: item di atas kursor DAN item yang satuannya belum pernah terisi ikut dikerjakan, walau id-nya di bawah kursor.
 * Tanpa env dilewati. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const skema = `uji_itemsync_${randomUUID().slice(0, 8)}`;
let admin: Pool;
let itemTertunda: (cursor: number) => Promise<{ id: number; no: string }[]>;

before(async () => {
    if (!PG_URL) return;
    admin = new Pool({ connectionString: PG_URL, max: 2 });
    await admin.query(`CREATE SCHEMA ${skema}`);
    await admin.query(`CREATE TABLE ${skema}.item (LIKE public.item INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    await admin.query(`INSERT INTO ${skema}.item (id, no, name, unit1_name) VALUES
        (10, 'A', 'A', 'PCS'), (11, 'B', 'B', NULL), (20, 'C', 'C', 'PCS'), (21, 'D', 'D', NULL)`);
    const u = new URL(PG_URL);
    u.searchParams.set("options", `-c search_path=${skema}`);
    process.env.DATABASE_URL = u.toString();
    itemTertunda = (await import("./item-price-sync.ts")).itemTertunda;
});

after(async () => {
    if (!PG_URL) return;
    await (await import("./db.ts")).pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA ${skema} CASCADE`);
    await admin.end();
});

test("sync lanjutan: di atas kursor + yang satuannya belum pernah terisi (tidak dilewati selamanya)", { skip: PG_URL ? false : "AM040_DATABASE_URL tidak di-set" }, async () => {
    assert.deepEqual((await itemTertunda(15)).map((r) => r.no), ["B", "C", "D"]);
    assert.deepEqual((await itemTertunda(25)).map((r) => r.no), ["B", "D"], "kursor di ujung: hanya yang belum bersatuan");
});
