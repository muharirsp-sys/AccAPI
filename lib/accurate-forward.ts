/**
 * Tujuan: Satu bentuk kabel request ke host Accurate, dipakai proxy generik dan command
 *   server (purchase-payment) agar keduanya tidak bisa berbeda diam-diam.
 * Caller: app/api/proxy/route.ts, app/api/finance/purchase-payment/route.ts.
 * Dependensi: fetch global.
 * Main Functions: flattenPayload, buildAccurateRequest, forwardAccurate, forwardAccurateBaca, bacaAccurate, isGuardedAccurateWrite,
 *   isSalesReceiptWrite, isSalesInvoiceWrite, isCustomerWrite, isAccurateRead, isCatalogWrite, jawaban401.
 * Dependensi tambahan: config/accurateRoutes.js (katalog Konsol — sumber yang sama dengan UI /api-wrapper), lib/accurate-401.
 * Side Effects: forwardAccurate = HTTP ke host Accurate (timeout 30 s, redirect manual).
 */
import { accurateRoutes } from "@/config/accurateRoutes";
import { TokenAccurateMati, galat401 } from "@/lib/accurate-401";

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
    return { status: response.status, text: await response.text(), retryAfter: response.headers.get("retry-after") };
}

const tidur = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/**
 * Batas Accurate: 8 request/detik dan 8 proses paralel PER TOKEN (lib/accurate-baca). Token sesi user bisa sama dengan token
 * sinkron (ACCURATE_SYNC_USER_ID: webhook, kasir), jadi BACA lewat sini dijatah ≤ 5/detik per sesi dan batas laju diulang.
 * Bukti 27 Nov 2026: riwayat pelunasan 4 jalur tanpa jeda → 29 dari 47 baris ditahan "Accurate HTTP 429", paket tidak terkirim.
 * ponytail: jatah per proses (satu container); lebih dari satu replika = jatah dikali replika.
 */
const JARAK_BACA_MS = 200;
const ULANG_BATAS_LAJU_MS = [1000, 2000, 4000, 6000];
const giliranBaca = new Map<string, number>();
async function giliran(kunci: string, tunggu: (ms: number) => Promise<void>) {
    const sekarang = Date.now();
    const t = Math.max(sekarang, giliranBaca.get(kunci) ?? 0);
    giliranBaca.set(kunci, t + JARAK_BACA_MS);
    if (giliranBaca.size > 200) for (const [k, v] of giliranBaca) if (v < sekarang) giliranBaca.delete(k);
    if (t > sekarang) await tunggu(t - sekarang);
}
/** 429, atau penolakan berbadan "melebihi toleransi … request per detik" (bentuk yang ditangani lib/accurate-baca). */
function kenaBatasLaju(status: number, text: string) {
    if (status === 429) return true;
    if (status >= 500 || !/melebihi toleransi|request per detik/i.test(text)) return false;
    try { return (JSON.parse(text) as { s?: unknown }).s !== true; } catch { return true; }
}

/**
 * GET BACA dengan jatah per sesi + ulang saat batas laju (≤ 4×, Retry-After dihormati s.d. 10 dtk); jawaban terakhir apa adanya.
 * HANYA baca: tulis tidak pernah diulang di sini (bisa terposting ganda). `tunggu` diinjeksi untuk uji.
 */
export async function forwardAccurateBaca(target: AccurateTarget, endpointPath: string, payload: unknown, tunggu = tidur) {
    for (let coba = 0; ; coba++) {
        await giliran(`${target.sessionHost}|${target.sessionId}`, tunggu);
        const r = await forwardAccurate(target, endpointPath, "GET", payload);
        if (coba >= ULANG_BATAS_LAJU_MS.length || !kenaBatasLaju(r.status, r.text)) return r;
        const detik = Number(r.retryAfter);
        await tunggu(Math.max(ULANG_BATAS_LAJU_MS[coba], Number.isFinite(detik) && detik > 0 ? Math.min(detik, 10) * 1000 : 0));
    }
}

/**
 * Pembaca Accurate BACA-SAJA di server dengan sesi `target` (S6e-2: riwayat sales-receipt, Selesaikan). Hanya GET;
 * status non-2xx / bukan JSON / timeout 30 dtk = melempar (pemanggil memperlakukannya sebagai TIDAK TERBACA). 401 = pesan tetap
 * token kedaluwarsa / sesi habis (lib/accurate-401); badannya tidak dibawa. Batas laju diulang dulu (forwardAccurateBaca).
 */
export function bacaAccurate(target: AccurateTarget, tunggu = tidur) {
    return async (endpointPath: string, method: string, payload?: unknown) => {
        if (String(method).toUpperCase() !== "GET") throw new Error("bacaAccurate hanya GET");
        const r = await forwardAccurateBaca(target, endpointPath, payload, tunggu);
        if (r.status === 401) throw galat401(r.text);
        if (r.status < 200 || r.status >= 300) throw new Error(`Accurate HTTP ${r.status}`);
        try {
            return JSON.parse(r.text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- JSON Accurate bebas bentuk (AccurateFetch)
        } catch {
            throw new Error("jawaban Accurate bukan JSON");
        }
    };
}

/**
 * Jawaban proxy untuk HTTP 401 Accurate, pengganti badan aslinya (menggemakan access token; dulu `{"error":"invalid_token"}`
 * diteruskan apa adanya, atau 1000 huruf pertamanya bila bukan JSON). Amplop `{s:false, d:[pesan]}` = ditolak Accurate, tidak
 * terkirim (lib/apiFetcher): 401 ditolak di lapis otorisasi sebelum dokumen diproses.
 */
export function jawaban401(badan: string) {
    const galat = galat401(badan);
    return { s: false, d: [galat.message], error: galat.message, code: galat instanceof TokenAccurateMati ? "ACCURATE_TOKEN_MATI" : "ACCURATE_SESI_HABIS" };
}

/** Pesan 504 proxy (tinjauan S6-0a): tulis Accurate yang timeout = status TIDAK PASTI — jangan menyuruh mengulang. */
export function accurateTimeoutMessage(method: string) {
    return String(method).toUpperCase() === "GET"
        ? "Accurate tidak merespons dalam 30 detik (timeout). Coba lagi."
        : "Accurate tidak merespons dalam 30 detik (timeout). Status tulis TIDAK PASTI: periksa di Accurate sebelum mengirim ulang.";
}

/**
 * S7-1b (AM-024): BACA lewat proxy generik = method GET ke jalur KANONIK `/api/<sumber>/{list,detail,get-stock,list-stock}.do`
 * (hanya yang dipakai pemanggil sah — Konsol, parser retur pembelian, Pelunasan, Finance; `git grep`). Selain itu = TULIS
 * (fail-closed). ponytail: pola kanonik (huruf kecil/angka/"-" per segmen, tanpa `.`, `%`, `;`, `\`, `//`, spasi, query)
 * lebih ketat daripada normalisasi matchesWritePath — path yang dinormalkan host (dot-segment, encoding, ;param, huruf besar)
 * tidak pernah lolos sebagai baca, jadi cara host men-decode tidak perlu ditiru.
 */
const JALUR_BACA = /^\/api(?:\/[a-z0-9-]+)+\/(?:list|detail|get-stock|list-stock)\.do$/;
export function isAccurateRead(endpointPath: string, method: string) {
    return String(method).toUpperCase() === "GET" && JALUR_BACA.test(String(endpointPath));
}

/**
 * PK-3 (owner 12 Okt 2026): tulis lewat proxy generik hanya ke save.do / bulk-save.do yang ADA di katalog Konsol
 * (config/accurateRoutes.js — satu sumber dengan UI, tidak disalin) dengan method katalog, path PERSIS. `*\/delete.do`,
 * endpoint tak dikenal, dan varian path (encoding, `./`, `//`, huruf besar, query) di luar katalog.
 */
const KATALOG_TULIS: ReadonlySet<string> = new Set(Object.values(accurateRoutes as Record<string, { method: string; path: string }>)
    .filter((r) => r.method.toUpperCase() !== "GET" && /\/(?:bulk-)?save\.do$/.test(r.path))
    .map((r) => `${r.method.toUpperCase()} ${r.path}`));
export function isCatalogWrite(endpointPath: string, method: string) {
    return KATALOG_TULIS.has(`${String(method).toUpperCase()} ${String(endpointPath)}`);
}

/**
 * Tulis Accurate yang hanya boleh lewat command server ber-klaim (AM-014 / C.14): proxy generik
 * menolaknya agar guard pengiriman ganda tidak bisa dilewati dari browser.
 * Tulis lain lewat proxy: `api_wrapper.execute` + katalog (isAccurateRead / isCatalogWrite, S7-1b).
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

/**
 * S6-0d E4 (owner 9 Okt 2026): faktur penjualan hanya lewat Antrean Faktur — klaim atomik, riwayat
 * per percobaan, pencarian sebelum kirim ulang (lib/invoice-sender). Proxy generik menolak tulisnya
 * (pola D-06 purchase-payment); normalisasi path sama, path rusak/";" = dianggap tulis.
 */
export function isSalesInvoiceWrite(endpointPath: string) {
    return matchesWritePath(endpointPath, /\/sales-invoice\/(bulk-)?save\.do/i, "sales-invoice");
}

/**
 * Owner 13 Nov 2026: tulis pelanggan (juga pos/customer) diperiksa lib/pelanggan-terlindungi sebelum diteruskan —
 * 9 toko NKA/DC tidak boleh dinonaktifkan atau diberi batas piutang / batas umur piutang. Normalisasi sama (fail-closed).
 */
export function isCustomerWrite(endpointPath: string) {
    return matchesWritePath(endpointPath, /\/customer\/(bulk-)?save\.do/i, "customer");
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
