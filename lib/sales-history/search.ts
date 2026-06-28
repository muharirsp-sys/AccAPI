/*
 * Tujuan: Adapter Elasticsearch untuk Sales History: search produk, status index, ensure mapping, dan bulk indexing.
 * Caller: app/api/sales-history/invoices/route.ts dan app/api/sales-history/search-index/route.ts.
 * Dependensi: Elasticsearch REST API opsional via env ELASTICSEARCH_URL.
 * Main Functions: searchSalesHistoryRefsWithElasticsearch, getSalesHistoryElasticsearchStatus,
 *   ensureSalesHistoryElasticsearchIndex, bulkIndexSalesHistoryDocuments.
 * Side Effects: HTTP request ke Elasticsearch bila env tersedia dan index sudah ada/dibuat.
 */

export type SalesHistorySearchFilters = {
    year?: string;
    principal?: string;
    kodeCust?: string;
};

export type SalesHistoryElasticResult = {
    refs: string[];
    total: number;
    backend: "elasticsearch";
};

export type SalesHistorySearchDocument = {
    id: number | string;
    referensi: string;
    nomorFaktur: string;
    tanggal: string;
    principal: string;
    kodeCust: string;
    customerNama: string;
    customerNpwp: string;
    kodeObjek: string;
    namaProduk: string;
    qty: number;
    satuan: string;
    hargaSatuan: number;
    hargaTotal: number;
    diskonRp: number;
    dpp: number;
    ppn: number;
    sourceFile: string;
};

export type SalesHistoryElasticsearchConfig = {
    url: string;
    index: string;
    apiKey: string;
    username: string;
    password: string;
};

function normalizeSearchText(value: unknown): string {
    return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function getSalesHistoryElasticsearchConfig(): SalesHistoryElasticsearchConfig | null {
    const url = process.env.ELASTICSEARCH_URL?.replace(/\/+$/, "");
    if (!url) return null;
    return {
        url,
        index: process.env.ELASTICSEARCH_SALES_HISTORY_INDEX || "sales-history-items",
        apiKey: process.env.ELASTICSEARCH_API_KEY || "",
        username: process.env.ELASTICSEARCH_USERNAME || "",
        password: process.env.ELASTICSEARCH_PASSWORD || "",
    };
}

function elasticsearchHeaders(config: SalesHistoryElasticsearchConfig) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.apiKey) {
        headers.Authorization = `ApiKey ${config.apiKey}`;
    } else if (config.username || config.password) {
        headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
    }
    return headers;
}

function indexUrl(config: SalesHistoryElasticsearchConfig, suffix = "") {
    return `${config.url}/${encodeURIComponent(config.index)}${suffix}`;
}

async function indexExists(config: SalesHistoryElasticsearchConfig) {
    const response = await fetch(indexUrl(config), {
        method: "HEAD",
        headers: elasticsearchHeaders(config),
    });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`Elasticsearch HEAD gagal (${response.status}).`);
    return true;
}

export async function getSalesHistoryElasticsearchStatus() {
    const config = getSalesHistoryElasticsearchConfig();
    if (!config) {
        return { configured: false, index: "sales-history-items", exists: false, documentCount: null as number | null };
    }

    const exists = await indexExists(config);
    if (!exists) return { configured: true, index: config.index, exists: false, documentCount: 0 };

    const countResponse = await fetch(indexUrl(config, "/_count"), {
        method: "POST",
        headers: elasticsearchHeaders(config),
        body: JSON.stringify({ query: { prefix: { referensi: "INV/" } } }),
    });
    if (!countResponse.ok) throw new Error(`Elasticsearch count gagal (${countResponse.status}).`);
    const count = await countResponse.json() as { count?: number };
    return { configured: true, index: config.index, exists: true, documentCount: Number(count.count || 0) };
}

export async function ensureSalesHistoryElasticsearchIndex(options: { recreate?: boolean } = {}) {
    const config = getSalesHistoryElasticsearchConfig();
    if (!config) throw new Error("ELASTICSEARCH_URL belum dikonfigurasi.");

    if (options.recreate) {
        const deleted = await fetch(indexUrl(config), {
            method: "DELETE",
            headers: elasticsearchHeaders(config),
        });
        if (!deleted.ok && deleted.status !== 404) throw new Error(`Elasticsearch delete index gagal (${deleted.status}).`);
    } else if (await indexExists(config)) {
        return { created: false, index: config.index };
    }

    const created = await fetch(indexUrl(config), {
        method: "PUT",
        headers: elasticsearchHeaders(config),
        body: JSON.stringify({
            settings: {
                number_of_shards: Number(process.env.ELASTICSEARCH_SALES_HISTORY_SHARDS || 1),
                number_of_replicas: Number(process.env.ELASTICSEARCH_SALES_HISTORY_REPLICAS || 0),
            },
            mappings: {
                dynamic: false,
                properties: {
                    id: { type: "long" },
                    referensi: { type: "keyword" },
                    nomorFaktur: { type: "keyword" },
                    tanggal: { type: "date" },
                    principal: { type: "keyword" },
                    kodeCust: { type: "keyword" },
                    customerNama: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } },
                    customerNpwp: { type: "keyword" },
                    kodeObjek: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 128 } } },
                    namaProduk: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 512 } } },
                    qty: { type: "double" },
                    satuan: { type: "keyword" },
                    hargaSatuan: { type: "double" },
                    hargaTotal: { type: "double" },
                    diskonRp: { type: "double" },
                    dpp: { type: "double" },
                    ppn: { type: "double" },
                    sourceFile: { type: "keyword" },
                },
            },
        }),
    });
    if (!created.ok) throw new Error(`Elasticsearch create index gagal (${created.status}).`);
    return { created: true, index: config.index };
}

export async function bulkIndexSalesHistoryDocuments(docs: SalesHistorySearchDocument[]) {
    const config = getSalesHistoryElasticsearchConfig();
    if (!config) throw new Error("ELASTICSEARCH_URL belum dikonfigurasi.");
    if (docs.length === 0) return { took: 0, indexed: 0, errors: [] as Array<Record<string, unknown>> };

    const lines: string[] = [];
    for (const doc of docs) {
        lines.push(JSON.stringify({ index: { _index: config.index, _id: String(doc.id) } }));
        lines.push(JSON.stringify(doc));
    }

    const response = await fetch(`${config.url}/_bulk`, {
        method: "POST",
        headers: elasticsearchHeaders(config),
        body: `${lines.join("\n")}\n`,
    });
    if (!response.ok) throw new Error(`Elasticsearch bulk gagal (${response.status}).`);

    const data = await response.json() as {
        took?: number;
        errors?: boolean;
        items?: Array<{ index?: { error?: Record<string, unknown> } }>;
    };
    const errors = data.errors
        ? (data.items || []).map((item) => item.index?.error).filter((error): error is Record<string, unknown> => Boolean(error)).slice(0, 10)
        : [];
    return { took: Number(data.took || 0), indexed: docs.length - errors.length, errors };
}

// Bangun filter ES bersama (INV-only + cascade tahun/principal/customer).
function buildElasticFilter(filters: SalesHistorySearchFilters): Array<Record<string, unknown>> {
    const filter: Array<Record<string, unknown>> = [{ prefix: { referensi: "INV/" } }];
    if (filters.year) {
        filter.push({ range: { tanggal: { gte: `${filters.year}-01-01`, lt: `${Number(filters.year) + 1}-01-01` } } });
    }
    if (filters.principal) filter.push({ term: { principal: filters.principal } });
    if (filters.kodeCust) filter.push({ term: { kodeCust: filters.kodeCust } });
    return filter;
}

// Pencarian item flat (1 baris = 1 produk) langsung dari _source ES dengan fuzzy match (typo dibenarkan).
export async function searchSalesHistoryItemsWithElasticsearch(input: {
    query: string;
    filters: SalesHistorySearchFilters;
    limit: number;
    offset: number;
}): Promise<{ items: SalesHistorySearchDocument[]; total: number; backend: "elasticsearch" } | null> {
    const config = getSalesHistoryElasticsearchConfig();
    const query = normalizeSearchText(input.query);
    if (!config || !query) return null;
    if (!await indexExists(config)) return null;

    const response = await fetch(indexUrl(config, "/_search"), {
        method: "POST",
        headers: elasticsearchHeaders(config),
        body: JSON.stringify({
            from: input.offset,
            size: input.limit,
            track_total_hits: true,
            query: {
                bool: {
                    filter: buildElasticFilter(input.filters),
                    must: [{
                        multi_match: {
                            query,
                            // ponytail: bool_prefix → non-last terms fuzzy (typo), last term prefix ("hazel"→"hazeltea*").
                            // operator:and tetap agar semua token harus cocok (presisi terjaga).
                            type: "bool_prefix",
                            operator: "and",
                            fuzziness: "AUTO",
                            fields: ["namaProduk^4", "kodeObjek^3"],
                        },
                    }],
                },
            },
            sort: [{ _score: "desc" }, { tanggal: "desc" }],
        }),
    });

    if (!response.ok) throw new Error("Pencarian item Elasticsearch Sales History gagal.");
    const data = (await response.json()) as {
        hits?: {
            total?: number | { value?: number };
            hits?: Array<{ _source?: SalesHistorySearchDocument }>;
        };
    };
    const totalRaw = data.hits?.total;
    const total = typeof totalRaw === "number" ? totalRaw : Number(totalRaw?.value || 0);
    const items = (data.hits?.hits || [])
        .map((hit) => hit._source)
        .filter((src): src is SalesHistorySearchDocument => Boolean(src));
    return { items, total, backend: "elasticsearch" };
    // ponytail: deep paging dibatasi index.max_result_window ES (default 10000). Cukup untuk pencarian produk; upgrade ke search_after bila perlu telusur >10k baris.
}

export async function searchSalesHistoryRefsWithElasticsearch(input: {
    query: string;
    filters: SalesHistorySearchFilters;
    limit: number;
    offset: number;
}): Promise<SalesHistoryElasticResult | null> {
    const config = getSalesHistoryElasticsearchConfig();
    const query = normalizeSearchText(input.query);
    if (!config || !query) return null;

    if (!await indexExists(config)) return null;

    const filter = buildElasticFilter(input.filters);

    const response = await fetch(indexUrl(config, "/_search"), {
        method: "POST",
        headers: elasticsearchHeaders(config),
        body: JSON.stringify({
            from: input.offset,
            size: input.limit,
            track_total_hits: true,
            collapse: { field: "referensi" },
            aggs: {
                invoiceCount: { cardinality: { field: "referensi" } },
            },
            query: {
                bool: {
                    filter,
                    must: [{
                        multi_match: {
                            query,
                            type: "bool_prefix",
                            operator: "and",
                            fuzziness: "AUTO",
                            fields: ["namaProduk^4", "kodeObjek^3"],
                        },
                    }],
                },
            },
            sort: [{ _score: "desc" }, { tanggal: "desc" }],
        }),
    });

    if (!response.ok) throw new Error("Pencarian Elasticsearch Sales History gagal.");
    const data = (await response.json()) as {
        aggregations?: { invoiceCount?: { value?: number } };
        hits?: {
            total?: number | { value?: number };
            hits?: Array<{ _source?: { referensi?: string } }>;
        };
    };

    const total = Number(data.aggregations?.invoiceCount?.value || 0);
    const refs = (data.hits?.hits || [])
        .map((hit) => hit._source?.referensi)
        .filter((ref): ref is string => Boolean(ref));
    return { refs, total, backend: "elasticsearch" };
}
