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
 * Guard route: setiap app/api/**\/route.ts yang mengekspor POST/PUT/PATCH/DELETE memeriksa izin, atau ada di DAFTAR_PUTIH beralasan.
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
    { no: "6", kunci: "off_program_control.approve", nasib: "pensiun-s7-3", alasan: "profil Beranda SM (config/workspace-navigation.ts) pindah ke bintang di S7-3 (PK-O2)" },
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
    "kasir.view": "K1a: kunci + preset SQL; route Kasir menyusul (K2)",
    "kasir.catat": "K1a: route Kasir menyusul (K2)",
    "kasir.tutup": "K1a: route Kasir menyusul (K2)",
    "kasir.buka": "K1a: route Kasir menyusul (K2)",
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

/** Route tulis tanpa pemeriksaan izin eksplisit — alasan per baris (S7-1b, dipindai 134 berkas tulis). */
const DAFTAR_PUTIH: Record<string, string> = {
    "admin/bootstrap/route.ts": "bootstrap admin pertama: token setup x-admin-setup-token (konstan-waktu), bukan sesi",
    "auth/accurate-session/route.ts": "sesi Accurate MILIK pengguna sendiri (zona OAuth, cukup sesi app — D-01 Q2)",
    "auth/open-db/route.ts": "buka database Accurate untuk sesi milik sendiri (zona OAuth, cukup sesi app)",
    "chatbot/route.ts": "chatbot baca-informasi untuk sesi app; tidak menulis data bisnis",
    "claim-workflow/[id]/submissions/[submissionId]/close/route.ts": "peran admin/claim (user.role) — sisa AM-026, pindah ke kunci menyusul",
    "claim-workflow/[id]/submissions/[submissionId]/items/route.ts": "peran admin/claim (user.role) — sisa AM-026",
    "claim-workflow/[id]/submissions/[submissionId]/payments/[paymentId]/void/route.ts": "peran admin/claim (user.role) — sisa AM-026",
    "idempotency/complete/route.ts": "hanya pemilik lock (lockId + user yang sama, AM-050); izin kirim ditegakkan di /lock & /api/proxy",
    "webhook/accurate/route.ts": "webhook Accurate: allowlist IP + verifikasi, bukan sesi pengguna",
};
const TULIS = /export\s+(?:async\s+)?(?:function|const)\s+(?:POST|PUT|PATCH|DELETE)\b/;
const IZIN = /requirePermission(?:H)?\s*\(|perms[!?]*\.has\s*\(|resolveRequestPermissions(?:H)?\s*\(|requireCronSecret\s*\(/;

test("guard statik: setiap route tulis app/api memeriksa izin atau ada di daftar putih beralasan; daftar putih tidak basi", () => {
    const API = path.join(ROOT, "app", "api");
    const tulis = walk(API, (f) => path.basename(f) === "route.ts").filter((f) => TULIS.test(readFileSync(f, "utf8")));
    assert.ok(tulis.length > 100, `pemindai route tulis rusak (${tulis.length})`);
    const tanpa = tulis.filter((f) => !IZIN.test(readFileSync(f, "utf8"))).map((f) => path.relative(API, f).replace(/\\/g, "/")).sort();
    assert.deepEqual(tanpa.filter((f) => !DAFTAR_PUTIH[f]), [], "route tulis baru tanpa pemeriksaan izin — tambah requirePermission/perms.has atau alasan di DAFTAR_PUTIH");
    assert.deepEqual(Object.keys(DAFTAR_PUTIH).filter((f) => !tanpa.includes(f)), [], "daftar putih basi (route sudah berizin/dihapus)");
    for (const [f, alasan] of Object.entries(DAFTAR_PUTIH)) assert.ok(alasan.trim().length > 10, f);
});

test("guard statik: /api/proxy memuat api_wrapper.execute (tulis Konsol) DAN pelunasan.kirim (cabang sales-receipt)", () => {
    const src = baca("app/api/proxy/route.ts");
    assert.match(src, /perms!?\.has\("api_wrapper\.execute"\)/);
    assert.match(src, /perms!?\.has\("pelunasan\.kirim"\)/);
});
