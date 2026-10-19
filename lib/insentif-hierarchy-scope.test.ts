/* BL-26: cakupan insentif FAIL-CLOSED — user tanpa izin kelola dan tanpa identitas hierarki tidak boleh melihat seluruh perusahaan.
 * db.select dipalsukan (pola insentif-settings.test.ts); tanpa Postgres. */
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { db } from "./db.ts";
import { canSeeAllInsentif, getScopeForUser } from "./insentif-hierarchy-scope.ts";

const PERIODE = { month: 10, year: 2026 };
const IZIN_LIHAT = new Set(["insentif_sales.view"]);

/** select().from(user).where().limit() -> baris user; kueri peta SPV (from() / where() langsung di-await) -> []. */
const kosong = { then: (r: (v: unknown[]) => unknown) => r([]) };
const userBaris = (rows: unknown[]) => mock.method(db, "select", () => ({
    from: () => ({ ...kosong, where: () => ({ ...kosong, limit: async () => rows }) }),
}) as never);

test("tanpa izin kelola + tanpa identitas hierarki -> cakupan KOSONG, bukan seluruh perusahaan (BL-26)", async () => {
    for (const baris of [[], [{ hierarchyRole: null, hierarchyName: null }], [{ hierarchyRole: "spv", hierarchyName: "" }], [{ hierarchyRole: null, hierarchyName: "SPV A" }]]) {
        const select = userBaris(baris);
        try {
            const scope = await getScopeForUser("u-1", PERIODE, IZIN_LIHAT);
            assert.ok(scope instanceof Set, `baris ${JSON.stringify(baris)}: null = lihat semua (fail-open)`);
            assert.equal(scope.size, 0);
        } finally {
            select.mock.restore();
        }
    }
});

test("izin perms absen (call-site lupa meneruskan) + tanpa identitas -> tetap kosong", async () => {
    const select = userBaris([{ hierarchyRole: null, hierarchyName: null }]);
    try {
        const scope = await getScopeForUser("u-1", PERIODE, undefined);
        assert.deepEqual(scope, new Set());
    } finally {
        select.mock.restore();
    }
});

test("pemegang izin kelola -> null (seluruh perusahaan) tanpa membaca user", async () => {
    const select = mock.method(db, "select", () => { throw new Error("TIDAK BOLEH MEMBACA"); });
    try {
        for (const k of ["insentif_sales.manage", "insentif_sales.manage_payment", "insentif_sales.manage_hierarchy", "insentif_sales.view_all"]) {
            assert.equal(canSeeAllInsentif(new Set([k])), true, k);
            assert.equal(await getScopeForUser("u-admin", PERIODE, new Set(["insentif_sales.view", k])), null, k);
        }
        assert.equal(select.mock.callCount(), 0);
    } finally {
        select.mock.restore();
    }
});

test("peran sales -> hanya kode dirinya (kontrol positif)", async () => {
    const select = userBaris([{ hierarchyRole: "sales", hierarchyName: "SALES A" }]);
    try {
        assert.deepEqual(await getScopeForUser("u-2", PERIODE, IZIN_LIHAT), new Set(["SALES A"]));
    } finally {
        select.mock.restore();
    }
});
