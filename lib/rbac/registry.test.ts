/*
 * Guard test Dynamic RBAC. Jalankan: node --experimental-strip-types lib/rbac/registry.test.ts
 * 1. Integritas registry (tak ada module kosong / action duplikat).
 * 2. Anti-lupa-daftar: setiap requirePermission(req, "x.y") di app/api/** WAJIB pakai key
 *    yang terdaftar di registry. Tambah fitur → pakai key baru → daftarkan di registry,
 *    kalau lupa test ini MERAH. Gagal → exit non-zero.
 */
import assert from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canAccessPathWithKeys, getPagePermission, rolePermissionPresets } from "../rbac.ts";
import { CAPABILITY_KEYS, PERMISSION_REGISTRY, allPermissionKeys, isValidPermissionKey, toggleModuleKeys } from "./registry.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(__dirname, "../../app/api");

// --- 1. Integritas registry ---
for (const [mod, actions] of Object.entries(PERMISSION_REGISTRY)) {
    assert.ok(actions.length > 0, `module ${mod} tidak boleh kosong`);
    assert.strictEqual(new Set(actions).size, actions.length, `module ${mod} ada action duplikat`);
}
const keys = allPermissionKeys();
assert.ok(keys.size > 0, "registry kosong");
assert.ok(isValidPermissionKey("off_program_control.sm_approve"), "key OPC valid harus dikenali");
assert.ok(!isValidPermissionKey("off_program_control.nope"), "key tak terdaftar harus ditolak");
// Sesi 5: tiga kapabilitas Finance yang membuka kiriman ulang ke Accurate = tiga kunci terpisah, preset
// role finance memuat ketiganya, manager tidak (owner D-14/D-15/D-18).
for (const action of ["resolve_unknown", "override_duplicate", "repost_payment"] as const) {
    assert.ok(isValidPermissionKey(`finance.${action}`), `finance.${action} wajib terdaftar`);
    assert.ok(rolePermissionPresets.finance.finance?.includes(action), `preset finance tanpa ${action}`);
    assert.ok(!rolePermissionPresets.manager.finance?.includes(action), `preset manager memuat ${action}`);
}
// AM-057: centang modul di UI grup TIDAK menyalakan kunci kapabilitas Finance (harus satu per satu);
// mematikan modul mencabut semuanya, termasuk kapabilitas.
assert.ok([...CAPABILITY_KEYS].every(isValidPermissionKey), "kunci kapabilitas wajib terdaftar");
const moduleOn = toggleModuleKeys(new Set(), "finance");
assert.ok(moduleOn.has("finance.view") && moduleOn.has("finance.post_accurate"), "centang modul menyalakan kunci biasa");
for (const k of CAPABILITY_KEYS) assert.ok(!moduleOn.has(k), `centang modul menyalakan ${k}`);
const partial = toggleModuleKeys(new Set(["finance.view", "finance.override_duplicate"]), "finance");
assert.ok(partial.has("finance.export") && partial.has("finance.override_duplicate") && !partial.has("finance.resolve_unknown"));
assert.deepEqual([...toggleModuleKeys(new Set([...moduleOn, "finance.resolve_unknown", "dashboard.view"]), "finance")], ["dashboard.view"]);
assert.ok(isValidPermissionKey("reconciliation.view"));
assert.ok(isValidPermissionKey("reconciliation.run"));
assert.ok(isValidPermissionKey("reconciliation.manage"));
assert.deepEqual(getPagePermission("/reconciliation"), {
    prefix: "/reconciliation",
    module: "reconciliation",
    action: "view",
});
assert.ok(canAccessPathWithKeys("/reconciliation", ["reconciliation.view"]));
assert.ok(!canAccessPathWithKeys("/reconciliation", ["reconciliation.run"]));

// --- 2. Scan requirePermission(...) di route ---
function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else if (name === "route.ts") out.push(p);
    }
    return out;
}

// Cocokkan requirePermission(req, "key"), requirePermissionH("key"), DAN otorisasi majemuk
// bentuk `perms.has("key")` — route dengan dua izin alternatif memakai bentuk itu, dan
// key-nya sama-sama harus terdaftar. Tanpa ini `order.*` lolos tak terdaftar cukup lama:
// Access Group tidak bisa memberikannya sehingga modulnya hanya jalan untuk admin.
// `perms[!?]*` juga menangkap `access.perms!.has(...)` (re-review 748b73aa LOW: route lock idempotency lolos scan).
const RE = /(?:requirePermission(?:H)?\s*\(\s*(?:[^,()]+,\s*)?|perms[!?]*\.has\s*\(\s*)["'`]([^"'`]+)["'`]/g;
let scanned = 0;
const bad: string[] = [];
for (const file of walk(API_DIR)) {
    const src = readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    while ((m = RE.exec(src))) {
        scanned++;
        if (!isValidPermissionKey(m[1])) bad.push(`${path.relative(API_DIR, file)}: "${m[1]}"`);
    }
}
assert.strictEqual(bad.length, 0, `Permission key tak terdaftar di registry:\n  ${bad.join("\n  ")}`);

console.log(`OK — registry ${keys.size} keys; ${scanned} requirePermission() di route tervalidasi.`);
