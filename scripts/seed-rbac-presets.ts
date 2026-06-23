/*
 * seed-rbac-presets.ts
 * Seed Access Group preset (backward-compat) + backfill user_group dari user.role.
 * Jalankan: node --experimental-strip-types scripts/seed-rbac-presets.ts
 *
 * ADDITIVE & IDEMPOTENT — legacy user.role/user.permissions TIDAK disentuh.
 * Preset diturunkan dari rolePermissionPresets (lib/rbac.ts) + allowedActions OPC
 * (lib/off-program-control/access.ts), dinyatakan sebagai permission key registry.
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allPermissionKeys, isValidPermissionKey } from "../lib/rbac/registry.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../sqlite.db");

const k = (mod: string, actions: string[]) => actions.map((a) => `${mod}.${a}`);

const PRESETS: Array<{ name: string; desc: string; keys: string[] }> = [
    { name: "Admin", desc: "Akses penuh semua modul", keys: [...allPermissionKeys()] },
    {
        name: "Manager", desc: "Manajer lintas modul", keys: [
            ...k("dashboard", ["view"]), ...k("api_wrapper", ["view", "execute"]),
            ...k("payments", ["view", "export", "submit", "edit", "update"]),
            ...k("sppd", ["view", "generate", "download"]),
            ...k("finance", ["view", "approve", "export", "update"]),
            ...k("principles", ["view"]), ...k("summary", ["view", "export"]),
            ...k("validator", ["view", "download"]),
            ...k("off_program_control", ["view", "update", "approve", "export"]),
            ...k("claim_workflow", ["view", "approve", "export"]),
            ...k("form_kontrol", ["view", "submit", "manage"]),
            ...k("insentif_sales", ["view", "upload_target", "upload_progress"]),
        ],
    },
    {
        name: "Finance", desc: "Keuangan / pembayaran", keys: [
            ...k("dashboard", ["view"]), ...k("payments", ["view", "export"]),
            ...k("sppd", ["view", "download"]),
            ...k("finance", ["view", "approve", "transfer", "upload_proof", "post_accurate", "retry_post", "export", "update"]),
            ...k("off_program_control", ["view", "update", "finance_payment", "submit_refund"]),
            ...k("claim_workflow", ["view", "update", "export"]),
            ...k("principles", ["view"]),
            ...k("insentif_sales", ["view", "input_support", "manage_payment"]),
        ],
    },
    {
        name: "Staff", desc: "Staf input operasional", keys: [
            ...k("dashboard", ["view"]),
            ...k("payments", ["view", "create", "edit", "upload", "submit"]),
            ...k("sppd", ["view", "generate", "download"]),
            ...k("principles", ["view"]),
            ...k("summary", ["view", "upload", "generate", "export", "edit", "update"]),
            ...k("validator", ["view", "upload", "run", "download", "edit"]),
            ...k("off_program_control", ["view", "create", "update"]),
            ...k("claim_workflow", ["view"]),
        ],
    },
    {
        name: "Viewer", desc: "Hanya lihat", keys: [
            ...k("dashboard", ["view"]), ...k("payments", ["view"]), ...k("sppd", ["view"]),
            ...k("finance", ["view"]), ...k("off_program_control", ["view"]),
            ...k("claim_workflow", ["view"]), ...k("summary", ["view"]), ...k("validator", ["view"]),
        ],
    },
    {
        name: "SPV", desc: "Supervisor — OPC pengajuan + Form Kontrol tim", keys: [
            ...k("dashboard", ["view"]),
            ...k("off_program_control", ["view", "create", "update", "create_batch", "edit_returned_batch", "submit_batch", "submit_refund", "discount_view", "discount_manage"]),
            ...k("form_kontrol", ["view", "submit"]),
            ...k("insentif_sales", ["view", "upload_progress"]),
        ],
    },
    {
        name: "SM", desc: "Sales Manager — approve OPC + Form Kontrol", keys: [
            ...k("dashboard", ["view"]),
            ...k("off_program_control", ["view", "sm_approve", "sm_return", "submit_refund"]),
            ...k("form_kontrol", ["view", "submit"]),
            ...k("insentif_sales", ["view"]),
        ],
    },
    {
        name: "Claim", desc: "Tim Klaim — review & klaim", keys: [
            ...k("dashboard", ["view"]),
            ...k("off_program_control", ["view", "export", "claim_review", "claim_final", "audit_read", "audit_export", "audit_correct", "period_close", "create_batch", "submit_batch", "edit_returned_batch"]),
            ...k("claim_workflow", ["view", "create", "edit", "update", "submit", "approve", "export"]),
        ],
    },
    {
        name: "OM", desc: "Operational Manager — approve akhir OPC", keys: [
            ...k("dashboard", ["view"]),
            ...k("off_program_control", ["view", "om_approve", "om_cancel"]),
        ],
    },
    {
        name: "Salesman", desc: "Sales lapangan — Form Kontrol & insentif sendiri", keys: [
            ...k("dashboard", ["view"]),
            ...k("form_kontrol", ["view", "submit"]),
            ...k("insentif_sales", ["view"]),
        ],
    },
    {
        name: "Admin Sales", desc: "Admin sales — kelola Form Kontrol & target insentif", keys: [
            ...k("dashboard", ["view"]),
            ...k("form_kontrol", ["view", "submit", "manage"]),
            ...k("insentif_sales", ["view", "manage", "upload_target", "upload_progress", "input_support", "manage_payment"]),
        ],
    },
];

// user.role (termasuk sinonim) -> nama preset group.
const ROLE_TO_GROUP: Record<string, string> = {
    admin: "Admin", super_admin: "Admin", manager: "Manager", finance: "Finance", staff: "Staff", viewer: "Viewer",
    spv: "SPV", supervisor: "SPV", sm: "SM", sales_manager: "SM",
    claim: "Claim", om: "OM", operational_manager: "OM",
    salesman: "Salesman", sales: "Salesman", admin_sales: "Admin Sales",
};

// Sanity: semua key preset harus valid di registry (cegah typo nyebar ke DB).
for (const p of PRESETS) {
    for (const key of p.keys) {
        if (!isValidPermissionKey(key)) throw new Error(`Preset ${p.name}: key "${key}" tidak ada di registry`);
    }
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
console.log("DB:", DB_PATH);

const now = Date.now();
const groupIdByName: Record<string, string> = {};

const upsertGroup = db.transaction(() => {
    for (const p of PRESETS) {
        const existing = db.prepare("SELECT id FROM access_group WHERE name = ?").get(p.name) as { id: string } | undefined;
        let id: string;
        if (existing) {
            id = existing.id;
            db.prepare("UPDATE access_group SET description = ?, is_preset = 1, updated_at = ? WHERE id = ?").run(p.desc, now, id);
        } else {
            id = randomUUID();
            db.prepare("INSERT INTO access_group (id, name, description, is_preset, created_at, updated_at) VALUES (?,?,?,1,?,?)").run(id, p.name, p.desc, now, now);
        }
        groupIdByName[p.name] = id;
        // Sync permission: hapus lalu isi ulang sesuai definisi (idempotent).
        db.prepare("DELETE FROM group_permission WHERE group_id = ?").run(id);
        const ins = db.prepare("INSERT OR IGNORE INTO group_permission (group_id, permission_key) VALUES (?, ?)");
        for (const key of p.keys) ins.run(id, key);
    }
});
upsertGroup();
console.log(`Preset group siap: ${PRESETS.length} group.`);

// Backfill user_group dari user.role.
const users = db.prepare("SELECT id, email, role FROM user").all() as Array<{ id: string; email: string; role: string | null }>;
let assigned = 0, skipped = 0;
const assignTx = db.transaction(() => {
    for (const u of users) {
        const roleKey = String(u.role ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
        const groupName = ROLE_TO_GROUP[roleKey];
        if (!groupName) { console.warn(`  ? ${u.email}: role "${u.role}" tak punya preset — lewati`); skipped++; continue; }
        const res = db.prepare("INSERT OR IGNORE INTO user_group (user_id, group_id, assigned_by, assigned_at) VALUES (?,?,?,?)")
            .run(u.id, groupIdByName[groupName], "seed-rbac-presets", now);
        if (res.changes > 0) { console.log(`  + ${u.email} -> ${groupName}`); assigned++; }
    }
});
assignTx();

console.log(`Backfill user_group: ${assigned} assignment baru, ${skipped} tanpa preset.`);
console.log("Seed RBAC preset selesai (additive, idempotent).");
db.close();
