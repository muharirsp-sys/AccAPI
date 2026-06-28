/*
 * Tujuan: Backend operasional Elasticsearch untuk Sales History: cek status index dan bulk indexing batch dari DB final.
 * Caller: admin/manual ops via /api/sales-history/search-index; search produk dibaca oleh invoices route.
 * Dependensi: RBAC sales_history.manage, lib/sales-history/db.ts, lib/sales-history/search.ts.
 * Main Functions: GET status, POST index batch cursor-based.
 * Side Effects: DB read SQLite sales-history-inv.db; HTTP PUT/POST/DELETE ke Elasticsearch bila env tersedia.
 * Catatan: POST sengaja cursor-based agar 4 juta+ item tidak diindeks dalam satu request yang rawan timeout.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { ensureSalesHistorySchema, salesClient } from "@/lib/sales-history/db";
import {
    bulkIndexSalesHistoryDocuments,
    ensureSalesHistoryElasticsearchIndex,
    getSalesHistoryElasticsearchConfig,
    getSalesHistoryElasticsearchStatus,
    type SalesHistorySearchDocument,
} from "@/lib/sales-history/search";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 20000;

type Body = {
    cursor?: unknown;
    limit?: unknown;
    recreate?: unknown;
};

function clampLimit(value: unknown) {
    const parsed = Number(value || DEFAULT_LIMIT);
    if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
    return Math.min(Math.max(Math.floor(parsed), 1), MAX_LIMIT);
}

function cursorNumber(value: unknown) {
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function bool(value: unknown) {
    return value === true || value === "true" || value === 1 || value === "1";
}

async function readBody(request: NextRequest): Promise<Body> {
    try {
        const body = await request.json();
        return body && typeof body === "object" ? body as Body : {};
    } catch {
        return {};
    }
}

async function dbStatus() {
    const res = await salesClient.execute(`SELECT
        (SELECT COUNT(*) FROM invoice_map WHERE referensi LIKE 'INV/%') AS invoices,
        (SELECT COUNT(*) FROM sales_history_item WHERE referensi LIKE 'INV/%') AS items,
        (SELECT MAX(id) FROM sales_history_item WHERE referensi LIKE 'INV/%') AS maxItemId`);
    const row = res.rows[0] || {};
    return {
        invoices: Number(row.invoices || 0),
        items: Number(row.items || 0),
        maxItemId: Number(row.maxItemId || 0),
    };
}

async function loadDocuments(afterId: number, limit: number): Promise<SalesHistorySearchDocument[]> {
    const res = await salesClient.execute({
        sql: `SELECT shi.id,
                     shi.referensi,
                     shi.nomor_faktur AS nomorFaktur,
                     shi.tanggal,
                     im.principal,
                     im.kode_cust AS kodeCust,
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
                     shi.source_file AS sourceFile
              FROM sales_history_item shi
              JOIN invoice_map im ON im.referensi = shi.referensi
              LEFT JOIN customer_map cm ON cm.kode = im.kode_cust
              WHERE shi.referensi LIKE 'INV/%'
                AND shi.id > ?
              ORDER BY shi.id
              LIMIT ?`,
        args: [afterId, limit],
    });

    return res.rows.map((row) => ({
        id: Number(row.id || 0),
        referensi: String(row.referensi || ""),
        nomorFaktur: String(row.nomorFaktur || row.referensi || ""),
        tanggal: String(row.tanggal || ""),
        principal: String(row.principal || ""),
        kodeCust: String(row.kodeCust || ""),
        customerNama: String(row.customerNama || ""),
        customerNpwp: String(row.customerNpwp || ""),
        kodeObjek: String(row.kodeObjek || ""),
        namaProduk: String(row.namaProduk || ""),
        qty: Number(row.qty || 0),
        satuan: String(row.satuan || ""),
        hargaSatuan: Number(row.hargaSatuan || 0),
        hargaTotal: Number(row.hargaTotal || 0),
        diskonRp: Number(row.diskonRp || 0),
        dpp: Number(row.dpp || 0),
        ppn: Number(row.ppn || 0),
        sourceFile: String(row.sourceFile || ""),
    }));
}

function publicElasticConfig() {
    const config = getSalesHistoryElasticsearchConfig();
    if (!config) return { configured: false, index: "sales-history-items" };
    let origin = config.url;
    try { origin = new URL(config.url).origin; } catch { /* keep sanitized raw url */ }
    return { configured: true, index: config.index, url: origin };
}

export async function GET() {
    const gate = await requirePermissionH("sales_history.manage");
    if (gate.response) return gate.response;

    try {
        await ensureSalesHistorySchema();
        const [database, elasticsearch] = await Promise.all([
            dbStatus(),
            getSalesHistoryElasticsearchStatus(),
        ]);
        return NextResponse.json({ ok: true, database, elasticsearch, config: publicElasticConfig() });
    } catch (error) {
        console.error("[SALES HISTORY SEARCH INDEX STATUS ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal membaca status search index." }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    const gate = await requirePermissionH("sales_history.manage");
    if (gate.response) return gate.response;

    try {
        if (!getSalesHistoryElasticsearchConfig()) {
            return NextResponse.json({ ok: false, error: "ELASTICSEARCH_URL belum dikonfigurasi." }, { status: 400 });
        }

        const body = await readBody(request);
        const cursor = cursorNumber(body.cursor);
        const limit = clampLimit(body.limit);
        const recreate = bool(body.recreate);
        if (recreate && cursor > 0) {
            return NextResponse.json({ ok: false, error: "recreate hanya boleh dipakai saat cursor=0." }, { status: 400 });
        }

        await ensureSalesHistorySchema();
        const index = await ensureSalesHistoryElasticsearchIndex({ recreate });
        const docs = await loadDocuments(cursor, limit);
        if (docs.length === 0) {
            const status = await getSalesHistoryElasticsearchStatus();
            return NextResponse.json({ ok: true, done: true, indexed: 0, cursor, nextCursor: cursor, limit, index, elasticsearch: status });
        }

        const bulk = await bulkIndexSalesHistoryDocuments(docs);
        const nextCursor = Number(docs.at(-1)?.id || cursor);
        const done = docs.length < limit;
        const payload = { ok: bulk.errors.length === 0, done, indexed: bulk.indexed, cursor, nextCursor, limit, tookMs: bulk.took, index, errors: bulk.errors };
        return NextResponse.json(payload, { status: bulk.errors.length ? 502 : 200 });
    } catch (error) {
        console.error("[SALES HISTORY SEARCH INDEX ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal indexing Sales History ke Elasticsearch." }, { status: 500 });
    }
}
