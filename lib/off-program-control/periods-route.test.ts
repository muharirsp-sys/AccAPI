/* GET /api/off-program-control/periods (audit desain 001 No 27): status penutupan dibaca dari off_period_closure apa pun sesi yang
 * menutupnya, nama penutup/pembuka dari tabel user (id = cadangan bila nama tidak ada), izin baca OPC, bulan/tahun divalidasi.
 * Sesi, grup izin, dan DB dipalsukan (tanpa Postgres); route ASLI dijalankan dalam lingkup permintaan Next tiruan (pola
 * manager-route.test.ts) karena memakai `headers()`. */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";

async function muat() {
    (globalThis as Record<string, unknown>).AsyncLocalStorage ??= AsyncLocalStorage;
    return {
        ...await import("next/dist/server/app-render/work-async-storage.external.js"),
        ...await import("next/dist/server/app-render/work-unit-async-storage.external.js"),
        periods: await import("../../app/api/off-program-control/periods/route.ts"),
        schema: await import("../../db/schema.ts"),
        auth: (await import("../auth.ts")).auth,
        db: (await import("../db.ts")).db,
    };
}
let m: Awaited<ReturnType<typeof muat>>;
before(async () => { m = await muat(); });

const TUTUP = [
    { principleCode: "PA", principleName: "PRINCIPLE A", bulan: "09", tahun: "2026", status: "Ditutup", closedBy: "u-a", closedAt: new Date("2026-10-01T01:15:00Z"),
        unlockedBy: null, unlockedAt: null, updatedAt: new Date("2026-10-01T01:15:00Z") },
    { principleCode: "PB", principleName: "PRINCIPLE B", bulan: "09", tahun: "2026", status: "Terbuka", closedBy: "u-hilang", closedAt: new Date("2026-09-30T01:00:00Z"),
        unlockedBy: "u-a", unlockedAt: new Date("2026-10-02T02:00:00Z"), updatedAt: new Date("2026-10-02T02:00:00Z") },
];

async function sebagai(keys: string[], url: string) {
    const { auth, db, schema } = m;
    const saved = [[auth.api, "getSession", Object.getOwnPropertyDescriptor(auth.api, "getSession")], [db, "select", Object.getOwnPropertyDescriptor(db, "select")]] as const;
    const env = process.env.LOCAL_AUTH_BYPASS;
    delete process.env.LOCAL_AUTH_BYPASS;
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => ({ user: { id: "u-a", name: "ADMIN A", email: "a@uji.test", role: "admin" }, session: { id: "s1" } }) });
    Object.defineProperty(db, "select", { configurable: true, value: () => ({ from: (t: unknown) => ({
        leftJoin: () => ({ where: async () => keys.map((key) => ({ groupId: "g1", key })) }),
        where: async () => (t === schema.offPeriodClosure ? TUTUP : t === schema.user ? [{ id: "u-a", name: "ADMIN A" }] : []),
    }) }) });
    try {
        const store = { route: "/uji", forceStatic: false, dynamicShouldError: false };
        const unit = { type: "private-cache", phase: "render", headers: new Headers({ host: "app.test" }) };
        const res = await m.workAsyncStorage.run(store as never, () => m.workUnitAsyncStorage.run(unit as never,
            () => m.periods.GET(new Request(`http://app.test${url}`))));
        return { status: res.status, body: await res.json() as Record<string, unknown> };
    } finally {
        for (const [obj, k, d] of saved) {
            if (d) Object.defineProperty(obj, k, d);
            else delete (obj as unknown as Record<string, unknown>)[k];
        }
        if (env === undefined) delete process.env.LOCAL_AUTH_BYPASS; else process.env.LOCAL_AUTH_BYPASS = env;
    }
}

test("GET periods: tanpa izin lihat OPC 403; bulan/tahun tidak sah 400", async () => {
    assert.equal((await sebagai(["order.view"], "/api/off-program-control/periods?bulan=09&tahun=2026")).status, 403);
    for (const q of ["", "?bulan=13&tahun=2026", "?bulan=09&tahun=26", "?bulan=x&tahun=2026"]) {
        assert.equal((await sebagai(["off_program_control.view"], `/api/off-program-control/periods${q}`)).status, 400, q);
    }
});

test("GET periods: status per principal + nama penutup/pembuka dari tabel user, id sebagai cadangan; bulan 9 = 09", async () => {
    const r = await sebagai(["off_program_control.view"], "/api/off-program-control/periods?bulan=9&tahun=2026");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.bulan, r.body.tahun], ["09", "2026"]);
    const [a, b] = r.body.periods as Record<string, unknown>[];
    assert.deepEqual([a.principleCode, a.status, a.closedBy, a.closedByName, a.closedAt], ["PA", "Ditutup", "u-a", "ADMIN A", "2026-10-01T01:15:00.000Z"]);
    assert.deepEqual([b.status, b.closedBy, b.closedByName, b.unlockedByName], ["Terbuka", "u-hilang", null, "ADMIN A"]);
});
