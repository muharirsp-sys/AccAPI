/* AM-057: PATCH /api/admin/groups/[id] mencatat kunci yang DITAMBAH & DICABUT (bukan hanya keyCount), terurut.
 * Baca kunci lama + hapus-isi-ulang + audit lewat SATU transaksi dengan baris grup `FOR UPDATE` (atomisitas
 * sendiri = jaminan Postgres; di sini dibuktikan bahwa semua baca/tulis itu memang lewat transaksi).
 * Sesi & DB dipalsukan; tanpa DB/jaringan. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { PATCH } from "../app/api/admin/groups/[id]/route.ts";
import { accessGroup, groupPermission, permissionAuditLog, userGroup } from "../db/schema.ts";
import { auth } from "./auth.ts";
import { db } from "./db.ts";

type Via = "db" | "tx";
type Write = { via: Via; op: "insert" | "delete"; table: unknown; values?: unknown };
type Read = { via: Via; table: unknown; lock?: string };

/** db palsu: select dijawab per tabel; setiap baca/tulis dicatat beserta jalurnya (db langsung vs transaksi).
 * `groupInTx` = baris grup yang terlihat di dalam transaksi (kosong = grup terhapus sesudah cek awal). */
async function patchAs(body: unknown, groupKeys: string[], groupInTx = true) {
    const writes: Write[] = [];
    const reads: Read[] = [];
    const group = { id: "g1", name: "Finance", description: null, isPreset: false };
    const writer = (via: Via) => ({
        select: () => {
            const read: Read = { via, table: undefined };
            const rows = () =>
                read.table === userGroup ? [{ groupId: "g-admin", key: "users.manage" }]
                    : read.table === accessGroup ? (via === "db" || groupInTx ? [group] : [])
                        : read.table === groupPermission ? groupKeys.map((key) => ({ key }))
                            : [];
            const q = {
                from: (t: unknown) => { read.table = t; reads.push(read); return q; },
                for: (lock: string) => { read.lock = lock; return q; },
                leftJoin: () => q, where: () => q, limit: () => q,
                then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(rows()).then(ok, ko),
            };
            return q;
        },
        insert: (table: unknown) => ({ values: async (values: unknown) => { writes.push({ via, op: "insert", table, values }); } }),
        delete: (table: unknown) => ({ where: async () => { writes.push({ via, op: "delete", table }); } }),
    });
    const fakes: Record<string, unknown> = { ...writer("db"), transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(writer("tx")) };
    const saved = Object.keys(fakes).map((k) => [k, Object.getOwnPropertyDescriptor(db, k)] as const);
    const savedSession = Object.getOwnPropertyDescriptor(auth.api, "getSession");
    const env = process.env.LOCAL_AUTH_BYPASS;
    delete process.env.LOCAL_AUTH_BYPASS;
    for (const [k, v] of Object.entries(fakes)) Object.defineProperty(db, k, { configurable: true, value: v });
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => ({ user: { id: "u-admin", name: "Admin" }, session: { id: "s1" } }) });
    try {
        const req = new NextRequest("http://localhost/api/admin/groups/g1", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
        const res = await PATCH(req, { params: Promise.resolve({ id: "g1" }) });
        const audit = writes.find((w) => w.table === permissionAuditLog)?.values as { action: string; detail: unknown } | undefined;
        return { status: res.status, writes, reads, audit };
    } finally {
        for (const [k, d] of saved) {
            if (d) Object.defineProperty(db, k, d);
            else delete (db as unknown as Record<string, unknown>)[k];
        }
        if (savedSession) Object.defineProperty(auth.api, "getSession", savedSession);
        if (env !== undefined) process.env.LOCAL_AUTH_BYPASS = env;
    }
}

test("sinkron izin grup: audit memuat added/removed terurut, kunci ganda dibuang, baca & tulis dalam transaksi terkunci", async () => {
    const { status, writes, reads, audit } = await patchAs(
        { permissions: ["users.manage", "finance.view", "finance.export", "finance.view"] },
        ["users.manage", "finance.resolve_unknown", "finance.approve"],
    );
    assert.equal(status, 200);
    assert.equal(audit?.action, "group_permission.sync");
    assert.deepEqual(audit?.detail, { keyCount: 3, added: ["finance.export", "finance.view"], removed: ["finance.approve", "finance.resolve_unknown"] });
    const inserted = writes.find((w) => w.op === "insert" && w.table === groupPermission);
    assert.deepEqual(inserted?.values, ["users.manage", "finance.view", "finance.export"].map((permissionKey) => ({ groupId: "g1", permissionKey })));
    assert.deepEqual(writes.filter((w) => w.via !== "tx"), [], "hapus/isi ulang/audit harus lewat transaksi");
    assert.ok(reads.some((r) => r.via === "tx" && r.table === accessGroup && r.lock === "update"), "baris grup wajib dikunci FOR UPDATE di transaksi");
    assert.deepEqual(reads.filter((r) => r.table === groupPermission).map((r) => r.via), ["tx"], "kunci lama wajib dibaca di dalam transaksi");
});

test("kosongkan izin: semua kunci lama tercatat dicabut, tanpa insert kosong", async () => {
    const { status, writes, audit } = await patchAs({ permissions: [] }, ["finance.view", "finance.approve"]);
    assert.equal(status, 200);
    assert.deepEqual(audit?.detail, { keyCount: 0, added: [], removed: ["finance.approve", "finance.view"] });
    assert.ok(!writes.some((w) => w.op === "insert" && w.table === groupPermission));
});

test("grup kosong -> semua added; isi sama -> added & removed kosong", async () => {
    assert.deepEqual((await patchAs({ permissions: ["finance.view"] }, [])).audit?.detail, { keyCount: 1, added: ["finance.view"], removed: [] });
    assert.deepEqual((await patchAs({ permissions: ["finance.view"] }, ["finance.view"])).audit?.detail, { keyCount: 1, added: [], removed: [] });
});

test("grup terhapus sesudah cek awal -> 404 tanpa tulis", async () => {
    const { status, writes } = await patchAs({ permissions: [] }, ["finance.view"], false);
    assert.equal(status, 404);
    assert.deepEqual(writes, []);
});

test("kunci tidak terdaftar / bukan string ditolak tanpa tulis apa pun", async () => {
    for (const permissions of [["finance.view", "finance.nope"], [5], [null]]) {
        const { status, writes } = await patchAs({ permissions }, ["finance.view"]);
        assert.equal(status, 400, JSON.stringify(permissions));
        assert.deepEqual(writes, []);
    }
});
