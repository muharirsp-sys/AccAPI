/*
 * Tujuan: Tarik `item.detailSellingPrice[]` dari Accurate ke tabel `item_selling_price`.
 *         `item/list.do` tidak membawa priceCategory (dibuktikan live 2026-09-08), jadi
 *         harga bertingkat hanya bisa diambil lewat `item/detail.do` PER ITEM.
 * Caller: manual/terjadwal. Pakai:
 *         npx tsx --env-file=.env.local scripts/sync-item-selling-price.ts [--limit=N] [--restart]
 * Dependensi: lib/accurate-session (kredensial + refresh session), lib/db, db/schema.
 * Main Functions: run — iterasi item, ambil detail, upsert harga, checkpoint per item.
 * Side Effects: Tulis `item_selling_price` + `sync_state`. Read-only terhadap Accurate.
 *
 * Aman diulang: checkpoint disimpan di `sync_state` (module `item_selling_price`) sebagai
 * item_id terakhir yang selesai, jadi koneksi putus di tengah tidak memaksa mulai dari nol.
 * Laju dibatasi di bawah batas resmi Accurate (8 request/detik).
 */
import { asc, eq, gt, sql } from "drizzle-orm";
import { resolveSyncCredentials } from "@/lib/accurate-session";
import { db } from "@/lib/db";
import { item, itemSellingPrice, syncState } from "@/db/schema";

const MODULE = "item_selling_price";
const DELAY_MS = Number(process.env.ACCURATE_DETAIL_DELAY_MS || 120);
// Batas resmi Accurate 8 serentak; 4 menyisakan ruang untuk trafik aplikasi lain.
const CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.ACCURATE_DETAIL_CONCURRENCY || 4)));
const RETRIES = Math.max(1, Number(process.env.ACCURATE_DETAIL_RETRIES || 4));

function parseAccurateDate(value: unknown): string | null {
    // Accurate memakai dd/MM/yyyy pada effectiveDate.
    const found = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value ?? ""));
    return found ? `${found[3]}-${found[2]}-${found[1]}` : null;
}

type PriceRow = typeof itemSellingPrice.$inferInsert;

function extractRows(itemId: number, itemNo: string, detail: Record<string, unknown>): PriceRow[] {
    const list = Array.isArray(detail.detailSellingPrice) ? detail.detailSellingPrice : [];
    const seen = new Set<string>();
    const rows: PriceRow[] = [];
    for (const entry of list as Record<string, unknown>[]) {
        const category = (entry.priceCategory ?? {}) as Record<string, unknown>;
        const unit = (entry.unit ?? {}) as Record<string, unknown>;
        const branch = (entry.branch ?? {}) as Record<string, unknown>;
        const currency = (entry.currency ?? {}) as Record<string, unknown>;
        const effectiveDate = parseAccurateDate(entry.effectiveDate);
        const price = Number(entry.price);
        const categoryId = Number(category.id);
        const unitName = String(unit.name ?? "").trim().toUpperCase();
        // Baris tanpa kategori/satuan/tanggal/harga tidak bisa dipakai memilih harga — dilewati,
        // bukan ditambal dengan nilai karangan.
        if (!Number.isFinite(categoryId) || !unitName || !effectiveDate || !Number.isFinite(price)) continue;
        const branchId = Number.isFinite(Number(branch.id)) ? Number(branch.id) : 0;
        const key = `${categoryId}|${unitName}|${branchId}|${effectiveDate}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
            itemNo, itemId, priceCategoryId: categoryId,
            priceCategoryName: String(category.name ?? ""),
            unitName, branchId, branchName: String(branch.name ?? ""),
            defaultBranch: Boolean(branch.defaultBranch), defaultCategory: Boolean(category.defaultCategory),
            price, effectiveDate, currencyCode: String(currency.code ?? "IDR"),
        });
    }
    return rows;
}

async function run() {
    const args = process.argv.slice(2);
    const limitArg = args.find((a) => a.startsWith("--limit="));
    const limit = limitArg ? Number(limitArg.slice(8)) : Infinity;
    const restart = args.includes("--restart");

    const resolved = await resolveSyncCredentials();
    if (!resolved.creds) {
        console.error("Kredensial Accurate tidak tersedia:", resolved.error);
        process.exit(1);
    }
    const { sessionHost, sessionId, apiKey } = resolved.creds;

    let cursor = 0;
    if (!restart) {
        const [state] = await db.select().from(syncState).where(eq(syncState.module, MODULE));
        cursor = Number(state?.lastPage ?? 0) || 0;
    }
    console.log(`Mulai dari item_id > ${cursor}${Number.isFinite(limit) ? ` (limit ${limit} item)` : ""}`);

    const pending = await db.select({ id: item.id, no: item.no }).from(item)
        .where(gt(item.id, cursor)).orderBy(asc(item.id));
    const target = Number.isFinite(limit) ? pending.slice(0, limit) : pending;
    console.log(`Item yang akan diproses: ${target.length}`);

    let done = 0, priceRows = 0, skipped = 0;
    const started = Date.now();

    // ECONNRESET dari Accurate terjadi nyata pada sync panjang (2x terbukti 2026-09-08),
    // jadi tiap permintaan diulang dengan jeda menaik sebelum dianggap gagal.
    async function fetchOne(row: { id: number; no: string }, attempt = 1): Promise<PriceRow[] | null> {
        try {
            const res = await fetch(`${sessionHost}/accurate/api/item/detail.do?id=${row.id}`, {
                headers: { Authorization: `Bearer ${apiKey}`, "X-Session-ID": sessionId },
                signal: AbortSignal.timeout(60_000),
            });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) throw new Error(`item/detail.do id=${row.id} -> HTTP ${res.status}`);
            const body = await res.json();
            // Accurate bisa membalas 200 dengan s:false; itu bukan sukses.
            if (body?.s !== true || !body?.d) return null;
            return extractRows(row.id, String(row.no), body.d as Record<string, unknown>);
        } catch (error) {
            if (attempt >= RETRIES) throw error;
            const wait = 500 * 2 ** (attempt - 1);
            console.log(`  ulang item ${row.id} (percobaan ${attempt + 1}/${RETRIES}) setelah ${wait}ms: ${(error as Error).message}`);
            await new Promise((resolve) => setTimeout(resolve, wait));
            return fetchOne(row, attempt + 1);
        }
    }

    // Batch berurutan: tiap batch ditunggu penuh sebelum checkpoint, jadi id di bawah
    // checkpoint pasti sudah selesai walau di dalam batch dikerjakan bersamaan.
    for (let start = 0; start < target.length; start += CONCURRENCY) {
        const batch = target.slice(start, start + CONCURRENCY);
        const results = await Promise.all(batch.map((row) => fetchOne({ id: row.id, no: String(row.no) })));
        const rows = results.flatMap((result) => result ?? []);
        skipped += results.filter((result) => result === null).length;
        for (let index = 0; index < rows.length; index += 1000) {
            const chunk = rows.slice(index, index + 1000);
            await db.insert(itemSellingPrice).values(chunk).onConflictDoUpdate({
                target: [itemSellingPrice.itemNo, itemSellingPrice.priceCategoryId,
                         itemSellingPrice.unitName, itemSellingPrice.branchId, itemSellingPrice.effectiveDate],
                set: {
                    price: sql`excluded."price"`,
                    priceCategoryName: sql`excluded."price_category_name"`,
                    branchName: sql`excluded."branch_name"`,
                    defaultBranch: sql`excluded."default_branch"`,
                    defaultCategory: sql`excluded."default_category"`,
                    currencyCode: sql`excluded."currency_code"`,
                    itemId: sql`excluded."item_id"`,
                    syncedAt: sql`now()`,
                },
            });
        }
        priceRows += rows.length;
        done += batch.length;
        const lastId = batch.at(-1)!.id;
        await db.insert(syncState).values({ module: MODULE, lastPage: lastId, status: "running" })
            .onConflictDoUpdate({ target: syncState.module, set: { lastPage: lastId, status: "running", updatedAt: new Date() } });
        if (done % 200 < CONCURRENCY) {
            const rate = done / ((Date.now() - started) / 1000);
            const left = ((target.length - done) / Math.max(rate, 0.01) / 60).toFixed(1);
            console.log(`  ${done}/${target.length} item | ${priceRows} baris harga | ${rate.toFixed(1)} item/detik | sisa ~${left} menit`);
        }
        if (DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }

    await db.insert(syncState).values({ module: MODULE, lastPage: target.at(-1)?.id ?? cursor, status: "idle", lastSyncTimestamp: new Date().toISOString() })
        .onConflictDoUpdate({ target: syncState.module, set: { status: "idle", lastSyncTimestamp: new Date().toISOString(), updatedAt: new Date() } });
    console.log(`Selesai: ${done} item diproses, ${priceRows} baris harga, ${skipped} item tanpa detail, ${((Date.now() - started) / 1000).toFixed(0)} detik.`);
    process.exit(0);
}

run();
