/* S7-1b AM-026 (D-01 §C "manager bukan admin") + AM-042 baris 2 (audit_export): akibat SERVER dari normalizeOffRole("manager")
 * = "manager", diuji di route ASLI (bukan diubah satu per satu): Manager membaca/mengekspor audit, tidak lagi lolos periode tutup,
 * tidak lagi memakai alternatif role === "admin" di refund, tidak lagi istimewa di Claim Workflow; admin tidak berubah.
 * Sesi Better Auth, grup, dan DB dipalsukan (tanpa Postgres/jaringan). Route OPC memakai `headers()` (next/headers): uji dijalankan
 * dalam lingkup permintaan tiruan — ponytail: memakai AsyncLocalStorage internal Next (work/work-unit store "private-cache");
 * plafon: bila Next mengubah internal ini, uji gagal keras (bukan lolos diam-diam) — ganti dengan uji Playwright API. */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";

// Next membuat store-nya saat modul dimuat dan memakai globalThis.AsyncLocalStorage (dipasang server Next) — pasang dulu, lalu impor dinamis.
async function muat() {
    (globalThis as Record<string, unknown>).AsyncLocalStorage ??= AsyncLocalStorage;
    return {
        ...await import("next/dist/server/app-render/work-async-storage.external.js"),
        ...await import("next/dist/server/app-render/work-unit-async-storage.external.js"),
        audit: await import("../../app/api/off-program-control/audit/route.ts"),
        refund: await import("../../app/api/off-program-control/batches/[id]/refund/route.ts"),
        tutup: await import("../../app/api/claim-workflow/[id]/submissions/[submissionId]/close/route.ts"),
        schema: await import("../../db/schema.ts"),
        auth: (await import("../auth.ts")).auth,
        db: (await import("../db.ts")).db,
    };
}
let m: Awaited<ReturnType<typeof muat>>;
before(async () => { m = await muat(); });

const BATCH = { id: "b1", principleCode: "PA", bulan: 9, tahun: 2026, createdBy: "spv-1" };

/** Jalankan `fn` sebagai user ber-`role` dengan izin grup `keys`, di dalam lingkup permintaan Next tiruan. */
async function sebagai<T>(role: string, keys: string[], fn: () => Promise<T>, opsi: { periodeTutup?: boolean } = {}): Promise<T> {
    const { auth, db } = m;
    const { offAuditLog, offBatch, offBatchItem, offPayment, offPeriodClosure, user } = m.schema;
    const saved = [
        [auth.api, "getSession", Object.getOwnPropertyDescriptor(auth.api, "getSession")],
        [db, "select", Object.getOwnPropertyDescriptor(db, "select")],
        [db, "transaction", Object.getOwnPropertyDescriptor(db, "transaction")],
    ] as const;
    const env = process.env.LOCAL_AUTH_BYPASS;
    delete process.env.LOCAL_AUTH_BYPASS;
    const grup = keys.map((key) => ({ groupId: "g1", key }));
    const isi = (t: unknown): unknown[] => t === offBatch ? [BATCH]
        : t === offPeriodClosure ? (opsi.periodeTutup ? [{ status: "Ditutup" }] : [])
        : t === user ? [{ role, permissions: "{}" }]
        : t === offBatchItem || t === offPayment ? [] : [];
    const baris = (r: unknown[]) => Object.assign(Promise.resolve(r), { orderBy: async () => r, limit: async () => r });
    const audit = [{ id: "a1", action: "batch_created", actorName: "SPV A", actorRole: "supervisor", createdAt: new Date("2026-09-01T00:00:00Z") }];
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => ({ user: { id: `u-${role}`, name: `Uji ${role}`, email: `${role}@uji.test`, role }, session: { id: "s1" } }) });
    Object.defineProperty(db, "select", { configurable: true, value: () => ({ from: (t: unknown) => ({
        // getUserPermissions = from(userGroup).leftJoin(groupPermission).where(); audit = from(offAuditLog).leftJoin(offBatch).orderBy().limit().
        leftJoin: () => ({ where: async () => grup, orderBy: () => ({ limit: async () => (t === offAuditLog ? audit : []) }) }),
        where: () => baris(isi(t)),
    }) }) });
    Object.defineProperty(db, "transaction", { configurable: true, value: () => { throw new Error("TIDAK BOLEH menulis DB"); } });
    try {
        const store = { route: "/uji", forceStatic: false, dynamicShouldError: false };
        const unit = { type: "private-cache", phase: "render", headers: new Headers({ host: "app.test" }) };
        return await m.workAsyncStorage.run(store as never, () => m.workUnitAsyncStorage.run(unit as never, fn));
    } finally {
        for (const [obj, k, d] of saved) {
            if (d) Object.defineProperty(obj, k, d);
            else delete (obj as unknown as Record<string, unknown>)[k];
        }
        if (env === undefined) delete process.env.LOCAL_AUTH_BYPASS; else process.env.LOCAL_AUTH_BYPASS = env;
    }
}

const ctx = { params: Promise.resolve({ id: "b1" }) };
const req = (url: string, method = "GET", body?: unknown) => new Request(`http://app.test${url}`, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});
const MANAGER = ["off_program_control.view", "off_program_control.audit_read", "off_program_control.audit_export"];

test("Manager (view + audit_read + audit_export): audit JSON & CSV 200", async () => {
    const json = await sebagai("manager", MANAGER, () => m.audit.GET(req("/api/off-program-control/audit")));
    assert.equal(json.status, 200);
    assert.equal(((await json.json()) as { audit: unknown[] }).audit.length, 1);
    const csv = await sebagai("manager", MANAGER, () => m.audit.GET(req("/api/off-program-control/audit?format=csv")));
    assert.equal(csv.status, 200);
    assert.match(String(csv.headers.get("content-type")), /text\/csv/);
    assert.match(await csv.text(), /batch_created/);
});

test("AM-042 baris 2: CSV tanpa audit_export -> 403 berkode; JSON tetap 200 (audit_read cukup)", async () => {
    for (const role of ["manager", "claim", "admin"]) {
        const keys = ["off_program_control.view", "off_program_control.audit_read"];
        const csv = await sebagai(role, keys, () => m.audit.GET(req("/api/off-program-control/audit?format=CSV")));
        assert.equal(csv.status, 403, role);
        assert.deepEqual(await csv.json(), {
            ok: false, code: "PERMISSION_REQUIRED", permission: "off_program_control.audit_export",
            error: "Ekspor log audit OFF butuh izin OFF Program Control · Export Audit (off_program_control.audit_export).",
        });
        assert.equal((await sebagai(role, keys, () => m.audit.GET(req("/api/off-program-control/audit")))).status, 200, `${role} JSON`);
    }
    // audit_export saja tanpa audit_read tetap ditolak gerbang baca (lama ∧ baru).
    assert.equal((await sebagai("manager", ["off_program_control.audit_export"], () => m.audit.GET(req("/api/off-program-control/audit?format=csv")))).status, 403);
});

test("Manager: refund POST/PATCH 403 (alternatif role admin tidak lagi berlaku); admin tetap lolos gerbang", async () => {
    const post = await sebagai("manager", MANAGER, () => m.refund.POST(req("/api/off-program-control/batches/b1/refund", "POST", { refundAmount: 1 }), ctx));
    assert.equal(post.status, 403);
    const patch = await sebagai("manager", MANAGER, () => m.refund.PATCH(req("/api/off-program-control/batches/b1/refund", "PATCH", {}), ctx));
    assert.equal(patch.status, 403);
    // Admin (role admin, tanpa kunci refund) lolos gerbang -> validasi body PATCH 400 / POST sampai cek pembayaran.
    assert.equal((await sebagai("admin", ["off_program_control.view"], () => m.refund.PATCH(req("/api/off-program-control/batches/b1/refund", "PATCH", {}), ctx))).status, 400);
});

test("Manager tidak lolos periode tutup (dulu dipetakan ke admin); admin tetap lolos", async () => {
    // Manager yang kebetulan memegang submit_refund lewat grup: lolos gerbang izin, tetapi periode tutup menahan.
    const mgr = await sebagai("manager", [...MANAGER, "off_program_control.submit_refund"],
        () => m.refund.POST(req("/api/off-program-control/batches/b1/refund", "POST", { refundAmount: 1 }), ctx), { periodeTutup: true });
    assert.equal(mgr.status, 409);
    assert.match(String((await mgr.json() as { error: string }).error), /Periode ini sudah ditutup/);
    // Admin melewati penjaga periode -> berhenti di aturan berikutnya (batch belum dibayar), bukan periode.
    const adm = await sebagai("admin", ["off_program_control.view"],
        () => m.refund.POST(req("/api/off-program-control/batches/b1/refund", "POST", { refundAmount: 1 }), ctx), { periodeTutup: true });
    assert.equal(adm.status, 409);
    assert.match(String((await adm.json() as { error: string }).error), /belum ada pembayaran/);
});

test("akibat ke Claim Workflow: Manager tidak lagi istimewa (route peran admin/claim menolak 403 sebelum DB tulis)", async () => {
    const cctx = { params: Promise.resolve({ id: "cw1", submissionId: "s1" }) };
    const mgr = await sebagai("manager", ["claim_workflow.view", "claim_workflow.approve"], () => m.tutup.POST(req("/api/claim-workflow/cw1/submissions/s1/close", "POST", {}), cctx));
    assert.equal(mgr.status, 403);
    assert.equal((await mgr.json() as { code: string }).code, "CLAIM_CLOSE_FORBIDDEN");
    const adm = await sebagai("admin", [], () => m.tutup.POST(req("/api/claim-workflow/cw1/submissions/s1/close", "POST", {}), cctx));
    assert.notEqual(adm.status, 403, "admin tetap istimewa");
});
