/**
 * Universal Fetcher for Accurate API
 * Proxies Accurate requests through the server-side Accurate session.
 */
export class AccurateError extends Error {
    rawDetails?: any[];
    rawErrorObject?: any;
    constructor(message: string, rawDetails?: any[], rawErrorObject?: any) {
        super(message);
        this.name = "AccurateError";
        this.rawDetails = rawDetails;
        this.rawErrorObject = rawErrorObject;
    }
}

export async function accurateFetch(endpointPath: string, method: string, payload?: unknown) {
    if (typeof window === "undefined") {
        throw new Error("accurateFetch hanya bisa dijalankan di client-side.");
    }

    try {
        const response = await fetch("/api/proxy", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                endpointPath,
                method: method.toUpperCase(),
                payload: payload || null,
            }),
        });

        const data = await response.json();

        // Accurate bulk-save operations sometimes return an Array instead of {s, d}
        const isBulkArrayResult = Array.isArray(data);
        if (!response.ok || (!isBulkArrayResult && !data.s)) {
            let errorMsg = "";
            let rawDetails: any[] | undefined = undefined;
            
            if (isBulkArrayResult) {
                rawDetails = data;
                errorMsg = `Bulk Request gagal dengan ${data.filter((r: any) => !r.s).length} error.`;
            } else if (data.d && Array.isArray(data.d) && data.d.length > 0) {
                // If it's a single object {s: false, d: ["..."]}, we still want frontend to have access to it
                rawDetails = [data]; // Wrap it in array so the length is at least 1 for the loop
                errorMsg = typeof data.d[0] === 'object' ? JSON.stringify(data.d[0], null, 2) : String(data.d[0]);
            } else {
                errorMsg = data.error || data.message || `[RAW JSON] ${JSON.stringify(data)}`;
            }

            if (data.detail) {
                errorMsg += `\n\n[INFO TAMBAHAN]: ${data.detail}`;
            }
            throw new AccurateError(errorMsg, rawDetails, data);
        }

        return data;
    } catch (err: unknown) {
        if (err instanceof AccurateError) {
            throw err;
        }
        if (err instanceof Error) {
            throw new Error(err.message || "Terjadi kesalahan jaringan.");
        }
        throw new Error("Terjadi kesalahan jaringan.");
    }
}

/**
 * Hasil tulis Accurate (AM-014, ADR-002). `rejected` = Accurate menjawab dan menolak (aman
 * diperbaiki lalu diulang). `unknown` = Accurate MUNGKIN sudah menyimpan — jangan diulang buta.
 */
export type WriteOutcome =
    | { kind: "posted"; id: string; number: string }
    | { kind: "rejected"; message: string }
    | { kind: "unknown"; message: string };

type Item = { s?: unknown; d?: unknown; r?: { id?: unknown; number?: unknown } };

/** Jawaban sukses accurateFetch untuk bulk-save: `[{s,r,d}]` atau `{s, d:[{s,r,d}]}`. */
export function classifyBulkSaveResponse(data: unknown): WriteOutcome {
    const envelope = (data ?? {}) as { s?: unknown; d?: unknown; r?: Item["r"] };
    const items: Item[] | null = Array.isArray(data) ? data : Array.isArray(envelope.d) ? envelope.d as Item[] : null;
    if (!items) {
        const id = String(envelope.r?.id ?? "");
        return envelope.s === true && id
            ? { kind: "posted", id, number: String(envelope.r?.number ?? "") }
            : { kind: "unknown", message: `respons tanpa hasil per item: ${JSON.stringify(data)?.slice(0, 200)}` };
    }
    if (items.length && items.every((it) => it?.s === false)) {
        return { kind: "rejected", message: JSON.stringify(items[0]?.d ?? items[0]).slice(0, 500) };
    }
    const first = items[0];
    const id = String(first?.r?.id ?? "");
    if (items.length && items.every((it) => it?.s === true && String(it.r?.id ?? ""))) {
        return { kind: "posted", id, number: String(first.r?.number ?? "") };
    }
    // Sebagian masuk / sukses tanpa id: sebagian mungkin SUDAH ada di Accurate.
    return { kind: "unknown", message: `hasil bulk-save tidak lengkap: ${JSON.stringify(items).slice(0, 300)}` };
}

/** Error dari accurateFetch: hanya amplop penolakan Accurate `{s:false, d}` yang `rejected`. */
export function classifyWriteError(err: unknown): WriteOutcome {
    const message = err instanceof Error ? err.message : String(err);
    // ponytail: proxy selalu menjawab HTTP 200 untuk JSON apa pun dari Accurate, jadi status
    // upstream tidak terlihat di sini; amplop s:false dianggap penolakan bisnis (dokumen Accurate:
    // penolakan = HTTP 200 + s:false). Teruskan status upstream bila 5xx beramplop pernah muncul.
    const raw = err instanceof AccurateError ? (err.rawErrorObject as { s?: unknown; d?: unknown } | undefined) : undefined;
    const isEnvelopeRejection = raw?.s === false && raw.d !== undefined;
    const bulkRejection = err instanceof AccurateError && Array.isArray(err.rawDetails) && err.rawDetails.length > 0
        && err.rawDetails.every((it) => (it as Item)?.s === false);
    return isEnvelopeRejection || bulkRejection ? { kind: "rejected", message } : { kind: "unknown", message };
}
