/*
 * Tujuan: Probe endpoint Accurate mana pun secara read-only untuk MENEMUKAN nama field.
 *         Spec resmi Accurate tidak punya response schema sama sekali (lihat
 *         docs/prd/ACCURATE_API_REFERENCE.md), jadi field hanya bisa dipastikan dari
 *         panggilan live. Pakai ini sebelum menulis kode yang mengandalkan nama field.
 * Caller: developer, manual.
 * Dependensi: lib/accurate-session (dekripsi token + refresh X-Session-ID), .env.local.
 * Main Functions: run — GET/POST satu endpoint, cetak amplop {s, sp, d}.
 * Side Effects: Hanya baca. Token TIDAK pernah dicetak.
 *
 * Pakai (endpoint tanpa "/" di depan supaya Git Bash tidak mengubahnya jadi path Windows;
 * tiap parameter query sebagai argumen terpisah karena "&" dipecah shell):
 *   npx tsx --env-file=.env.local scripts/probe-accurate-endpoint.ts item/detail.do id=11900 pick=detailSellingPrice max=2000
 *   npx tsx --env-file=.env.local scripts/probe-accurate-endpoint.ts branch/list.do fields=id,name,defaultBranch
 * Tambahkan argumen `post` untuk POST form-encoded.
 * Catatan: --env-file WAJIB; process.loadEnvFile kalah cepat dari hoisting import.
 */
import { resolveSyncCredentials } from "@/lib/accurate-session";

// tsx tidak memuat .env.local sendiri; tanpa ini DATABASE_URL kosong.
try { process.loadEnvFile(".env.local"); } catch { /* biarkan env dari luar dipakai */ }

async function run() {
    // Query dikirim sebagai argumen terpisah: "&" di satu argumen dipecah oleh shell Windows.
    const [rawPath, ...rest] = process.argv.slice(2);
    const maxCharsArg = rest.findIndex((item) => /^max=\d+$/.test(item));
    const maxChars = maxCharsArg >= 0 ? Number(rest[maxCharsArg].slice(4)) : 2500;
    const pickArg = rest.findIndex((item) => item.startsWith("pick="));
    const pick = pickArg >= 0 ? rest[pickArg].slice(5) : "";
    const params = rest.filter((_, index) => index !== maxCharsArg && index !== pickArg);
    // Git Bash mengubah argumen berawalan "/" menjadi path Windows; terima tanpa slash.
    const endpoint = rawPath?.startsWith("/") ? rawPath : `/${rawPath}`;
    const path = params.length ? `${endpoint}?${params.join("&")}` : endpoint;
    if (!rawPath) {
        console.error('Pakai: npx tsx scripts/_probe_accurate.ts "/modul/aksi.do?param=..."');
        process.exit(1);
    }
    const resolved = await resolveSyncCredentials();
    if (!resolved.creds) {
        console.error("Kredensial Accurate tidak tersedia:", resolved.error);
        process.exit(1);
    }
    const { sessionHost, sessionId, apiKey } = resolved.creds;
    // post= memakai form-encoded, bentuk yang dipakai Accurate untuk aksi non-list.
    const isPost = params.some((item) => item === "post");
    const query = params.filter((item) => item !== "post");
    const target = isPost ? `${sessionHost}/accurate/api${endpoint}` : `${sessionHost}/accurate/api${path}`;
    const res = await fetch(target, {
        method: isPost ? "POST" : "GET",
        headers: {
            Authorization: `Bearer ${apiKey}`, "X-Session-ID": sessionId,
            ...(isPost ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: isPost ? query.join("&") : undefined,
    });
    const text = await res.text();
    console.log("HTTP", res.status, "|", path);
    try {
        const body = JSON.parse(text);
        console.log("s:", body.s, body.sp ? `| sp: ${JSON.stringify(body.sp)}` : "");
        // detail.do mengembalikan ratusan field; pick= memotong ke satu field saja.
        const picked = pick && body.d && typeof body.d === "object" ? (body.d as Record<string, unknown>)[pick] : (body.d ?? body);
        console.log(pick ? `pick=${pick}:` : "", JSON.stringify(picked, null, 1).slice(0, maxChars));
    } catch {
        console.log(text.slice(0, maxChars));
    }
    process.exit(0);
}

run();
