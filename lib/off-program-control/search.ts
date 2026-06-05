/*
 * Tujuan: Normalisasi string pencarian OFF Program Control dan adapter Elasticsearch untuk pencarian lintas field.
 * Caller: page.tsx (search monitor), route batches (searchText query dan Elasticsearch lookup).
 * Dependensi: program-type normalizeProgramType, Elasticsearch REST API opsional via env `ELASTICSEARCH_URL`.
 * Main Functions: normalizeSearchText, buildSearchHaystack, matchesSearch, searchOffBatchIdsWithElasticsearch.
 * Side Effects: HTTP call ke Elasticsearch dan bulk upsert dokumen pencarian bila Elasticsearch dikonfigurasi.
 *
 * Aturan revisi (D):
 * - trim, lowercase, hilangkan double spaces.
 * - dukung sebagian kata (substring).
 * - dukung typo ringan khusus Visibility/Visibilty (lewat program-type).
 */

import { normalizeProgramType } from "./program-type";

export type OffSearchDocument = {
  id: string;
  noPengajuan?: string | null;
  noClaim?: string | null;
  principal?: string | null;
  principalCode?: string | null;
  status?: string | null;
  smStatus?: string | null;
  claimStatus?: string | null;
  omStatus?: string | null;
  financeStatus?: string | null;
  finalStatus?: string | null;
  period?: string | null;
  division?: string | null;
  actor?: string | null;
  searchText: string;
};

export type ElasticsearchSearchResult = {
  ids: string[];
  backend: "elasticsearch";
};

/** trim + lowercase + collapse multiple spaces. */
export function normalizeSearchText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Bangun haystack pencarian dari kumpulan field. Nilai null/undefined diabaikan.
 * Jika field mengandung tipe program, tambahkan juga bentuk ternormalisasi agar
 * pencarian "visibilty" tetap menemukan data "Visibility".
 */
export function buildSearchHaystack(parts: Array<unknown>): string {
  const tokens: string[] = [];
  for (const part of parts) {
    const text = normalizeSearchText(part);
    if (!text) continue;
    tokens.push(text);
    const normalizedType = normalizeProgramType(part);
    if (normalizedType) tokens.push(normalizeSearchText(normalizedType));
  }
  return tokens.join(" ");
}

/**
 * Cek apakah haystack cocok dengan query.
 * - Query dipecah jadi term; semua term harus muncul (AND) sebagai substring.
 * - Mendukung typo Visibility: bila sebuah term ternormalisasi ke tipe program,
 *   maka bentuk normalisasi juga dicocokkan.
 */
export function matchesSearch(haystack: string, query: string): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;
  const terms = normalizedQuery.split(" ").filter(Boolean);
  return terms.every((term) => {
    if (haystack.includes(term)) return true;
    const normalizedType = normalizeProgramType(term);
    if (normalizedType && haystack.includes(normalizeSearchText(normalizedType))) {
      return true;
    }
    return false;
  });
}

function elasticsearchConfig() {
  const url = process.env.ELASTICSEARCH_URL?.replace(/\/+$/, "");
  if (!url) return null;

  return {
    url,
    index: process.env.ELASTICSEARCH_OFF_INDEX || "off-program-control-batches",
    apiKey: process.env.ELASTICSEARCH_API_KEY || "",
    username: process.env.ELASTICSEARCH_USERNAME || "",
    password: process.env.ELASTICSEARCH_PASSWORD || "",
  };
}

function elasticsearchHeaders(config: ReturnType<typeof elasticsearchConfig>) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (!config) return headers;
  if (config.apiKey) {
    headers.Authorization = `ApiKey ${config.apiKey}`;
  } else if (config.username || config.password) {
    headers.Authorization = `Basic ${Buffer.from(
      `${config.username}:${config.password}`,
    ).toString("base64")}`;
  }
  return headers;
}

async function ensureOffSearchIndex(
  config: NonNullable<ReturnType<typeof elasticsearchConfig>>,
) {
  await fetch(`${config.url}/${encodeURIComponent(config.index)}`, {
    method: "PUT",
    headers: elasticsearchHeaders(config),
    body: JSON.stringify({
      settings: {
        analysis: {
          analyzer: {
            off_search_analyzer: {
              tokenizer: "standard",
              filter: ["lowercase", "asciifolding"],
            },
          },
        },
      },
      mappings: {
        properties: {
          noPengajuan: { type: "text", analyzer: "off_search_analyzer" },
          noClaim: { type: "text", analyzer: "off_search_analyzer" },
          principal: { type: "text", analyzer: "off_search_analyzer" },
          principalCode: { type: "text", analyzer: "off_search_analyzer" },
          status: { type: "text", analyzer: "off_search_analyzer" },
          smStatus: { type: "text", analyzer: "off_search_analyzer" },
          claimStatus: { type: "text", analyzer: "off_search_analyzer" },
          omStatus: { type: "text", analyzer: "off_search_analyzer" },
          financeStatus: { type: "text", analyzer: "off_search_analyzer" },
          finalStatus: { type: "text", analyzer: "off_search_analyzer" },
          period: { type: "text", analyzer: "off_search_analyzer" },
          division: { type: "text", analyzer: "off_search_analyzer" },
          actor: { type: "text", analyzer: "off_search_analyzer" },
          searchText: { type: "text", analyzer: "off_search_analyzer" },
        },
      },
    }),
  }).catch(() => undefined);
}

async function syncOffSearchDocuments(
  config: NonNullable<ReturnType<typeof elasticsearchConfig>>,
  documents: OffSearchDocument[],
) {
  if (documents.length === 0) return;
  const body = documents
    .flatMap((document) => [
      { index: { _index: config.index, _id: document.id } },
      document,
    ])
    .map((line) => JSON.stringify(line))
    .join("\n");

  const response = await fetch(`${config.url}/_bulk?refresh=true`, {
    method: "POST",
    headers: elasticsearchHeaders(config),
    body: `${body}\n`,
  });
  if (!response.ok) {
    throw new Error("Bulk Elasticsearch OFF gagal.");
  }
}

export async function searchOffBatchIdsWithElasticsearch(input: {
  query: string;
  documents: OffSearchDocument[];
}): Promise<ElasticsearchSearchResult | null> {
  const config = elasticsearchConfig();
  const query = normalizeSearchText(input.query);
  if (!config || !query) return null;

  await ensureOffSearchIndex(config);
  await syncOffSearchDocuments(config, input.documents);

  const response = await fetch(`${config.url}/${config.index}/_search`, {
    method: "POST",
    headers: elasticsearchHeaders(config),
    body: JSON.stringify({
      size: Math.max(50, input.documents.length),
      query: {
        multi_match: {
          query,
          operator: "and",
          fuzziness: "AUTO",
          fields: [
            "noPengajuan^4",
            "noClaim^4",
            "principal^3",
            "principalCode^3",
            "status^2",
            "smStatus^2",
            "claimStatus^2",
            "omStatus^2",
            "financeStatus^2",
            "finalStatus^2",
            "period^2",
            "division",
            "actor",
            "searchText",
          ],
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error("Pencarian Elasticsearch OFF gagal.");
  }
  const data = (await response.json()) as {
    hits?: { hits?: Array<{ _id?: string }> };
  };
  const ids = (data.hits?.hits || [])
    .map((hit) => hit._id)
    .filter((id): id is string => Boolean(id));

  return { ids, backend: "elasticsearch" };
}
