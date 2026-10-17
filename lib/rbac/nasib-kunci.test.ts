/*
 * S7-1b (AM-042, D-01 §D disetujui owner 11 Okt; keputusan PK 12 Okt): nasib 31 kunci yang dulu tidak ditegakkan server + penjaga
 * statik route tulis. Tabel = brief S7-1b (literal, bukan dihitung) — mengubah nasib = mengubah baris di sini dengan alasan.
 *   tegakkan     = literal kunci muncul di route yang disebut (slice ini);
 *   pensiun      = tidak ada di registry, ada di KUNCI_PENSIUN, tidak dirujuk di app/lib/components/config/scripts/python_backend
 *                  (kecuali SQL docs/handover/ dan berkas uji);
 *   daftar tunggu (tegakkan-1c / pensiun-s7-3 / tunda / tetap) = masih terdaftar, beralasan.
 * Tripwire: kunci registry yang tidak dirujuk server mana pun WAJIB punya baris di sini (atau DI_LUAR_31) — kunci baru tanpa
 * penegakan dan tanpa nasib = merah. Heuristik rujukan = Lampiran A S7-EKSPLORASI (literal "modul.aksi" / Python
 * user_has_permission(user, "modul", "aksi" [if … else "aksi"])).
 * Guard route: setiap HANDLER POST/PUT/PATCH/DELETE di app/api/**\/route.{ts,tsx,js,mjs} memeriksa izin, atau berkasnya di DAFTAR_PUTIH beralasan.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KUNCI_PENSIUN, PERMISSION_REGISTRY, allPermissionKeys, isValidPermissionKey } from "./registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const baca = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

type Nasib = "tegakkan" | "pensiun" | "tegakkan-1c" | "pensiun-s7-3" | "tunda" | "tetap";
const NASIB: Array<{ no: string; kunci: string; nasib: Nasib; di?: string[]; alasan: string }> = [
    { no: "1", kunci: "api_wrapper.execute", nasib: "tegakkan", di: ["app/api/proxy/route.ts"], alasan: "tulis /api/proxy non-sales-receipt (AM-024; PK-1..3)" },
    { no: "2", kunci: "off_program_control.audit_export", nasib: "tegakkan", di: ["app/api/off-program-control/audit/route.ts"], alasan: "GET audit?format=csv = audit_read ∧ audit_export" },
    { no: "3", kunci: "off_program_control.create", nasib: "pensiun", alasan: "diganti kunci granular OPC (create_batch, …); tidak dipetakan" },
    { no: "4", kunci: "off_program_control.update", nasib: "pensiun", alasan: "diganti kunci granular OPC; tidak dipetakan" },
    { no: "5", kunci: "off_program_control.export", nasib: "pensiun", alasan: "diganti audit_export; tidak dipetakan" },
    { no: "6", kunci: "off_program_control.approve", nasib: "pensiun", alasan: "S7-3: profil Beranda dari ★ grup utama; tebakan SM = sm_approve (PK-O2)" },
    { no: "7", kunci: "users.create_user", nasib: "pensiun", alasan: "-> users.manage (D-01 §E)" },
    { no: "8", kunci: "users.edit_user", nasib: "pensiun", alasan: "-> users.manage" },
    { no: "9", kunci: "users.delete_user", nasib: "pensiun", alasan: "-> users.manage" },
    { no: "10", kunci: "users.set_role", nasib: "pensiun", alasan: "-> users.manage" },
    { no: "11", kunci: "users.set_permission", nasib: "pensiun", alasan: "-> users.manage" },
    { no: "12", kunci: "finance.post_accurate", nasib: "tegakkan-1c", alasan: "POST /api/finance/purchase-payment finance.update ∧ post_accurate — S7-1c (PK-O1, zona uang)" },
    { no: "13", kunci: "finance.upload_proof", nasib: "tegakkan-1c", alasan: "Py POST /payments/finance/proof — S7-1c" },
    { no: "14", kunci: "finance.transfer", nasib: "tegakkan-1c", alasan: "Py POST /payments/finance/update jalur can_update — S7-1c" },
    { no: "15", kunci: "finance.export", nasib: "tegakkan-1c", alasan: "Py GET /payments/finance/export — S7-1c" },
    { no: "16", kunci: "payments.create", nasib: "tegakkan-1c", alasan: "Py /payments/manual/add, /payments/cart/create — S7-1c" },
    { no: "17", kunci: "payments.upload", nasib: "tegakkan-1c", alasan: "Py /payments/upload — S7-1c" },
    { no: "18", kunci: "payments.submit", nasib: "tegakkan-1c", alasan: "Py /payments/cart/submit, /payments/submit — S7-1c" },
    { no: "19", kunci: "payments.export", nasib: "tegakkan-1c", alasan: "Py GET /payments/export — S7-1c" },
    { no: "20", kunci: "sppd.generate", nasib: "tegakkan-1c", alasan: "Py dua route render SPPD — S7-1c" },
    { no: "21", kunci: "summary.upload", nasib: "tegakkan-1c", alasan: "Py summary.py — S7-1c" },
    { no: "22", kunci: "summary.generate", nasib: "tegakkan-1c", alasan: "Py summary.py — S7-1c" },
    { no: "23", kunci: "summary.email", nasib: "tegakkan-1c", alasan: "Py summary.py — S7-1c" },
    { no: "24", kunci: "summary.export", nasib: "tegakkan-1c", alasan: "Py /summary_download, /summary/manual/download — S7-1c" },
    { no: "25", kunci: "insentif_sales.view_dashboard", nasib: "tunda", alasan: "PK-5: /api/insentif-sales/dashboard juga dipakai 'Insentif saya' & SPV/SM" },
    { no: "26", kunci: "finance.approve", nasib: "tetap", alasan: "PK-4: tidak ada route/aksi terpisah — tetap berlabel" },
    { no: "27", kunci: "finance.retry_post", nasib: "tetap", alasan: "PK-4: kunci lama, tidak memberi kapabilitas apa pun" },
    { no: "28", kunci: "summary.update", nasib: "tetap", alasan: "PK-4: tidak ada aksi terpisah" },
    { no: "29", kunci: "order.export", nasib: "tetap", alasan: "PK-4: tidak ada ekspor order (Fakturist BL-37 memuatnya)" },
    { no: "30", kunci: "sales_history.export", nasib: "tetap", alasan: "PK-4: tidak ada ekspor riwayat" },
    { no: "31", kunci: "finance.repost_payment", nasib: "tetap", alasan: "route belum ada (rilis B, D-01 §A)" },
];

/** Kunci di luar 31 D-01 §D yang sah tanpa rujukan literal server (tripwire). */
const DI_LUAR_31: Record<string, string> = {
    "dashboard.view": "gerbang halaman bawaan '/' (pagePermissions, lib/rbac.ts)",
    "api_wrapper.view": "gerbang halaman Konsol & Sesi Accurate (pagePermissions); GET /api/proxy sengaja cukup sesi (S7-1b)",
    // kasir.view & kasir.buka ditegakkan K1b (app/api/kasir/segarkan); kasir.catat & kasir.tutup ditegakkan K2a (app/api/kasir/{setoran,
    // jelaskan,tutup}) — keluar dari daftar ini (tripwire "basi").
};

function walk(dir: string, ok: (f: string) => boolean): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "__pycache__" || name.startsWith(".")) continue;
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) out.push(...walk(p, ok));
        else if (ok(p)) out.push(p);
    }
    return out;
}
const kode = (f: string) => /\.(ts|tsx|js|mjs|cjs)$/.test(f) && !/\.test\.ts$/.test(f);
const py = (f: string) => f.endsWith(".py") && !path.basename(f).startsWith("test_");
const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, "/");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("nasib 31 kunci: tabel lengkap & unik; tegakkan = literal di route yang disebut; daftar tunggu masih terdaftar & beralasan", () => {
    assert.equal(NASIB.length, 31);
    assert.equal(new Set(NASIB.map((r) => r.kunci)).size, 31, "kunci ganda di tabel nasib");
    for (const r of NASIB) {
        assert.ok(r.alasan.trim(), `baris ${r.no} tanpa alasan`);
        if (r.nasib === "pensiun") continue;
        assert.ok(isValidPermissionKey(r.kunci), `baris ${r.no} ${r.kunci} (${r.nasib}) harus masih terdaftar`);
        if (r.nasib === "tegakkan") {
            for (const f of r.di ?? []) assert.match(baca(f), new RegExp(`["'\`]${esc(r.kunci)}["'\`]`), `${r.kunci} tidak ditegakkan di ${f}`);
        }
    }
});

test("pensiun: tidak di registry, = KUNCI_PENSIUN, tidak dirujuk di app/lib/components/config/scripts/python_backend", () => {
    const pensiun = NASIB.filter((r) => r.nasib === "pensiun").map((r) => r.kunci).sort();
    assert.deepEqual([...KUNCI_PENSIUN].sort(), pensiun);
    const berkas = [
        ...["app", "lib", "components", "config", "scripts"].flatMap((d) => walk(path.join(ROOT, d), kode)),
        ...walk(path.join(ROOT, "python_backend"), py),
    ].filter((f) => rel(f) !== "lib/rbac/registry.ts"); // KUNCI_PENSIUN sendiri; registry dicek lewat isValidPermissionKey
    const aksiUnik = (mod: string, act: string) => Object.entries(PERMISSION_REGISTRY).every(([m, a]) => m === mod || !(a as readonly string[]).includes(act));
    const bad: string[] = [];
    for (const k of pensiun) {
        assert.ok(!isValidPermissionKey(k), `${k} masih di registry`);
        const [mod, act] = k.split(".");
        const pola = [
            new RegExp(`\\b${esc(k)}\\b`),                                                   // literal (kode, pesan, komentar)
            new RegExp(`["']${mod}["']\\s*,\\s*["']${act}["']`),                              // Python user_has_permission(u, "m", "a")
            new RegExp(`\\b${mod}["']?\\s*[:,]\\s*\\[[^\\]]*["']${act}["']`),                  // daftar: m: [...] / k("m", [...]) / pick("m", [...])
            ...(aksiUnik(mod, act) ? [new RegExp(`["']${act}["']`)] : []),                   // aksi khas modul ini (create_user, …)
        ];
        for (const f of berkas) {
            const s = readFileSync(f, "utf8");
            if (pola.some((p) => p.test(s))) bad.push(`${k} <- ${rel(f)}`);
        }
    }
    assert.deepEqual(bad, [], `kunci pensiun masih dirujuk:\n  ${bad.join("\n  ")}`);
});

test("tripwire: kunci registry tanpa rujukan server WAJIB punya baris nasib (atau DI_LUAR_31) — kunci baru tanpa nasib = merah", () => {
    const server = [
        ...walk(path.join(ROOT, "app", "api"), kode), ...walk(path.join(ROOT, "app", "(cetak)"), kode),
        ...walk(path.join(ROOT, "lib"), kode).filter((f) => !["lib/rbac.ts", "lib/rbac/registry.ts"].includes(rel(f))),
        ...walk(path.join(ROOT, "python_backend"), py),
    ].map((f) => readFileSync(f, "utf8")).join("\n");
    const tanpaRujukan = [...allPermissionKeys()].filter((k) => {
        const [mod, act] = k.split(".");
        return ![
            new RegExp(`["'\`]${esc(k)}["'\`]`),
            new RegExp(`user_has_permission\\(\\s*\\w+\\s*,\\s*"${mod}"\\s*,\\s*(?:"[a-z_]+"\\s+if\\s+[^)]*?else\\s+)?"${act}"`),
            new RegExp(`user_has_permission\\(\\s*\\w+\\s*,\\s*"${mod}"\\s*,\\s*"${act}"\\s+if\\b`),
        ].some((p) => p.test(server));
    });
    const bernasib = new Set([...NASIB.filter((r) => r.nasib !== "tegakkan" && r.nasib !== "pensiun").map((r) => r.kunci), ...Object.keys(DI_LUAR_31)]);
    const tanpaNasib = tanpaRujukan.filter((k) => !bernasib.has(k));
    assert.deepEqual(tanpaNasib, [], `kunci tidak ditegakkan server tanpa baris nasib:\n  ${tanpaNasib.join("\n  ")}`);
    // Daftar tunggu yang ternyata SUDAH ditegakkan = tabel basi (pindahkan ke "tegakkan" dengan route-nya).
    const basi = [...bernasib].filter((k) => isValidPermissionKey(k) && !tanpaRujukan.includes(k));
    assert.deepEqual(basi, [], `baris nasib/DI_LUAR_31 basi (kunci sudah dirujuk server):\n  ${basi.join("\n  ")}`);
});

// ---------------- butir 6: penjaga statik route tulis ----------------

/** Route tulis yang handler-nya tidak memeriksa izin eksplisit — alasan per baris (S7-1b; per handler sejak tinjauan A/B). */
const DAFTAR_PUTIH: Record<string, string> = {
    "admin/bootstrap/route.ts": "bootstrap admin pertama: token setup x-admin-setup-token (konstan-waktu), bukan sesi",
    "auth/[...all]/route.ts": "handler Better Auth (masuk/keluar/sesi); plugin admin /admin/* ditutup dari peramban (S7-1 BL-62)",
    "auth/accurate-session/route.ts": "sesi Accurate MILIK pengguna sendiri (zona OAuth, cukup sesi app — D-01 Q2)",
    "auth/open-db/route.ts": "buka database Accurate untuk sesi milik sendiri (zona OAuth, cukup sesi app)",
    "chatbot/route.ts": "chatbot baca-informasi untuk sesi app; tidak menulis data bisnis",
    "claim-workflow/[id]/submissions/[submissionId]/close/route.ts": "peran admin/claim (manager = admin lewat requireClaimSession, owner 12 Okt) — pindah ke kunci menyusul",
    "claim-workflow/[id]/submissions/[submissionId]/items/route.ts": "peran admin/claim (manager = admin lewat requireClaimSession, owner 12 Okt) — pindah ke kunci menyusul",
    "claim-workflow/[id]/submissions/[submissionId]/payments/[paymentId]/void/route.ts": "peran admin/claim (manager = admin lewat requireClaimSession, owner 12 Okt) — pindah ke kunci menyusul",
    "idempotency/complete/route.ts": "hanya pemilik lock (lockId + user yang sama, AM-050); izin kirim ditegakkan di /lock & /api/proxy",
    "webhook/accurate/route.ts": "webhook Accurate: allowlist IP + verifikasi, bukan sesi pengguna",
};
const IZIN = /requirePermission(?:H)?\s*\(|perms[!?]*\.has\s*\(|resolveRequestPermissions(?:H)?\s*\(|requireCronSecret\s*\(/;
const METODE_TULIS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Buang komentar blok & baris ("//" di URL "https://…" dan di string berpetik dipertahankan secara kasar). */
const buangKomentar = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** Teks dari pembuka `buka` pertama di/ sesudah i sampai penutup yang seimbang. */
function seimbang(s: string, i: number, buka: string, tutup: string): string {
    const a = s.indexOf(buka, i);
    if (a < 0) return "";
    let d = 0;
    for (let j = a; j < s.length; j++) {
        if (s[j] === buka) d++;
        else if (s[j] === tutup && --d === 0) return s.slice(a, j + 1);
    }
    return s.slice(a);
}
/** Badan `function nama(…) {…}` mulai di i: lewati daftar parameter yang seimbang, lalu blok `{…}`. */
const badanFungsi = (s: string, i: number) => {
    const p = s.indexOf("(", i);
    const param = seimbang(s, p, "(", ")");
    return seimbang(s, p + param.length, "{", "}");
};
/** Ekspresi sesudah `=` sampai `;` atau baris baru pada kedalaman 0 sesudah ekspresi tertutup. */
function ekspresi(s: string, i: number): string {
    const a = s.indexOf("=", i) + 1;
    let d = 0, pernah = false;
    for (let j = a; j < s.length; j++) {
        const c = s[j];
        if ("([{".includes(c)) { d++; pernah = true; } else if (")]}".includes(c)) d--;
        if (d === 0 && (c === ";" || (c === "\n" && pernah))) return s.slice(a, j);
    }
    return s.slice(a);
}

/**
 * Handler tulis (POST/PUT/PATCH/DELETE) yang TIDAK memeriksa izin, per handler. Lolos bila badan handler memuat pola IZIN atau memanggil
 * fungsi lokal yang badannya memuatnya (satu tingkat). Bentuk: `export (async) function M`, `export const M = …`,
 * `export const { …M… } = …`, `export { lokal as M }` (lokal diselesaikan di berkas yang sama). `export { M } from "…"` dan
 * `export * from "…"` = tidak dapat diperiksa (dilaporkan).
 * ponytail: heuristik teks, bukan parser TS — plafon: penjaga yang ada di modul LAIN (helper impor, pabrik handler dari lib) tidak
 * diikuti kecuali pola IZIN muncul di argumen di berkas ini (mis. `authorize: … requirePermission(…)`); komentar-semu di dalam string bisa
 * ikut terbuang; pemanggilan helper diterima di mana pun di badan (bukan bukti dipanggil sebelum tulis). Upgrade: pemeriksa berbasis AST
 * (ts-morph / TypeScript compiler API) + uji perilaku 401/403 per route.
 */
function handlerTanpaIzin(sumber: string): string[] {
    const s = buangKomentar(sumber);
    const lokal = new Map<string, string>();
    for (const m of s.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)) lokal.set(m[1], badanFungsi(s, m.index!));
    for (const m of s.matchAll(/(?:const|let|var)\s+(\w+)\s*=/g)) if (!lokal.has(m[1])) lokal.set(m[1], ekspresi(s, m.index!));
    const penjaga = [...lokal].filter(([, badan]) => IZIN.test(badan)).map(([nama]) => nama);
    // Rujukan ke penjaga lokal = dipanggil (`gateOf(`) atau diakses anggotanya (`handlers.POST`, pabrik handler berizin).
    const aman = (seg: string) => IZIN.test(seg) || penjaga.some((n) => new RegExp(`\\b${n}\\s*[(.]`).test(seg));
    const gagal: string[] = [];
    const nilai = (metode: string, seg: string | null) => { if (METODE_TULIS.has(metode) && (seg === null || !aman(seg))) gagal.push(metode); };
    for (const m of s.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(/g)) nilai(m[1], badanFungsi(s, m.index!));
    for (const m of s.matchAll(/export\s+(?:const|let|var)\s+(\w+)\s*=/g)) nilai(m[1], ekspresi(s, m.index!));
    for (const m of s.matchAll(/export\s+(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
        const seg = ekspresi(s, m.index! + m[0].length - 1);
        for (const nama of m[1].split(",").map((x) => x.split(":")[0].trim())) nilai(nama, seg);
    }
    for (const m of s.matchAll(/export\s*\{([^}]*)\}\s*(from\s*["'][^"']+["'])?/g)) {
        for (const spek of m[1].split(",").map((x) => x.trim()).filter(Boolean)) {
            const [lok, , ekspor = lok] = spek.split(/\s+/);
            nilai(ekspor, m[2] ? null : (lokal.get(lok) ?? null));
        }
    }
    if (/export\s*\*\s*from/.test(s)) gagal.push("*");
    return gagal;
}

test("guard statik: pemeriksa per handler menangkap bentuk ekspor, komentar, dan helper lokal (sabotase bentuk = merah)", () => {
    const izin = `await requirePermission(r, "a.b")`;
    const kasus: Array<[string, string[]]> = [
        [`export async function POST(r) { ${izin}; }`, []],
        [`export async function POST(r) { return 1; }`, ["POST"]],
        [`export async function GET(r) { ${izin}; }\nexport async function POST(r) { return 1; }`, ["POST"]],          // GET dijaga, POST tidak
        [`export async function POST(r) {\n  // ${izin}\n  return 1;\n}`, ["POST"]],                                     // komentar baris
        [`export async function POST(r) { /* ${izin} */ return 1; }`, ["POST"]],                                        // komentar blok
        [`async function h(r) { return 1; }\nexport { h as POST };`, ["POST"]],                                          // export { h as POST }
        [`async function h(r) { ${izin}; }\nexport { h as POST, h as GET };`, []],
        [`export const { GET, POST } = toNextJsHandler(auth);`, ["POST"]],                                               // destrukturisasi
        [`export { POST } from "./lain";`, ["POST"]],                                                                    // re-ekspor modul lain
        [`export * from "./lain";`, ["*"]],
        [`export const POST = buat({ authorize: async (r) => { ${izin}; } });`, []],                                     // pabrik + authorize
        [`export const POST = buat({ simpan: () => 1 });`, ["POST"]],
        [`async function gateOf() { const g = await resolveRequestPermissionsH(); }\nexport async function DELETE() { await gateOf(); }`, []],
        [`async function gateOf() { return 1; }\nexport async function PATCH() { await gateOf(); }`, ["PATCH"]],
        [`const u = "https://x.test/a"; export async function PUT(r) { ${izin}; }`, []],                                 // "//" di URL bukan komentar
        [`export async function GET(r) { return 1; }`, []],                                                              // baca saja
        [`const handlers = buat({ authorize: async (r) => { ${izin}; } });\nexport const POST = handlers.POST;`, []],     // anggota pabrik berizin
        [`const handlers = buat({});\nexport const POST = handlers.POST;`, ["POST"]],
    ];
    for (const [src, harap] of kasus) assert.deepEqual(handlerTanpaIzin(src), harap, src);
});

test("guard statik: setiap handler tulis app/api/**/route.{ts,tsx,js,mjs} memeriksa izin atau berkasnya di daftar putih beralasan; tidak basi", () => {
    const API = path.join(ROOT, "app", "api");
    const berkas = walk(API, (f) => /^route\.(ts|tsx|js|mjs)$/.test(path.basename(f)));
    const handlerTulis = berkas.flatMap((f) => [...buangKomentar(readFileSync(f, "utf8"))
        .matchAll(/export\s+(?:async\s+)?function\s+(?:POST|PUT|PATCH|DELETE)\b|export\s+(?:const|let|var)\s+(?:POST|PUT|PATCH|DELETE)\b/g)]);
    assert.ok(handlerTulis.length > 150, `pemindai route tulis rusak (${handlerTulis.length})`);
    const tanpa = berkas.map((f) => [path.relative(API, f).replace(/\\/g, "/"), handlerTanpaIzin(readFileSync(f, "utf8"))] as const)
        .filter(([, g]) => g.length).map(([f, g]) => `${f} ${g.join(",")}`).sort();
    assert.deepEqual(tanpa.filter((x) => !DAFTAR_PUTIH[x.split(" ")[0]]), [],
        "handler tulis tanpa pemeriksaan izin — tambah requirePermission/perms.has atau alasan di DAFTAR_PUTIH");
    assert.deepEqual(Object.keys(DAFTAR_PUTIH).filter((f) => !tanpa.some((x) => x.startsWith(`${f} `))), [], "daftar putih basi (route sudah berizin/dihapus)");
    for (const [f, alasan] of Object.entries(DAFTAR_PUTIH)) assert.ok(alasan.trim().length > 10, f);
});

test("guard statik: /api/proxy memuat api_wrapper.execute (tulis Konsol) DAN pelunasan.kirim (cabang sales-receipt)", () => {
    const src = baca("app/api/proxy/route.ts");
    assert.match(src, /perms!?\.has\("api_wrapper\.execute"\)/);
    assert.match(src, /perms!?\.has\("pelunasan\.kirim"\)/);
});

test("PK-1 (owner 12 Okt: biarkan): tidak ada SQL handover yang menulis api_wrapper.*; preset tidak mencabut execute dari Manager/Fakturist", async () => {
    const { readdirSync: daftar } = await import("node:fs");
    for (const f of daftar(path.join(ROOT, "docs", "handover")).filter((n) => /^RBAC_.*\.sql$/.test(n))) {
        const aktif = baca(`docs/handover/${f}`).replace(/--.*$/gm, "");
        const tulis = aktif.slice(0, aktif.indexOf("VERIFIKASI") >= 0 ? aktif.indexOf("VERIFIKASI") : undefined);
        // Pernyataan tulis yang menyebut api_wrapper (INSERT/DELETE/UPDATE dalam satu pernyataan ber-";").
        for (const stmt of tulis.split(";")) {
            if (/\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+"?\w+"?\s+SET)\b/i.test(stmt)) assert.doesNotMatch(stmt, /api_wrapper/, `${f} menulis api_wrapper.*`);
        }
        assert.doesNotMatch(tulis, /\bDELETE\s+FROM\s+group_permission\b[^;]*\bWHERE\b[^;]*NOT\b/i, `${f}: DELETE berbasis pengecualian bisa mencabut execute`);
    }
    // Preset BL-37 hanya menyisipkan ke grup yang BARU dibuat (grup lama bernama sama — termasuk Fakturist produksi — tidak disentuh).
    assert.match(baca("docs/handover/RBAC_PRESET_BL37.sql"), /ON CONFLICT \(name\) DO NOTHING/);
    const { rolePermissionPresets } = await import("../rbac.ts");
    assert.deepEqual(rolePermissionPresets.manager.api_wrapper, ["view", "execute"], "preset lama Manager tetap execute");
    assert.match(baca("scripts/seed-rbac-presets.ts"), /k\("api_wrapper", \["view", "execute"\]\)/, "seed Manager tetap execute");
});
