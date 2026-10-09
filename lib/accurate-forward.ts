/**
 * Tujuan: Satu bentuk kabel request ke host Accurate, dipakai proxy generik dan command
 *   server (purchase-payment) agar keduanya tidak bisa berbeda diam-diam.
 * Caller: app/api/proxy/route.ts, app/api/finance/purchase-payment/route.ts.
 * Dependensi: fetch global.
 * Main Functions: flattenPayload, buildAccurateRequest, forwardAccurate, isGuardedAccurateWrite.
 * Side Effects: forwardAccurate = HTTP ke host Accurate (timeout 30 s, redirect manual).
 */

// Helper untuk nge-flatten JSON bersarang atau array ke dalam format properti dot/bracket (data[0].key)
export const flattenPayload = (obj: unknown, prefix = ""): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    if (typeof obj !== "object" || obj === null) return result;
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const source = obj as Record<string, unknown>;
            const newKey = prefix ? (Array.isArray(obj) ? `${prefix}[${key}]` : `${prefix}.${key}`) : key;
            if (typeof source[key] === "object" && source[key] !== null && !(source[key] instanceof Date)) {
                Object.assign(result, flattenPayload(source[key], newKey));
            } else {
                result[newKey] = source[key];
            }
        }
    }
    return result;
};

export type AccurateTarget = { sessionHost: string; sessionId: string; accessToken: string };

/** Path persis yang dikirim ke host (dipakai request DAN gate — satu sumber, review sesi 2 H1). */
const wirePath = (endpointPath: string) => `/accurate/api${String(endpointPath).replace("/api", "")}`;

export function buildAccurateRequest(target: AccurateTarget, endpointPath: string, method: string, payload: unknown) {
    const verb = method.toUpperCase();
    // Berdasarkan Swagger, Base URL Accurate adalah https://{host}/accurate
    let url = `${target.sessionHost}${wirePath(endpointPath)}`;
    if (verb === "GET" && payload) {
        const query = new URLSearchParams();
        Object.keys(payload as Record<string, unknown>).forEach((key) => {
            const val = (payload as Record<string, unknown>)[key];
            if (val !== undefined && val !== null) query.append(key, String(val));
        });
        // Accurate API doesn't parse %2C properly for comma-separated fields, it expects literal commas
        url = `${url}?${query.toString().replace(/%2C/g, ",")}`;
    }
    let body: string | undefined;
    if (verb !== "GET" && payload) {
        // Payload Array + bulk-save: Accurate memaksa bentuk { "data[0].field": "value", ... }
        body = endpointPath.includes("bulk-save.do") && Array.isArray(payload)
            ? JSON.stringify(flattenPayload(payload, "data"))
            : JSON.stringify(payload);
    }
    const init: RequestInit = {
        method: verb,
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Authorization": `Bearer ${target.accessToken}`,
            "X-Session-ID": target.sessionId,
        },
        body,
        redirect: "manual",
        // Audit F5: timeout 30s agar request menggantung ke Accurate tidak menahan koneksi tanpa batas.
        signal: AbortSignal.timeout(30_000),
    };
    return { url, init };
}

export async function forwardAccurate(target: AccurateTarget, endpointPath: string, method: string, payload: unknown) {
    const { url, init } = buildAccurateRequest(target, endpointPath, method, payload);
    const response = await fetch(url, init);
    return { status: response.status, text: await response.text() };
}

/** Pesan 504 proxy (tinjauan S6-0a): tulis Accurate yang timeout = status TIDAK PASTI — jangan menyuruh mengulang. */
export function accurateTimeoutMessage(method: string) {
    return String(method).toUpperCase() === "GET"
        ? "Accurate tidak merespons dalam 30 detik (timeout). Coba lagi."
        : "Accurate tidak merespons dalam 30 detik (timeout) — status tulis TIDAK PASTI: periksa di Accurate sebelum mengirim ulang.";
}

/**
 * Tulis Accurate yang hanya boleh lewat command server ber-klaim (AM-014 / C.14): proxy generik
 * menolaknya agar guard pengiriman ganda tidak bisa dilewati dari browser.
 * ponytail: denylist satu operasi; allowlist penuh proxy = AM-024 (butuh keputusan daftar endpoint).
 */
export function isGuardedAccurateWrite(endpointPath: string) {
    return matchesWritePath(endpointPath, /\/purchase-payment\/(bulk-)?save\.do/i, "purchase-payment");
}

/**
 * AM-024 (owner D-18): tulis sales-receipt lewat proxy hanya dengan lock idempotency pemilik
 * (lib/sales-receipt-guard.ts). Normalisasi sama dengan purchase-payment; path rusak/";" = dianggap tulis.
 */
export function isSalesReceiptWrite(endpointPath: string) {
    return matchesWritePath(endpointPath, /\/sales-receipt\/(bulk-)?save\.do/i, "sales-receipt");
}

function matchesWritePath(endpointPath: string, guarded: RegExp, resource: string) {
    // Semua method: tidak ada pemakaian sah GET ke save.do (review sesi 2 M4).
    const raw = String(endpointPath);
    if (raw.includes(";")) return true; // path parameter (;jsessionid=…) bisa diabaikan host Java
    try {
        // ponytail: path ber-"%"/backslash yang setelah decode berulang menyebut resource ini = dianggap tulis
        // (fail-closed) — tidak ada pemanggil sah yang memakainya, jadi cara tiap host men-decode (%5C, encoding
        // ganda) tidak perlu ditiru (re-review d60433f2 LOW). Plafon: allowlist path proxy (AM-024/D-01).
        if (/[%\\]/.test(raw)) {
            let s = raw;
            for (let i = 0; i < 5 && s.includes("%"); i++) s = decodeURIComponent(s);
            if (s.toLowerCase().includes(resource)) return true;
        }
        // Nilai path YANG DIKIRIM (wirePath), dinormalisasi seperti fetch/host: dot-segment (juga
        // %2e), backslash, percent-encoding, "//". Path mentah juga diuji.
        return [wirePath(raw), raw].some((p) =>
            guarded.test(decodeURIComponent(new URL(p.trim(), "http://normalize.invalid").pathname).replace(/\/+/g, "/")));
    } catch {
        return true; // path rusak = tolak (fail-closed)
    }
}
