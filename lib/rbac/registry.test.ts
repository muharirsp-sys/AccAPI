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
import { PERMISSION_REGISTRY, allPermissionKeys, isValidPermissionKey } from "./registry.ts";

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

// Cocokkan requirePermission(req, "key") DAN requirePermissionH("key").
const RE = /requirePermission(?:H)?\s*\(\s*(?:[^,()]+,\s*)?["'`]([^"'`]+)["'`]/g;
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
