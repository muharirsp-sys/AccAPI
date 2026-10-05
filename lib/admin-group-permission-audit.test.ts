/* AM-057: PATCH /api/admin/groups/[id] mencatat kunci yang DITAMBAH & DICABUT (bukan hanya keyCount), dan
 * hapus-isi-ulang izin + audit terjadi dalam SATU transaksi (gagal di tengah = izin lama utuh).
 * Sesi & DB dipalsukan; tanpa DB/jaringan. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { PATCH } from "../app/api/admin/groups/[id]/route.ts";
import { accessGroup, groupPermission, permissionAuditLog, userGroup } from "../db/schema.ts";
import { auth } from "./auth.ts";
import { db } from "./db.ts";

type Write = { via: "db" | "tx"; op: "insert" | "delete"; table: unknown; values?: unknown };

/** db palsu: select dijawab per tabel; insert/delete dicatat beserta jalurnya (db langsung vs transaksi). */
async function patchAs(body: unknown, groupKeys: string[]) {
    const writes: Write[] = [];
    const rowsFor = (t: unknown) =>
        t === userGroup ? [{ groupId: "g-admin", key: "users.manage" }]
            : t === accessGroup ? [{ id: "g1", name: "Finance", description: null, isPreset: false }]
                : t === groupPermission ? groupKeys.map((key) => ({ key }))
                    : [];
    const select = () => {
        let table: unknown;
        const q = {
            from: (t: unknown) => { table = t; return q; },
            leftJoin: () => q, where: () => q, limit: () => q, for: () => q,
            then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(rowsFor(table)).then(ok, ko),
        };
        return q;
    };
    const writer = (via: Write["via"]) => ({
        select,
        insert: (table: unknown) => ({ values: async (values: unknown) => { writes.push({ via, op: "insert", table, values }); } }),
        delete: (table: unknown) => ({ where: async () => { writes.push({ via, op: "delete", table }); } }),
    });
    const direct = writer("db");
    const fakes: Record<string, unknown> = {
        select, insert: direct.insert, delete: direct.delete,
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(writer("tx")),
    };
    const saved = Object.keys(fakes).map((k) => [k, Object.getOwnPropertyDescriptor(db, k)] as const);
    const savedSession = Object.getOwnPropertyDescriptor(auth.api, "getSession");
    const env = process.env.LOCAL_AUTH_BYPASS;
    delete process.env.LOCAL_AUTH_BYPASS;
    for (const [k, v] of Object.entries(fakes)) Object.defineProperty(db, k, { configurable: true, value: v });
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => ({ user: { id: "u-admin", name: "Admin" }, session: { id: "s1" } }) });
    try {
        const req = new NextRequest("http://localhost/api/admin/groups/g1", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
        const res = await PATCH(req, { params: Promise.resolve({ id: "g1" }) });
        return { status: res.status, writes };
    } finally {
        for (const [k, d] of saved) {
            if (d) Object.defineProperty(db, k, d);
            else delete (db as unknown as Record<string, unknown>)[k];
        }
        if (savedSession) Object.defineProperty(auth.api, "getSession", savedSession);
        if (env !== undefined) process.env.LOCAL_AUTH_BYPASS = env;
    }
}

test("sinkron izin grup: audit memuat added/removed, kunci ganda dibuang, semua tulis dalam transaksi", async () => {
    const { status, writes } = await patchAs(
        { permissions: ["users.manage", "finance.view", "finance.view"] },
        ["users.manage", "finance.resolve_unknown"],
    );
    assert.equal(status, 200);
    const audit = writes.find((w) => w.table === permissionAuditLog);
    assert.ok(audit, "audit tidak ditulis");
    const entry = audit.values as { action: string; detail: unknown };
    assert.equal(entry.action, "group_permission.sync");
    assert.deepEqual(entry.detail, { keyCount: 2, added: ["finance.view"], removed: ["finance.resolve_unknown"] });
    const inserted = writes.find((w) => w.op === "insert" && w.table === groupPermission);
    assert.deepEqual(inserted?.values, [{ groupId: "g1", permissionKey: "users.manage" }, { groupId: "g1", permissionKey: "finance.view" }]);
    assert.deepEqual(writes.filter((w) => w.via !== "tx"), [], "hapus/isi ulang/audit harus lewat transaksi");
});

test("kunci tidak terdaftar ditolak tanpa tulis apa pun", async () => {
    const { status, writes } = await patchAs({ permissions: ["finance.view", "finance.nope"] }, ["finance.view"]);
    assert.equal(status, 400);
    assert.deepEqual(writes, []);
});
