/* S7-2b di Postgres EVALUASI (AM040_DATABASE_URL, bukan produksi): route ASLI Mapping Principal (PUT/GET/DELETE + impor) dan Master
 * Barang (POST action create) memakai tabel principal resmi. SKEMA SEKALI-PAKAI (search_path hanya skema itu, DROP di akhir):
 * DDL_S7_0 + DDL_S7_2 + migrasi 0007/0010 (principal_mapping) + 0019 (master_barang). Principal/varian/alias dibuat lewat route ASLI
 * /api/principals (bentuk sama dengan benih produksi). Route Mapping memakai `headers()` (next/headers): dijalankan dalam lingkup permintaan
 * tiruan (pola lib/form-kontrol/fk-msm-pg.test.ts). Sesi & grup izin dipalsukan. Data contoh generik (PRINCIPLE A/B). Tanpa env dilewati. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import * as XLSX from "xlsx";
import { userGroup } from "../db/schema.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";
const skema = `uji_s72b_${randomUUID().slice(0, 8)}`;
const IZIN = ["principles.view", "principles.upload", "principles.delete", "master_barang.create"];
let admin: Pool;
let pool: Pool;
const urlSkema = () => { const u = new URL(PG_URL); u.searchParams.set("options", `-c search_path=${skema}`); return u.toString(); };
const berkas = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

type Route = (req: Request, ctx?: unknown) => Promise<Response>;
async function muat() {
    (globalThis as Record<string, unknown>).AsyncLocalStorage ??= AsyncLocalStorage;
    const r = (p: string) => import(p) as Promise<Record<string, Route>>;
    return {
        ...await import("next/dist/server/app-render/work-async-storage.external.js"),
        ...await import("next/dist/server/app-render/work-unit-async-storage.external.js"),
        NextRequest: (await import("next/server")).NextRequest,
        auth: (await import("./auth.ts")).auth,
        db: (await import("./db.ts")).db,
        principals: await r("../app/api/principals/route.ts"),
        varian: await r("../app/api/principals/[id]/variants/route.ts"),
        alias: await r("../app/api/principals/[id]/aliases/route.ts"),
        satu: await r("../app/api/principals/[id]/route.ts"),
        mapping: await r("../app/api/principal-mapping/route.ts"),
        impor: await r("../app/api/principal-mapping/import/route.ts"),
        masterBarang: await r("../app/api/master-barang/route.ts"),
    };
}
let m: Awaited<ReturnType<typeof muat>>;

/** Lingkup permintaan Next tiruan (untuk `headers()` di route Mapping). */
function lingkup<T>(fn: () => Promise<T>): Promise<T> {
    const store = { route: "/uji", forceStatic: false, dynamicShouldError: false };
    const unit = { type: "private-cache", phase: "render", headers: new Headers({ host: "app.test" }) };
    return m.workAsyncStorage.run(store as never, () => m.workUnitAsyncStorage.run(unit as never, fn));
}
const json = (method: string, url: string, body?: unknown) => new m.NextRequest(`http://app.test${url}`, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});
async function jawab(fn: () => Promise<Response>) {
    const r = await lingkup(fn);
    return { status: r.status, body: await r.json() as Record<string, unknown> & { code?: string } };
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;

before(async () => {
    if (!PG_URL) return;
    admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${skema}`);
    pool = new Pool({ connectionString: urlSkema(), max: 2 });
    await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE);
        CREATE TABLE access_group (id text PRIMARY KEY, name text NOT NULL UNIQUE, is_preset boolean NOT NULL DEFAULT false);
        CREATE TABLE user_group (user_id text NOT NULL REFERENCES "user"(id), group_id text NOT NULL REFERENCES access_group(id),
            assigned_by text, assigned_at timestamp NOT NULL, PRIMARY KEY (user_id, group_id));`);
    for (const f of ["../docs/handover/DDL_S7_0.sql", "../docs/handover/DDL_S7_2.sql", "../db/migrations/0007_principal_mapping.sql",
        "../db/migrations/0010_principal_mapping_brand.sql", "../db/migrations/0019_master_barang.sql"]) await pool.query(await berkas(f));
    process.env.DATABASE_URL = urlSkema();
    delete process.env.LOCAL_AUTH_BYPASS;
    m = await muat();
    Object.defineProperty(m.auth.api, "getSession", { configurable: true, value: async () => ({ user: { id: "u-a", email: "a@uji.test", role: "staff" }, session: { id: "s1" } }) });
    const realSelect = m.db.select.bind(m.db);
    Object.defineProperty(m.db, "select", { configurable: true, value: (...a: unknown[]) => {
        const b = (realSelect as (...x: unknown[]) => { from: (t: unknown) => unknown })(...a);
        const realFrom = b.from.bind(b);
        b.from = (t: unknown) => (t === userGroup ? { leftJoin: () => ({ where: async () => IZIN.map((key) => ({ groupId: "g", key })) }) } : realFrom(t));
        return b;
    } });

    // Bentuk benih produksi 17 Okt: KINO + varian NON_FOOD "KINO NON FOOD"; GDI; PRINCIPLE A nonaktif. Alias label & kode MB.
    const buat = async (code: string, name: string) => {
        const r = await jawab(() => m.principals.POST(json("POST", "/api/principals", { code, name })));
        assert.equal(r.status, 201, JSON.stringify(r.body));
        return (r.body.principal as { id: string }).id;
    };
    const kino = await buat("KINO", "KINO INDONESIA TBK, PT");
    const gdi = await buat("GDI", "GODREJ DISTRIBUSI INDONESIA, PT");
    const pa = await buat("PA", "PRINCIPLE A");
    assert.equal((await jawab(() => m.varian.POST(json("POST", `/api/principals/${kino}/variants`, { variantKey: "NON_FOOD", name: "KINO NON FOOD" }), ctx(kino)))).status, 201);
    for (const [id, body] of [[kino, { alias: "K1", jenis: "kode_master_barang" }], [kino, { alias: "KN", jenis: "kode_master_barang", variantKey: "NON_FOOD" }],
        [gdi, { alias: "Godrej", jenis: "label_mapping" }]] as const) {
        const r = await jawab(() => m.alias.POST(json("POST", `/api/principals/${id}/aliases`, body), ctx(id)));
        assert.equal(r.status, 201, JSON.stringify(r.body));
    }
    assert.equal((await jawab(() => m.satu.PATCH(json("PATCH", `/api/principals/${pa}`, { isActive: false }), ctx(pa)))).status, 200);
    // Data lama produksi: principal_mapping hanya "KINO NON FOOD" — tidak boleh berubah kecuali ditulis ulang oleh pengguna.
    await pool.query(`INSERT INTO principal_mapping (principal, kind, source_code, target_code, unit, pack_size) VALUES
        ('KINO NON FOOD', 'item', '106072', 'K1111009005010B', 'BTL', 36), ('KINO NON FOOD', 'item', '106029', 'K1141002011010', 'BTL', 24),
        ('KINO NON FOOD', 'customer', '2191200122844', 'C-100001', NULL, NULL)`);
});

after(async () => {
    if (!PG_URL) return;
    await pool?.end();
    await (await import("./db.ts")).pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${skema} CASCADE`);
    await admin.end();
});

test("PG S7-2b: simpan mapping — alias/varian disimpan di nama resmi (data lama 'KINO NON FOOD' tetap satu set); tak dikenal 400 / nonaktif 409 tanpa tulisan", { skip: pgSkip }, async () => {
    const put = (principal: string, sourceCode = "106072", kind = "item") => jawab(() => m.mapping.PUT(json("PUT", "/api/principal-mapping",
        { principal, kind, sourceCode, targetCode: "K-BARU", unit: "pcs", packSize: 12 })));
    const ubah = await put(" kino non  food ");
    assert.deepEqual([ubah.status, ubah.body.principal], [200, "KINO NON FOOD"], JSON.stringify(ubah.body));
    assert.deepEqual(await q(`SELECT principal, target_code FROM principal_mapping WHERE source_code = '106072'`), [{ principal: "KINO NON FOOD", target_code: "K-BARU" }],
        "baris lama ditimpa di set yang sama, bukan set baru berejaan lain");
    const utuh = await put("kino", "C-1", "customer");
    assert.deepEqual([utuh.status, utuh.body.principal], [200, "KINO INDONESIA TBK, PT"], "principal utuh = nama resmi");

    const sebelum = await q(`SELECT principal, kind, source_code, target_code FROM principal_mapping ORDER BY 1, 2, 3`);
    const asing = await put("PRINCIPLE B");
    assert.deepEqual([asing.status, asing.body.code], [400, "PRINCIPAL_TIDAK_DIKENAL"]);
    assert.deepEqual(asing.body.ditolak, [{ nilai: "PRINCIPLE B", saran: [] }]);
    assert.equal(typeof asing.body.error, "string");
    const mirip = await put("PT. KINO");
    assert.deepEqual((mirip.body.ditolak as { saran: { code: string; variantKey: string | null }[] }[])[0].saran.map((s) => `${s.code}/${s.variantKey}`),
        ["KINO/null", "KINO/NON_FOOD"], "saran kandidat, bukan dipakai otomatis");
    const mati = await put("principle a");
    assert.deepEqual([mati.status, mati.body.code, (mati.body.principal as { code: string }).code], [409, "PRINCIPAL_NONAKTIF", "PA"]);
    assert.deepEqual(await q(`SELECT principal, kind, source_code, target_code FROM principal_mapping ORDER BY 1, 2, 3`), sebelum, "ditolak = tidak ada yang ditulis");

    // Baca & hapus memakai nama resmi yang sama (ejaan apa pun yang dikenal); ejaan tak dikenal tetap membaca apa adanya.
    const baca = await jawab(() => m.mapping.GET(json("GET", `/api/principal-mapping?principal=${encodeURIComponent("Kino Non Food")}&kind=item`)));
    assert.deepEqual([baca.status, baca.body.total], [200, 2]);
    const lama = await jawab(() => m.mapping.GET(json("GET", `/api/principal-mapping?principal=TIDAK%20ADA&kind=item`)));
    assert.deepEqual([lama.status, lama.body.total], [200, 0]);
    const hapus = await jawab(() => m.mapping.DELETE(json("DELETE", `/api/principal-mapping?principal=${encodeURIComponent("kino non food")}&kind=item&sourceCode=106029`)));
    assert.deepEqual([hapus.status, hapus.body.removed], [200, 1]);
});

function xlsx(baris: unknown[][]) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(baris), "Mapping_Prd");
    return new File([XLSX.write(wb, { type: "buffer", bookType: "xlsx" })], "mapping.xlsx");
}
const impor = (principal: string, apply: boolean, file = xlsx([["KODE ITEM", "Kode Alias", "Satuan", "ISI"], ["K-1", "900001", "PCS", "12"], ["K-2", "900002", "BTL", "24"]])) => {
    const form = new FormData();
    form.append("file", file);
    form.append("principal", principal);
    form.append("kinds", "item");
    form.append("apply", String(apply));
    return jawab(() => m.impor.POST(new m.NextRequest("http://app.test/api/principal-mapping/import", { method: "POST", body: form })));
};

test("PG S7-2b: impor mapping — principal tak dikenal ditolak SEBELUM berkas dibaca (pratinjau juga); alias/varian mengganti set nama resmi", { skip: pgSkip }, async () => {
    const sebelum = await q(`SELECT principal, kind, source_code FROM principal_mapping ORDER BY 1, 2, 3`);
    for (const apply of [false, true]) {
        const r = await impor("KINO NONFOOD", apply);
        assert.deepEqual([r.status, r.body.code], [400, "PRINCIPAL_TIDAK_DIKENAL"], `apply=${apply}`);
        const [d] = r.body.ditolak as { nilai: string; saran: { code: string; variantKey: string | null; nama: string }[] }[];
        assert.equal(d.nilai, "KINO NONFOOD");
        assert.ok(d.saran.some((s) => s.code === "KINO" && s.variantKey === "NON_FOOD" && s.nama === "KINO NON FOOD"), JSON.stringify(d.saran));
    }
    const mati = await impor("PRINCIPLE A", true);
    assert.deepEqual([mati.status, mati.body.code], [409, "PRINCIPAL_NONAKTIF"]);
    assert.deepEqual(await q(`SELECT principal, kind, source_code FROM principal_mapping ORDER BY 1, 2, 3`), sebelum, "data lama utuh");

    const pratinjau = await impor("kino non food", false);
    assert.deepEqual([pratinjau.status, pratinjau.body.applied, pratinjau.body.principal], [200, false, "KINO NON FOOD"]);
    const muat = await impor("Kino Non Food", true);
    assert.deepEqual([muat.status, muat.body.applied, muat.body.principal], [200, true, "KINO NON FOOD"], JSON.stringify(muat.body));
    assert.deepEqual(await q(`SELECT principal, kind, source_code FROM principal_mapping WHERE kind = 'item' ORDER BY 1, 3`), [
        { principal: "KINO NON FOOD", kind: "item", source_code: "900001" }, { principal: "KINO NON FOOD", kind: "item", source_code: "900002" },
    ], "set item KINO NON FOOD diganti; tak ada set 'Kino Non Food' baru");
    assert.equal((await q(`SELECT count(*)::int AS n FROM principal_mapping WHERE principal = 'KINO NON FOOD' AND kind = 'customer'`))[0].n, 1, "jenis lain tak tersentuh");

    const label = await impor("GODREJ", true);
    assert.deepEqual([label.status, label.body.principal], [200, "GODREJ DISTRIBUSI INDONESIA, PT"], "alias label_mapping -> nama resmi");
});

test("PG S7-2b: Master Barang createMaster — principal & kode 2 karakter dari Data Principal (tanpa tebakan); tak dikenal/kode salah ditolak tanpa tulisan", { skip: pgSkip }, async () => {
    const buat = (principleName: string, principleCode?: string) => jawab(() => m.masterBarang.POST(json("POST", "/api/master-barang", { action: "create", principleName, principleCode })));
    const jumlah = async () => (await q(`SELECT count(*)::int AS n FROM master_barang`))[0].n as number;

    const asing = await buat("PRINCIPLE B");
    assert.deepEqual([asing.status, asing.body.code, (asing.body.ditolak as { nilai: string }[])[0].nilai], [400, "PRINCIPAL_TIDAK_DIKENAL", "PRINCIPLE B"]);
    const mati = await buat("PRINCIPLE A", "PA");
    assert.deepEqual([mati.status, mati.body.code], [409, "PRINCIPAL_NONAKTIF"]);
    const tanpaKode = await buat("GODREJ");
    assert.deepEqual([tanpaKode.status, tanpaKode.body.code, tanpaKode.body.pilihan], [400, "KODE_MB_TIDAK_COCOK", []], "belum ada kode MB = ditolak, bukan dibuat otomatis");
    const pilih = await buat("kino non food");
    assert.deepEqual([pilih.status, pilih.body.code, pilih.body.pilihan, pilih.body.kodeMb], [400, "KODE_MB_TIDAK_COCOK", ["K1", "KN"], null]);
    const salah = await buat("KINO", "GD");
    assert.deepEqual([salah.status, salah.body.code, salah.body.pilihan], [400, "KODE_MB_TIDAK_COCOK", ["K1"]]);
    assert.equal(await jumlah(), 0, "ditolak = tidak ada master");

    const ok = await buat("kino non food", "kn");
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const master = ok.body.master as { principleName: string; principleCode: string; principleNameNorm: string };
    assert.deepEqual([master.principleName, master.principleCode], ["KINO NON FOOD", "KN"]);
    const satu = await buat("KINO");
    assert.deepEqual([satu.status, (satu.body.master as { principleName: string; principleCode: string }).principleCode,
        (satu.body.master as { principleName: string }).principleName], [200, "K1", "KINO INDONESIA TBK, PT"], "satu-satunya kode utuh dipakai");
    const audit = await q(`SELECT detail->'principal' AS p FROM master_barang_audit WHERE action = 'master.create' ORDER BY created_at`);
    assert.deepEqual(audit.map((a) => a.p), [{ code: "KINO", variantKey: "NON_FOOD" }, { code: "KINO", variantKey: null }]);
});
