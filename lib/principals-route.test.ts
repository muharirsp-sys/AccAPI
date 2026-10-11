/* S7-2: penjaga route ASLI /api/principals/** tanpa DB nyata — sesi & grup izin dipalsukan; transaksi DB dipalsukan per uji
 * (bawaan: melempar "TIDAK BOLEH menulis DB"). 409 tabrakan, atomik + log, dan trigger nyata diuji di lib/principal-pg.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET as daftarGet, POST as buatPost } from "../app/api/principals/route.ts";
import { PATCH as principalPatch } from "../app/api/principals/[id]/route.ts";
import { GET as riwayatGet } from "../app/api/principals/[id]/history/route.ts";
import { PATCH as varianPatch, POST as varianPost } from "../app/api/principals/[id]/variants/route.ts";
import { POST as aliasPost } from "../app/api/principals/[id]/aliases/route.ts";
import { DELETE as aliasDelete } from "../app/api/principals/[id]/aliases/[aliasId]/route.ts";
import { auth } from "./auth.ts";
import { db } from "./db.ts";

type Opsi = { sesi?: boolean; transaksi?: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> };
async function sebagai<T>(keys: string[], fn: () => Promise<T>, opsi: Opsi = {}): Promise<T> {
    const saved = [
        [auth.api, "getSession", Object.getOwnPropertyDescriptor(auth.api, "getSession")],
        [db, "select", Object.getOwnPropertyDescriptor(db, "select")],
        [db, "transaction", Object.getOwnPropertyDescriptor(db, "transaction")],
    ] as const;
    const env = process.env.LOCAL_AUTH_BYPASS;
    delete process.env.LOCAL_AUTH_BYPASS;
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => (opsi.sesi === false ? null : { user: { id: "u-prin", role: "staff" }, session: { id: "s1" } }) });
    // Grup izin (getUserPermissions); tanpa grup -> legacy user.role tidak ditemukan -> tanpa izin.
    Object.defineProperty(db, "select", { configurable: true, value: () => ({ from: () => ({
        leftJoin: () => ({ where: async () => keys.map((key) => ({ groupId: "g1", key })) }),
        where: () => ({ limit: async () => [] }),
    }) }) });
    Object.defineProperty(db, "transaction", { configurable: true, value: opsi.transaksi ?? (() => { throw new Error("TIDAK BOLEH menulis DB"); }) });
    try {
        return await fn();
    } finally {
        for (const [obj, k, d] of saved) {
            if (d) Object.defineProperty(obj, k, d);
            else delete (obj as unknown as Record<string, unknown>)[k];
        }
        if (env === undefined) delete process.env.LOCAL_AUTH_BYPASS;
        else process.env.LOCAL_AUTH_BYPASS = env;
    }
}

const req = (method: string, url: string, body?: unknown) => new NextRequest(`http://app.test${url}`, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
});
const ctx = (id = "p1", aliasId = "a1") => ({ params: Promise.resolve({ id, aliasId }) });
const VIEW = ["principles.view"], UPLOAD = ["principles.view", "principles.upload"], SEMUA = [...UPLOAD, "principles.delete"];

test("401 tanpa sesi; 403 tanpa izin yang tepat di setiap route (sebelum DB)", async () => {
    assert.equal((await sebagai(VIEW, () => daftarGet(req("GET", "/api/principals")), { sesi: false })).status, 401);
    const kasus: [string[], () => Promise<Response>][] = [
        [[], () => daftarGet(req("GET", "/api/principals"))],
        [[], () => riwayatGet(req("GET", "/api/principals/p1/history"), ctx())],
        [VIEW, () => buatPost(req("POST", "/api/principals", { code: "ZZ", name: "ZZ, PT" }))],
        [VIEW, () => principalPatch(req("PATCH", "/api/principals/p1", { isActive: false }), ctx())],
        [VIEW, () => varianPost(req("POST", "/api/principals/p1/variants", { variantKey: "MT" }), ctx())],
        [VIEW, () => varianPatch(req("PATCH", "/api/principals/p1/variants", { variantKey: "MT", isActive: false }), ctx())],
        [VIEW, () => aliasPost(req("POST", "/api/principals/p1/aliases", { alias: "X", jenis: "nama" }), ctx())],
        [UPLOAD, () => aliasDelete(req("DELETE", "/api/principals/p1/aliases/a1"), ctx())],
    ];
    for (const [izin, panggil] of kasus) {
        const res = await sebagai(izin, panggil);
        assert.equal(res.status, 403, `${izin.join(",")} -> ${res.status}`);
    }
});

test("kode tidak bisa diubah: PATCH berisi code -> 400 KODE_TETAP; field lain -> 400 FIELD_TIDAK_DIDUKUNG (tanpa DB)", async () => {
    const kode = await sebagai(UPLOAD, () => principalPatch(req("PATCH", "/api/principals/p1", { code: "KINO2", isActive: true }), ctx()));
    assert.equal(kode.status, 400);
    assert.equal((await kode.json()).code, "KODE_TETAP");
    const nama = await sebagai(UPLOAD, () => principalPatch(req("PATCH", "/api/principals/p1", { name: "Baru" }), ctx()));
    assert.deepEqual([nama.status, (await nama.json()).code], [400, "FIELD_TIDAK_DIDUKUNG"]);
    const varian = await sebagai(UPLOAD, () => varianPatch(req("PATCH", "/api/principals/p1/variants", { variantKey: "MT", newKey: "XT", isActive: true }), ctx()));
    assert.deepEqual([varian.status, (await varian.json()).code], [400, "FIELD_TIDAK_DIDUKUNG"]);
});

test("validasi isian -> 400 berkode sebelum DB", async () => {
    const cek = async (res: Promise<Response>, code: string) => {
        const r = await res;
        assert.deepEqual([r.status, (await r.json()).code], [400, code]);
    };
    await sebagai(UPLOAD, async () => {
        await cek(buatPost(req("POST", "/api/principals", "bukan json")), "BODY_TIDAK_SAH");
        await cek(buatPost(req("POST", "/api/principals", [1])), "BODY_TIDAK_SAH");
        await cek(buatPost(req("POST", "/api/principals", { code: "KI NO", name: "x" })), "KODE_TIDAK_SAH");
        await cek(buatPost(req("POST", "/api/principals", { code: "KINO", name: "   " })), "TIDAK_SAH");
        await cek(principalPatch(req("PATCH", "/api/principals/p1", { isActive: "false" }), ctx()), "TIDAK_SAH");
        await cek(varianPost(req("POST", "/api/principals/p1/variants", {}), ctx()), "VARIAN_TIDAK_SAH");
        await cek(varianPost(req("POST", "/api/principals/p1/variants", { variantKey: "NON FOOD" }), ctx()), "VARIAN_TIDAK_SAH");
        await cek(aliasPost(req("POST", "/api/principals/p1/aliases", { alias: "X", jenis: "kode" }), ctx()), "JENIS_TIDAK_SAH");
        await cek(aliasPost(req("POST", "/api/principals/p1/aliases", { alias: "KINO", jenis: "kode_master_barang" }), ctx()), "KODE_MB_TIDAK_SAH");
        await cek(aliasPost(req("POST", "/api/principals/p1/aliases", { alias: "X", jenis: "nama", sumber: "kode_principal" }), ctx()), "SUMBER_KHUSUS");
    });
});

test("503 PRINCIPAL_DDL_BELUM bila trigger penjaga tidak ada — tidak ada tulisan sesudah pemeriksaan", async () => {
    const tulisan: string[] = [];
    const tx = {
        execute: async () => ({ rows: [{ nama: "trg_principal_code_tetap" }] }),
        select: () => { tulisan.push("select"); throw new Error("tidak boleh sampai sini"); },
        insert: () => { tulisan.push("insert"); throw new Error("tidak boleh sampai sini"); },
    };
    const transaksi = async (fn: (t: unknown) => Promise<unknown>) => fn(tx);
    const panggilan = [
        () => buatPost(req("POST", "/api/principals", { code: "ZZ", name: "ZZ, PT" })),
        () => principalPatch(req("PATCH", "/api/principals/p1", { isActive: false }), ctx()),
        () => varianPost(req("POST", "/api/principals/p1/variants", { variantKey: "MT" }), ctx()),
        () => varianPatch(req("PATCH", "/api/principals/p1/variants", { variantKey: "MT", isActive: false }), ctx()),
        () => aliasPost(req("POST", "/api/principals/p1/aliases", { alias: "X", jenis: "nama" }), ctx()),
        () => aliasDelete(req("DELETE", "/api/principals/p1/aliases/a1"), ctx()),
    ];
    for (const p of panggilan) {
        const res = await sebagai(SEMUA, p, { transaksi });
        const body = await res.json();
        assert.deepEqual([res.status, body.code, body.kurang], [503, "PRINCIPAL_DDL_BELUM", ["trg_principal_code_tetap"]]);
    }
    assert.deepEqual(tulisan, []);
});

test("galat baca = 500 berkode, BUKAN daftar kosong", async () => {
    const res = await sebagai(VIEW, () => daftarGet(req("GET", "/api/principals")), { transaksi: async () => { throw new Error("koneksi putus"); } });
    const body = await res.json();
    assert.deepEqual([res.status, body.ok, body.code, body.principals], [500, false, "GAGAL", undefined]);
});
