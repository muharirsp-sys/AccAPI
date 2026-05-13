/**
 * Universal Fetcher for Accurate API
 * Retrieves API key directly from sessionStorage to avoid keeping it in .env
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

    const apiKey = sessionStorage.getItem("accurateApiKey");
    const sessionHost = sessionStorage.getItem("accurateHost");
    const sessionId = sessionStorage.getItem("accurateSession");

    if (!apiKey || !sessionHost || !sessionId) {
        throw new Error("Kredensial tidak lengkap. Pastikan Anda sudah login dan memilih Database Accurate.");
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
                sessionHost,
                sessionId,
                apiKey
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
