/*
 * Tujuan: Service query backend Sales History untuk status DB, cascade filter, tabel faktur, dan detail item INV.
 * Caller: app/api/sales-history/* route handlers.
 * Dependensi: lib/sales-history/db.ts dan lib/sales-history/search.ts.
 * Main Functions: getSalesHistoryDatabaseStatus, listSalesHistoryYears, listSalesHistoryPrincipals,
 *   listSalesHistoryCustomers, listSalesHistoryInvoices, listSalesHistoryItems.
 * Side Effects: DB read-only ke sales-history-inv.db; HTTP Elasticsearch hanya saat product search aktif.
 * Catatan: semua query membatasi referensi INV dan memakai range tanggal agar index tetap efektif.
 */
import { ensureSalesHistorySchema, salesClient } from "@/lib/sales-history/db";
import { searchSalesHistoryItemsWithElasticsearch, searchSalesHistoryRefsWithElasticsearch } from "@/lib/sales-history/search";
import { resolveFuzzyProduct } from "@/lib/sales-history/fuzzy";

export type SalesHistoryInvoiceFilters = {
    year?: string;
    principal?: string;
    kodeCust?: string;
    product?: string;
    page?: number;
    limit?: number;
};

type Args = Array<string | number>;

type InvoiceWhere = {
    where: string;
    args: Args;
};

export function isValidSalesHistoryYear(year: string) {
    return !year || /^\d{4}$/.test(year);
}

export function normalizePositiveInt(value: unknown, fallback: number, max: number) {
    const parsed = Number(value || fallback);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(Math.floor(parsed), 1), max);
}

function clean(value: unknown) {
    return String(value ?? "").trim();
}

function buildInvoiceWhere(filters: { year?: string; principal?: string; kodeCust?: string }, alias = "im"): InvoiceWhere {
    const prefix = alias ? `${alias}.` : "";
    const cond: string[] = [`${prefix}referensi LIKE 'INV/%'`];
    const args: Args = [];
    if (filters.year) {
        cond.push(`${prefix}tanggal >= ? AND ${prefix}tanggal < ?`);
        args.push(`${filters.year}-01-01`, `${Number(filters.year) + 1}-01-01`);
    }
    if (filters.principal) {
        cond.push(`${prefix}principal = ?`);
        args.push(filters.principal);
    }
    if (filters.kodeCust) {
        cond.push(`${prefix}kode_cust = ?`);
        args.push(filters.kodeCust);
    }
    return { where: `WHERE ${cond.join(" AND ")}`, args };
}

function invoiceSelectSql(where: string) {
    return `WITH filtered AS (
                SELECT im.referensi,
                       im.tanggal,
                       im.principal,
                       im.kode_cust                    AS kodeCust,
                       COALESCE(cm.nama, im.kode_cust) AS customerNama,
                       COALESCE(cm.alamat, '')         AS alamat,
                       COALESCE(cm.kota, '')           AS kota
                FROM invoice_map im
                LEFT JOIN customer_map cm ON cm.kode = im.kode_cust
                ${where}
                ORDER BY im.tanggal DESC, im.referensi DESC
                LIMIT ? OFFSET ?
            )
            SELECT f.referensi,
                   f.tanggal,
                   f.principal,
                   f.kodeCust,
                   f.customerNama,
                   f.alamat,
                   f.kota,
                   COUNT(shi.id)                     AS itemCount,
                   COALESCE(SUM(shi.harga_total), 0) AS totalBruto,
                   COALESCE(SUM(shi.diskon_rp), 0)   AS totalDiskon,
                   COALESCE(SUM(shi.dpp), 0)         AS totalDpp,
                   COALESCE(SUM(shi.ppn), 0)         AS totalPpn
            FROM filtered f
            LEFT JOIN sales_history_item shi ON shi.referensi = f.referensi
            GROUP BY f.referensi, f.tanggal, f.principal, f.kodeCust, f.customerNama, f.alamat, f.kota
            ORDER BY f.tanggal DESC, f.referensi DESC`;
}

export async function getSalesHistoryDatabaseStatus() {
    await ensureSalesHistorySchema();
    const res = await salesClient.execute(`SELECT
        (SELECT COUNT(*) FROM customer_map) AS customers,
        (SELECT COUNT(*) FROM invoice_map WHERE referensi LIKE 'INV/%') AS invoices,
        (SELECT COUNT(*) FROM sales_history_item WHERE referensi LIKE 'INV/%') AS items,
        (SELECT COUNT(*) FROM sales_history_item WHERE referensi NOT LIKE 'INV/%') AS nonInvItems,
        (SELECT COUNT(*) FROM sales_history_item WHERE satuan <> '') AS itemsWithSatuan,
        (SELECT MIN(tanggal) FROM invoice_map WHERE referensi LIKE 'INV/%') AS firstDate,
        (SELECT MAX(tanggal) FROM invoice_map WHERE referensi LIKE 'INV/%') AS lastDate,
        (SELECT MAX(id) FROM sales_history_item WHERE referensi LIKE 'INV/%') AS maxItemId`);
    const row = res.rows[0] || {};
    return {
        customers: Number(row.customers || 0),
        invoices: Number(row.invoices || 0),
        items: Number(row.items || 0),
        nonInvItems: Number(row.nonInvItems || 0),
        itemsWithSatuan: Number(row.itemsWithSatuan || 0),
        firstDate: clean(row.firstDate),
        lastDate: clean(row.lastDate),
        maxItemId: Number(row.maxItemId || 0),
        ready: Number(row.invoices || 0) > 0 && Number(row.items || 0) > 0,
    };
}

export async function listSalesHistoryYears() {
    await ensureSalesHistorySchema();
    const res = await salesClient.execute(
        `SELECT substr(tanggal, 1, 4) AS year, COUNT(*) AS invoices
         FROM invoice_map
         WHERE tanggal >= '1900-01-01' AND referensi LIKE 'INV/%'
         GROUP BY year
         ORDER BY year DESC`,
    );
    return res.rows;
}

export async function listSalesHistoryPrincipals(input: { year?: string }) {
    await ensureSalesHistorySchema();
    const year = clean(input.year);
    const { where, args } = buildInvoiceWhere({ year }, "");
    const res = await salesClient.execute({
        sql: `SELECT principal, COUNT(*) AS invoices
              FROM invoice_map
              ${where}
              GROUP BY principal
              ORDER BY principal`,
        args,
    });
    return res.rows;
}

// ponytail: drives from customer_map (25k) not invoice_map (724k); year/principal go into JOIN ON so customer list
// stays correct with HAVING > 0 when filtered. Empty-q + idx_cm_nama → ORDER BY uses index, stops at LIMIT 50.
export async function listSalesHistoryCustomers(input: { year?: string; principal?: string; q?: string; limit?: number }) {
    await ensureSalesHistorySchema();
    const year = clean(input.year);
    const principal = clean(input.principal);
    const q = clean(input.q);
    const limit = normalizePositiveInt(input.limit, 50, 200);
    const hasFilter = !!(year || principal);

    const joinConds = [`im.kode_cust = cm.kode`, `im.referensi LIKE 'INV/%'`];
    const joinArgs: Args = [];
    if (year) {
        joinConds.push(`im.tanggal >= ? AND im.tanggal < ?`);
        joinArgs.push(`${year}-01-01`, `${Number(year) + 1}-01-01`);
    }
    if (principal) {
        joinConds.push(`im.principal = ?`);
        joinArgs.push(principal);
    }

    const whereConds: string[] = [];
    const whereArgs: Args = [];
    if (q) {
        whereConds.push(`(cm.nama LIKE ? OR cm.kode LIKE ?)`);
        whereArgs.push(`%${q}%`, `${q}%`);
    }

    const res = await salesClient.execute({
        sql: `SELECT cm.kode,
                     cm.nama,
                     cm.alamat,
                     cm.kota,
                     COUNT(im.referensi) AS invoices
              FROM customer_map cm
              LEFT JOIN invoice_map im ON ${joinConds.join(" AND ")}
              ${whereConds.length ? `WHERE ${whereConds.join(" AND ")}` : ""}
              GROUP BY cm.kode
              ${hasFilter ? "HAVING COUNT(im.referensi) > 0" : ""}
              ORDER BY cm.nama
              LIMIT ?`,
        args: [...joinArgs, ...whereArgs, limit],
    });
    return res.rows;
}

async function rowsForRefs(refs: string[]) {
    if (refs.length === 0) return [];
    const placeholders = refs.map(() => "?").join(",");
    const res = await salesClient.execute({
        sql: `SELECT im.referensi,
                     im.tanggal,
                     im.principal,
                     im.kode_cust                    AS kodeCust,
                     COALESCE(cm.nama, im.kode_cust) AS customerNama,
                     COALESCE(cm.alamat, '')         AS alamat,
                     COALESCE(cm.kota, '')           AS kota,
                     COUNT(shi.id)                   AS itemCount,
                     COALESCE(SUM(shi.harga_total), 0) AS totalBruto,
                     COALESCE(SUM(shi.diskon_rp), 0) AS totalDiskon,
                     COALESCE(SUM(shi.dpp), 0)       AS totalDpp,
                     COALESCE(SUM(shi.ppn), 0)       AS totalPpn
              FROM invoice_map im
              LEFT JOIN customer_map cm ON cm.kode = im.kode_cust
              LEFT JOIN sales_history_item shi ON shi.referensi = im.referensi
              WHERE im.referensi LIKE 'INV/%' AND im.referensi IN (${placeholders})
              GROUP BY im.referensi, im.tanggal, im.principal, im.kode_cust, cm.nama, cm.alamat, cm.kota`,
        args: refs,
    });
    const byRef = new Map(res.rows.map((row) => [String(row.referensi), row]));
    return refs.map((ref) => byRef.get(ref)).filter(Boolean);
}

// Bangun kondisi pencocokan produk dari hasil fuzzy (nama_produk/kode_objek persis) → IN-clause berindeks.
function buildProductCond(match: { names: string[]; objs: string[] }, alias = "shi"): { cond: string; args: Args } | null {
    const parts: string[] = [];
    const args: Args = [];
    if (match.names.length) {
        parts.push(`${alias}.nama_produk IN (${match.names.map(() => "?").join(",")})`);
        args.push(...match.names);
    }
    if (match.objs.length) {
        parts.push(`${alias}.kode_objek IN (${match.objs.map(() => "?").join(",")})`);
        args.push(...match.objs);
    }
    if (parts.length === 0) return null; // tak ada nama cocok → hasil kosong
    return { cond: `(${parts.join(" OR ")})`, args };
}

// Fuzzy: resolusi query→nama persis lewat kamus, lalu IN-clause berindeks. Toleran typo (mis. "marei"→"marie").
async function sqliteProductRefs(where: string, args: Args, product: string, limit: number, offset: number) {
    const pc = buildProductCond(await resolveFuzzyProduct(product));
    if (!pc) return { refs: [] as string[], hasMore: false };
    const res = await salesClient.execute({
        sql: `SELECT im.referensi
              FROM invoice_map im
              LEFT JOIN customer_map cm ON cm.kode = im.kode_cust
              ${where}
              AND EXISTS (
                  SELECT 1
                  FROM sales_history_item shi
                  WHERE shi.referensi = im.referensi
                    AND ${pc.cond}
              )
              ORDER BY im.tanggal DESC, im.referensi DESC
              LIMIT ? OFFSET ?`,
        args: [...args, ...pc.args, limit + 1, offset],
    });
    const refs = res.rows.map((row) => String(row.referensi)).filter(Boolean);
    return { refs: refs.slice(0, limit), hasMore: refs.length > limit };
}

export async function listSalesHistoryInvoices(input: SalesHistoryInvoiceFilters) {
    await ensureSalesHistorySchema();
    const year = clean(input.year);
    const principal = clean(input.principal);
    const kodeCust = clean(input.kodeCust);
    const product = clean(input.product);
    const page = normalizePositiveInt(input.page, 1, 1000000);
    const limit = normalizePositiveInt(input.limit, 50, 200);
    const offset = (page - 1) * limit;

    if (product) {
        try {
            const elastic = await searchSalesHistoryRefsWithElasticsearch({
                query: product,
                filters: { year, principal, kodeCust },
                limit,
                offset,
            });
            if (elastic) {
                return {
                    invoices: await rowsForRefs(elastic.refs),
                    total: elastic.total,
                    totalApproximate: false,
                    page,
                    limit,
                    searchBackend: elastic.backend,
                };
            }
        } catch (error) {
            console.warn("[SALES HISTORY ELASTICSEARCH FALLBACK]", error);
        }
    }

    const { where, args } = buildInvoiceWhere({ year, principal, kodeCust }, "im");
    if (product) {
        const local = await sqliteProductRefs(where, args, product, limit, offset);
        const invoices = await rowsForRefs(local.refs);
        return {
            invoices,
            total: offset + invoices.length + (local.hasMore ? 1 : 0),
            totalApproximate: local.hasMore,
            page,
            limit,
            searchBackend: "sqlite" as const,
        };
    }

    const [countRes, rowsRes] = await Promise.all([
        salesClient.execute({
            sql: `SELECT COUNT(*) AS total
                  FROM invoice_map im
                  LEFT JOIN customer_map cm ON cm.kode = im.kode_cust
                  ${where}`,
            args,
        }),
        salesClient.execute({
            sql: invoiceSelectSql(where),
            args: [...args, limit, offset],
        }),
    ]);

    return {
        invoices: rowsRes.rows,
        total: Number(countRes.rows[0]?.total || 0),
        totalApproximate: false,
        page,
        limit,
        searchBackend: "none" as const,
    };
}

// Pencarian item flat (1 baris = 1 produk + No Faktur). Pakai Elasticsearch fuzzy bila tersedia, fallback SQLite LIKE.
export async function searchSalesHistoryItems(input: SalesHistoryInvoiceFilters) {
    await ensureSalesHistorySchema();
    const year = clean(input.year);
    const principal = clean(input.principal);
    const kodeCust = clean(input.kodeCust);
    const product = clean(input.product);
    const page = normalizePositiveInt(input.page, 1, 1000000);
    const limit = normalizePositiveInt(input.limit, 50, 200);
    const offset = (page - 1) * limit;

    if (!product) {
        return { items: [], total: 0, totalApproximate: false, page, limit, searchBackend: "none" as const };
    }

    try {
        const elastic = await searchSalesHistoryItemsWithElasticsearch({
            query: product,
            filters: { year, principal, kodeCust },
            limit,
            offset,
        });
        if (elastic) {
            return {
                items: elastic.items,
                total: elastic.total,
                totalApproximate: false,
                page,
                limit,
                searchBackend: elastic.backend,
            };
        }
    } catch (error) {
        console.warn("[SALES HISTORY ITEM SEARCH ELASTICSEARCH FALLBACK]", error);
    }

    // Fallback SQLite fuzzy: resolusi nama lewat kamus → IN-clause berindeks (toleran typo, mis. "marei"→"marie").
    // total perkiraan via limit+1 agar tak full-count 4.5jt baris.
    const { where, args } = buildInvoiceWhere({ year, principal, kodeCust }, "im");
    const pc = buildProductCond(await resolveFuzzyProduct(product));
    if (!pc) {
        return { items: [], total: 0, totalApproximate: false, page, limit, searchBackend: "sqlite" as const };
    }
    const res = await salesClient.execute({
        sql: `SELECT shi.id,
                     shi.referensi,
                     shi.nomor_faktur AS nomorFaktur,
                     shi.tanggal,
                     im.principal,
                     im.kode_cust                    AS kodeCust,
                     COALESCE(cm.nama, shi.customer_nama) AS customerNama,
                     shi.customer_npwp AS customerNpwp,
                     shi.kode_objek AS kodeObjek,
                     shi.nama_produk AS namaProduk,
                     shi.qty,
                     shi.satuan,
                     shi.harga_satuan AS hargaSatuan,
                     shi.harga_total AS hargaTotal,
                     shi.diskon_rp AS diskonRp,
                     shi.dpp,
                     shi.ppn,
                     shi.source_file AS sourceFile,
                     shi.keterangan
              FROM sales_history_item shi
              JOIN invoice_map im ON im.referensi = shi.referensi
              LEFT JOIN customer_map cm ON cm.kode = im.kode_cust
              ${where}
                AND ${pc.cond}
              ORDER BY shi.tanggal DESC, shi.id DESC
              LIMIT ? OFFSET ?`,
        args: [...args, ...pc.args, limit + 1, offset],
    });
    const rows = res.rows;
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
        items,
        total: offset + items.length + (hasMore ? 1 : 0),
        totalApproximate: hasMore,
        page,
        limit,
        searchBackend: "sqlite" as const,
    };
}

export async function listSalesHistoryItems(ref: string) {
    await ensureSalesHistorySchema();
    const referensi = clean(ref);
    if (!referensi.toUpperCase().startsWith("INV/")) return [];
    const res = await salesClient.execute({
        sql: `SELECT id,
                     referensi,
                     nomor_faktur AS nomorFaktur,
                     tanggal,
                     customer_nama AS customerNama,
                     customer_npwp AS customerNpwp,
                     kode_objek AS kodeObjek,
                     nama_produk AS namaProduk,
                     qty,
                     satuan,
                     harga_satuan AS hargaSatuan,
                     harga_total AS hargaTotal,
                     diskon_rp AS diskonRp,
                     dpp,
                     ppn,
                     source_file AS sourceFile,
                     keterangan
              FROM sales_history_item
              WHERE referensi = ?
              ORDER BY id`,
        args: [referensi],
    });
    return res.rows;
}
