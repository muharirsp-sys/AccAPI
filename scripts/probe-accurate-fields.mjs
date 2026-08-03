/**
 * Tujuan: Menyingkap nama field RESPONSE Accurate yang tidak didokumentasikan di OpenAPI
 *         (acc.json.do.txt: 321 endpoint, nol response schema). Ambil 1-2 baris per endpoint
 *         lalu cetak daftar key-nya.
 * Caller: Developer saat menambah entitas ke lib/sync.ts dan perlu tahu nama field aslinya.
 * Dependensi: pg, DATABASE_URL, BETTER_AUTH_SECRET (untuk dekripsi token), sesi OAuth Accurate aktif.
 * Main Functions: decryptSecret (mirror lib/accurate-session.ts), probe per endpoint.
 * Side Effects: HTTP GET read-only ke Accurate. Token TIDAK pernah dicetak.
 *
 * Jalankan: node scripts/probe-accurate-fields.mjs
 *           node scripts/probe-accurate-fields.mjs "/item/list-stock.do"   # satu endpoint saja
 */
import pg from "pg";
import { createDecipheriv, createHash } from "node:crypto";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl?.startsWith("postgres")) throw new Error("DATABASE_URL PostgreSQL wajib di-set.");

const secret = process.env.ACCURATE_TOKEN_ENCRYPTION_KEY || process.env.BETTER_AUTH_SECRET || process.env.AUTH_SECRET;
if (!secret) throw new Error("ACCURATE_TOKEN_ENCRYPTION_KEY / BETTER_AUTH_SECRET wajib di-set.");

// Mirror lib/accurate-session.ts — format tersimpan: `<iv>.<tag>.<ciphertext>` base64, aes-256-gcm.
function decryptSecret(value) {
    const [iv, tag, data] = value.split(".");
    if (!iv || !tag || !data) throw new Error("Token Accurate tersimpan tidak valid.");
    const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

// Endpoint yang field response-nya masih tanda tanya (lib/sync.ts:148 + kebutuhan Web Sales).
const PROBES = [
    { path: "/item/list-stock.do", query: { "sp.pageSize": 2 } },
    { path: "/customer/list.do", query: { "sp.pageSize": 2, fields: "id,customerNo,name,balance,customerLimitAmount,customerLimitAmountValue,customerLimitAge,customerLimitAgeValue,termName,lastUpdate" } },
    { path: "/sales-invoice/list.do", query: { "sp.pageSize": 2, outstandingFilter: "true" } },
    { path: "/item/detail.do", query: {} }, // butuh id — diisi dari hasil item/list-stock kalau ada
];

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });
const row = (await pool.query(
    `SELECT access_token, session_host, session_id, database_id, database_alias
     FROM accurate_oauth_session ORDER BY updated_at DESC NULLS LAST LIMIT 1`
)).rows[0];
await pool.end();

if (!row) throw new Error("Belum ada sesi OAuth Accurate di DB. Login dulu di halaman /api-wrapper.");
const token = decryptSecret(row.access_token);

// database_id bisa kosong: callback OAuth menyimpan token lalu me-null-kan database_id, dan
// pemilihan database dilakukan terpisah lewat UI. Probe ini tidak butuh UI itu — resolve sendiri.
if (!row.database_id) {
    const listRes = await fetch("https://account.accurate.id/api/db-list.do", {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
    });
    const listBody = await listRes.json().catch(() => null);
    const dbs = listBody?.d ?? [];
    if (!listRes.ok || !dbs.length) {
        throw new Error(`db-list.do gagal (${listRes.status}): ${JSON.stringify(listBody)?.slice(0, 300)}`);
    }
    console.log(`Database tersedia: ${dbs.map((d) => `${d.id}=${d.alias}`).join(", ")}`);
    row.database_id = dbs[0].id;
    row.database_alias = dbs[0].alias;
}
console.log(`Pakai database: ${row.database_alias} (id ${row.database_id})`);

// X-Session-ID cepat kadaluarsa ("Data Session Key tidak tepat"). Ambil yang baru lewat
// open-db.do — sama seperti app/api/auth/open-db/route.ts, tapi hasilnya HANYA dipakai di
// memori: probe ini tidak menulis apa pun ke DB produksi.
const openRes = await fetch(`https://account.accurate.id/api/open-db.do?id=${row.database_id}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
});
const openBody = await openRes.json().catch(() => null);
if (!openRes.ok || !openBody?.host || !openBody?.session) {
    throw new Error(`open-db.do gagal (${openRes.status}): ${JSON.stringify(openBody)?.slice(0, 300)}
Access token kemungkinan sudah kadaluarsa — login ulang di /api-wrapper.`);
}
row.session_host = openBody.host;
row.session_id = openBody.session;
console.log(`Sesi baru: ${row.session_host}\n`);

// Mode `--fields <endpoint>`: list.do tanpa `fields` hanya balas { id }, jadi nama field
// harus ditebak lalu diuji satu per satu. Accurate menolak field yang tidak dikenal, jadi
// respons sukses = field itu memang ada.
if (process.argv[2] === "--fields") {
    const path = process.argv[3] || "/sales-invoice/list.do";
    const candidates = (process.argv[4] || [
        "number", "transDate", "dueDate", "totalAmount", "outstanding", "outstandingAmount",
        "remainingAmount", "paidAmount", "status", "statusName", "age", "paymentTermName",
        "customerNo", "customerName", "customer", "branchName", "lastUpdate", "printed",
    ].join(",")).split(",");

    const ada = [], tidak = [];
    for (const f of candidates) {
        const res = await fetch(`${row.session_host}/accurate/api${path}?sp.pageSize=1&fields=id,${f}`, {
            headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "X-Session-ID": row.session_id },
            signal: AbortSignal.timeout(30_000),
        });
        const b = await res.json().catch(() => null);
        const first = Array.isArray(b?.d) ? b.d[0] : null;
        if (b?.s && first && f in first) ada.push(`${f} = ${JSON.stringify(first[f])}`);
        else tidak.push(`${f} (${b?.s ? "diterima tapi kosong" : JSON.stringify(b?.d)?.slice(0, 80)})`);
    }
    console.log(`\n=== ${path} — field VALID:`);
    for (const a of ada) console.log(`  ${a}`);
    console.log(`\n=== TIDAK ADA:`);
    for (const t of tidak) console.log(`  ${t}`);
    process.exit(0);
}

const only = process.argv[2];

for (const probe of PROBES.filter((p) => !only || p.path === only)) {
    const qs = new URLSearchParams(Object.entries(probe.query).map(([k, v]) => [k, String(v)]));
    // Accurate tidak mem-parse %2C untuk fields — harus koma literal (lihat app/api/proxy/route.ts:38).
    const url = `${row.session_host}/accurate/api${probe.path}${qs.size ? `?${qs.toString().replace(/%2C/g, ",")}` : ""}`;

    process.stdout.write(`=== ${probe.path}\n`);
    try {
        const res = await fetch(url, {
            headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "X-Session-ID": row.session_id },
            signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        let body;
        try { body = JSON.parse(text); } catch { console.log(`  non-JSON (${res.status}): ${text.slice(0, 300)}\n`); continue; }

        if (!body.s) { console.log(`  GAGAL (${res.status}): ${JSON.stringify(body).slice(0, 400)}\n`); continue; }

        const first = Array.isArray(body.d) ? body.d[0] : body.d;
        if (!first) { console.log("  kosong — tidak ada data untuk disimpulkan\n"); continue; }
        console.log(`  keys: ${Object.keys(first).join(", ")}`);
        console.log(`  contoh: ${JSON.stringify(first, null, 2).split("\n").slice(0, 40).join("\n  ")}\n`);
    } catch (err) {
        console.log(`  ERROR: ${err.message}\n`);
    }
}
