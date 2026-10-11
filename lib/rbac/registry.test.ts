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
import { actionLabels, auditActionLabels, canAccessPathWithKeys, getPagePermission, permissionKeyLabel, permissionModuleLabels, rolePermissionPresets } from "../rbac.ts";
import { CAPABILITY_KEYS, PERMISSION_REGISTRY, allPermissionKeys, isValidPermissionKey, moduleAllOn, toggleModuleKeys } from "./registry.ts";

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
// Kunci ditulis literal (re-review b955f836 #1): iterasi CAPABILITY_KEYS sendiri lulus walau satu kunci dibuang.
assert.equal(CAPABILITY_KEYS.size, 5);
const moduleOn = toggleModuleKeys(new Set(), "finance");
assert.ok(moduleOn.has("finance.view") && moduleOn.has("finance.post_accurate"), "centang modul menyalakan kunci biasa");
for (const k of ["finance.resolve_unknown", "finance.override_duplicate", "finance.repost_payment"]) {
    assert.ok(isValidPermissionKey(k) && CAPABILITY_KEYS.has(k), `${k} wajib kunci kapabilitas terdaftar`);
    assert.ok(!moduleOn.has(k), `centang modul menyalakan ${k}`);
}
// Status centang modul (UI) = helper yang sama dengan toggle: aktif walau kapabilitas mati.
assert.ok(moduleAllOn(moduleOn, "finance") && !moduleAllOn(new Set(["finance.view"]), "finance"));
const partial = toggleModuleKeys(new Set(["finance.view", "finance.override_duplicate"]), "finance");
assert.ok(partial.has("finance.export") && partial.has("finance.override_duplicate") && !partial.has("finance.resolve_unknown"));
assert.deepEqual([...toggleModuleKeys(new Set([...moduleOn, "finance.resolve_unknown", "dashboard.view"]), "finance")], ["dashboard.view"]);
// S6-0d E6 (owner 9 Okt): order.resolve_unknown = kunci kapabilitas — terdaftar, tidak dinyalakan centang modul
// order, tidak ada di preset manager/staff/viewer (IT Support menambahkannya ke grup, D-17).
assert.ok(isValidPermissionKey("order.resolve_unknown") && CAPABILITY_KEYS.has("order.resolve_unknown"));
const orderOn = toggleModuleKeys(new Set(), "order");
assert.ok(orderOn.has("order.edit") && !orderOn.has("order.resolve_unknown"), "centang modul order menyalakan order.resolve_unknown");
assert.ok(moduleAllOn(orderOn, "order"), "status centang modul order harus aktif walau kapabilitas mati");
for (const role of ["manager", "staff", "viewer", "finance"] as const) {
    assert.ok(!rolePermissionPresets[role].order?.includes("resolve_unknown"), `preset ${role} memuat order.resolve_unknown`);
}
// S6e-2 (owner #5, 10 Okt): pelunasan.kirim terdaftar; preset non-admin TIDAK memuatnya (IT Support menambah ke grup, D-17).
assert.ok(isValidPermissionKey("pelunasan.kirim"), "pelunasan.kirim wajib terdaftar");
for (const role of ["manager", "staff", "viewer", "finance"] as const) {
    assert.ok(!rolePermissionPresets[role].pelunasan?.includes("kirim"), `preset ${role} memuat pelunasan.kirim`);
}
// S7-1: SATU sumber label untuk layar grup (S7a) — setiap modul & aksi registry WAJIB berlabel (termasuk 18 aksi OPC
// granular dan modul form_kontrol). Kunci baru tanpa label = merah.
for (const [mod, actions] of Object.entries(PERMISSION_REGISTRY)) {
    assert.ok((permissionModuleLabels as Record<string, string>)[mod]?.trim(), `modul ${mod} tanpa label`);
    for (const a of actions) {
        assert.ok((actionLabels as Record<string, string>)[a]?.trim(), `aksi ${mod}.${a} tanpa label`);
        assert.notEqual(permissionKeyLabel(`${mod}.${a}`), `${mod}.${a}`);
    }
}
assert.equal(permissionKeyLabel("off_program_control.sm_approve"), "OFF Program Control · Setujui (SM)");
assert.equal(permissionKeyLabel("form_kontrol.manage"), "Form Kontrol · Manage");
assert.equal(permissionKeyLabel("nope.x"), "nope.x");
// Label OPC tidak memperluas preset role lama (moduleActions OPC tetap 5 aksi).
assert.deepEqual(rolePermissionPresets.admin.off_program_control, ["view", "create", "update", "approve", "export"]);
for (const a of ["user.create", "user.password_set", "user.deactivate", "user.activate", "user_group.assign", "user_group.remove", "user_group.star", "user_group.unstar", "group.delete", "group_permission.sync"]) {
    assert.ok(auditActionLabels[a], `aksi audit ${a} tanpa label`);
}
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
// K1a (BL-59): kasir.view/catat/tutup/buka terdaftar; kasir.buka = kapabilitas (centang modul tidak menyalakannya, OM/Admin);
// preset role non-admin tidak memuat kasir (preset grup = docs/handover/RBAC_PRESET_KASIR.sql); /kasir dijaga kasir.view (bukan jatuh ke dashboard.view).
for (const a of ["view", "catat", "tutup", "buka"]) assert.ok(isValidPermissionKey(`kasir.${a}`), `kasir.${a} wajib terdaftar`);
assert.ok(CAPABILITY_KEYS.has("kasir.buka"), "kasir.buka wajib kunci kapabilitas");
const kasirOn = toggleModuleKeys(new Set(), "kasir");
assert.deepEqual([...kasirOn].sort(), ["kasir.catat", "kasir.tutup", "kasir.view"], "centang modul kasir tanpa kasir.buka");
for (const role of ["manager", "staff", "viewer", "finance"] as const) assert.ok(!rolePermissionPresets[role].kasir, `preset ${role} memuat kasir`);
assert.deepEqual(rolePermissionPresets.admin.kasir, ["view", "catat", "tutup", "buka"]);
assert.deepEqual(getPagePermission("/kasir"), { prefix: "/kasir", module: "kasir", action: "view" });
assert.ok(canAccessPathWithKeys("/kasir/2026-10-05", ["kasir.view"]));
assert.ok(!canAccessPathWithKeys("/kasir", ["dashboard.view", "pelunasan.kirim"]));
// S7a: /admin/users = users.view ATAU users.manage (anyOf); /admin/groups tetap users.manage saja (GET grup hanya menerima users.manage).
assert.deepEqual(getPagePermission("/admin/users"), { prefix: "/admin/users", module: "users", action: "view", anyOf: ["users.manage"] });
assert.ok(canAccessPathWithKeys("/admin/users", ["users.view"]));
assert.ok(canAccessPathWithKeys("/admin/users", ["users.manage"]), "pemegang users.manage saja harus lolos layout + gerbang klien");
assert.ok(!canAccessPathWithKeys("/admin/users", ["dashboard.view", "finance.view"]));
assert.ok(canAccessPathWithKeys("/admin/groups", ["users.manage"]));
assert.ok(!canAccessPathWithKeys("/admin/groups", ["users.view"]), "users.view tidak membuka Akses Group");

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
