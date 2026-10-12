/* O1 (owner 12 Okt 2026) TANPA DB: pemetaan tag divisi barang `charField2` -> cabang (22 cabang + 6 pemetaan + 6 non-jual + tak dikenal),
 * baris sync item dari list.do tiruan, pembantu query, field sync yang wajib diminta, dan gerbang 401/403/400 route baru SEBELUM DB.
 * Perilaku DB nyata (sync, cakupan salesman, pencarian, harga per cabang, tautan) = lib/order-cabang-pg.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { auth } from "./auth.ts";
import { db } from "./db.ts";
import { angkaQuery, cabangDariTag, normalNama, petaCabang, polaLike, TAG_KE_CABANG, TAG_NON_JUAL, tolakCabangLain } from "./order-cabang.ts";
import { barisItem } from "./sync.ts";
import * as preview from "../app/api/orders/preview/route.ts";
import * as harga from "../app/api/orders/harga/route.ts";
import * as salesmen from "../app/api/orders/salesmen/route.ts";
import * as cariPelanggan from "../app/api/customers/search/route.ts";
import * as cariBarang from "../app/api/items/search/route.ts";
import * as tautan from "../app/api/admin/users/[id]/salesman/route.ts";

// 22 cabang Accurate produksi (probe 12 Okt 2026, tabel `branch`), id sintetis.
const CABANG_22 = ["ABC", "CUSSONS", "DOLPHIN", "ENERGIZER", "FORISA", "FORISA - MT", "GODREJ", "HEINZ", "KINO NON FOOD", "Kantor Pusat",
    "MIX FOOD", "MIX NON FOOD", "MONTISS", "MOTASA", "MSM", "PRIMARASA", "PURATOS", "RECKITT", "SHINZUI", "UNIBIS", "URC", "VINDA"];
const PETA = petaCabang(CABANG_22.map((name, i) => ({ id: 100 + i, name })));
const id = (nama: string) => 100 + CABANG_22.indexOf(nama);

test("tag = nama cabang (22, termasuk ejaan huruf kecil/spasi ganda) -> cabang itu", () => {
    assert.equal(CABANG_22.length, 22);
    for (const nama of CABANG_22) {
        assert.deepEqual(cabangDariTag(nama, PETA), { branchId: id(nama), jenis: "cabang" }, nama);
        assert.deepEqual(cabangDariTag(`  ${nama.toLowerCase().replace(/ /g, "  ")} `, PETA), { branchId: id(nama), jenis: "cabang" }, `${nama} ternormal`);
    }
    // Tanda baca TIDAK diubah: "FORISA-MT" bukan "FORISA - MT" (menebak = salah cabang diam-diam).
    assert.equal(cabangDariTag("FORISA-MT", PETA).jenis, "tak_dikenal");
});

test("6 pemetaan owner (revisi 12 Okt): 24MNF1/21MNF2 -> MIX NON FOOD, FRN -> SHINZUI, HEINZ ABC -> HEINZ, MIX2 -> DOLPHIN, FKS -> MIX FOOD", () => {
    const harap: Record<string, string> = { "24MNF1": "MIX NON FOOD", "21MNF2": "MIX NON FOOD", FRN: "SHINZUI", "HEINZ ABC": "HEINZ", MIX2: "DOLPHIN", FKS: "MIX FOOD" };
    assert.deepEqual({ ...TAG_KE_CABANG }, harap, "konstanta = keputusan owner, persis");
    for (const [tag, cabang] of Object.entries(harap)) {
        assert.deepEqual(cabangDariTag(tag, PETA), { branchId: id(cabang), jenis: "peta" }, tag);
        assert.deepEqual(cabangDariTag(` ${tag.toLowerCase()} `, PETA), { branchId: id(cabang), jenis: "peta" }, `${tag} ternormal`);
    }
});

test("non-jual (6) -> null; kosong -> null; tak dikenal -> null bertanda; target peta absen di tabel branch -> tak dikenal", () => {
    assert.deepEqual([...TAG_NON_JUAL].sort(), ["ALAT TULIS KANTOR", "AMARON", "ASSET", "LAKBAN BENING", "PEMBELIAN ASET", "PRINTER"]);
    for (const tag of TAG_NON_JUAL) assert.deepEqual(cabangDariTag(tag.toLowerCase(), PETA), { branchId: null, jenis: "non_jual" }, tag);
    for (const kosong of [null, undefined, "", "   "]) assert.deepEqual(cabangDariTag(kosong, PETA), { branchId: null, jenis: "kosong" });
    for (const asing of ["XYZ", "KINO", "HEINZABC", "MNF", "24MNF3"]) assert.deepEqual(cabangDariTag(asing, PETA), { branchId: null, jenis: "tak_dikenal" }, asing);
    // Tabel branch belum tersinkron: tag yang benar pun tak bisa dipetakan -> tercatat, bukan cabang tebakan.
    assert.deepEqual(cabangDariTag("FKS", new Map()), { branchId: null, jenis: "tak_dikenal" });
    assert.deepEqual(cabangDariTag("GODREJ", new Map()), { branchId: null, jenis: "tak_dikenal" });
    assert.equal(normalNama("  Kino   non food "), "KINO NON FOOD");
});

test("sync item (list.do tiruan): cabang dari tag, suspended, tag asli, hitungan tak dikenal/kosong", () => {
    const halaman = [
        { id: 1, no: "K-01", name: "SABUN A", unitPrice: 6306, itemType: "INVENTORY", charField1: "PT KINO", charField2: "KINO NON FOOD", suspended: false },
        { id: 2, no: "H-01", name: "SAUS B", unitPrice: "12000", itemType: "INVENTORY", charField2: "HEINZ ABC", suspended: true },
        { id: 3, no: "ATK-1", name: "PULPEN", itemType: "NON_INVENTORY", charField2: "ALAT TULIS KANTOR" },
        { id: 4, no: "X-01", name: "BARANG ASING", charField2: "TAG BARU" },
        { id: 5, no: "Z-01", name: "TANPA TAG" },
    ];
    const hasil = halaman.map((row) => barisItem(row, PETA));
    assert.deepEqual(hasil.map((h) => [h.payload.no, h.payload.branchId, h.jenis]), [
        ["K-01", id("KINO NON FOOD"), "cabang"], ["H-01", id("HEINZ"), "peta"], ["ATK-1", null, "non_jual"],
        ["X-01", null, "tak_dikenal"], ["Z-01", null, "kosong"],
    ]);
    assert.deepEqual(hasil.map((h) => h.payload.suspended), [false, true, false, false, false]);
    assert.deepEqual(hasil.map((h) => h.payload.charField2), ["KINO NON FOOD", "HEINZ ABC", "ALAT TULIS KANTOR", "TAG BARU", null]);
    assert.equal(hasil[1].payload.unitPrice, 12000);
    assert.deepEqual(hasil.filter((h) => h.jenis === "tak_dikenal" || h.jenis === "kosong").map((h) => h.tag), ["TAG BARU", "(kosong)"]);
    assert.equal(JSON.parse(hasil[0].payload.rawData).charField1, "PT KINO", "charField1/preferedVendor hidup di raw_data");
});

test("sync meminta charField2/suspended barang dan suspended pelanggan (list.do mengabaikan field yang tidak diminta)", () => {
    const src = readFileSync(new URL("./sync.ts", import.meta.url), "utf8");
    const fieldsOf = (endpoint: string) => {
        const m = src.match(new RegExp(`endpoint:\\s*"${endpoint.replace(/\//g, "\\/")}"[\\s\\S]*?fields:\\s*"([^"]+)"`));
        assert.ok(m, endpoint);
        return m[1].split(",");
    };
    for (const f of ["id", "charField1", "charField2", "suspended", "preferedVendor"]) assert.ok(fieldsOf("/item/list.do").includes(f), `item ${f}`);
    for (const f of ["id", "branch", "suspended"]) assert.ok(fieldsOf("/customer/list.do").includes(f), `customer ${f}`);
});

test("pembantu: polaLike meng-escape % _ \\; angkaQuery; tolakCabangLain", () => {
    assert.equal(polaLike("50%_a\\b"), "%50\\%\\_a\\\\b%");
    assert.equal(angkaQuery(null), null);
    assert.equal(angkaQuery(" "), null);
    assert.equal(angkaQuery("12"), 12);
    for (const salah of ["-1", "1.5", "abc", "1e3", "9".repeat(16)]) assert.equal(angkaQuery(salah), undefined, salah);
    const sales = { semua: false as const, branchId: 7, branchName: "KINO NON FOOD", salesCode: "M-A" };
    assert.equal(tolakCabangLain({ semua: true }, 9, "x"), null);
    assert.equal(tolakCabangLain(sales, null, "x"), null);
    assert.equal(tolakCabangLain(sales, 7, "x"), null);
    assert.equal(tolakCabangLain(sales, 9, "Pelanggan C")?.kode, "CABANG_DI_LUAR_CAKUPAN");
    assert.equal(tolakCabangLain(sales, 9, "Pelanggan C")?.status, 403);
});

// ---------------------------------------------------------------- gerbang route TANPA DB

/** Sesi palsu (null = tanpa sesi) + kunci grup; db tulis/transaksi/execute DILARANG (gerbang harus menolak sebelum DB). */
async function sebagai<T>(keys: string[] | null, fn: () => Promise<T>): Promise<T> {
    const saved = (["select", "transaction", "insert", "update", "delete", "execute"] as const).map((k) => [k, Object.getOwnPropertyDescriptor(db, k)] as const);
    const savedSes = Object.getOwnPropertyDescriptor(auth.api, "getSession");
    const env = { bypass: process.env.LOCAL_AUTH_BYPASS, cron: process.env.CRON_SECRET };
    delete process.env.LOCAL_AUTH_BYPASS;
    process.env.CRON_SECRET = "rahasia-uji";
    const dilarang = () => { throw new Error("DB tidak boleh tersentuh di uji gerbang"); };
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => (keys ? { user: { id: "u-uji", name: "Uji", role: "admin" }, session: { id: "s" } } : null) });
    const rows = (keys ?? []).map((key) => ({ groupId: "g", key }));
    Object.defineProperty(db, "select", { configurable: true, value: () => ({ from: () => ({ leftJoin: () => ({ where: async () => rows }) }) }) });
    for (const k of ["transaction", "insert", "update", "delete", "execute"]) Object.defineProperty(db, k, { configurable: true, value: dilarang });
    try {
        return await fn();
    } finally {
        for (const [k, d] of saved) { if (d) Object.defineProperty(db, k, d); else delete (db as unknown as Record<string, unknown>)[k]; }
        if (savedSes) Object.defineProperty(auth.api, "getSession", savedSes);
        if (env.bypass !== undefined) process.env.LOCAL_AUTH_BYPASS = env.bypass;
        if (env.cron === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = env.cron;
    }
}

const req = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => new NextRequest(`http://localhost${url}`, {
    method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const ctx = { params: Promise.resolve({ id: "u-target" }) };
type H = (r: NextRequest, c: typeof ctx) => Promise<Response>;

const TITIK: Array<[string, H, string, string, string[]]> = [
    ["POST orders/preview", preview.POST as unknown as H, "POST", "/api/orders/preview", ["order.view", "websales.view", "order.edit"]],
    ["POST orders/harga", harga.POST as unknown as H, "POST", "/api/orders/harga", ["order.view", "websales.view"]],
    ["GET customers/search", cariPelanggan.GET as unknown as H, "GET", "/api/customers/search?q=a", ["order.view", "websales.view"]],
    ["GET items/search", cariBarang.GET as unknown as H, "GET", "/api/items/search?q=a", ["order.view", "websales.view"]],
    ["GET orders/salesmen", salesmen.GET as unknown as H, "GET", "/api/orders/salesmen", ["order.view", "order.create"]],
    ["GET admin salesman", tautan.GET, "GET", "/api/admin/users/u-target/salesman", ["order.edit", "websales.create"]],
    ["PUT admin salesman", tautan.PUT, "PUT", "/api/admin/users/u-target/salesman", ["users.view", "order.edit"]],
    ["DELETE admin salesman", tautan.DELETE, "DELETE", "/api/admin/users/u-target/salesman", ["users.view"]],
];

test("gerbang: tanpa sesi 401; izin salah 403 — sebelum DB (termasuk users.view tidak cukup untuk menulis tautan)", async () => {
    for (const [nama, h, method, url, salah] of TITIK) {
        const body = method === "GET" || method === "DELETE" ? undefined : {};
        assert.equal((await sebagai(null, () => h(req(method, url, body), ctx))).status, 401, `${nama} tanpa sesi`);
        assert.equal((await sebagai(salah, () => h(req(method, url, body), ctx))).status, 403, `${nama} izin ${salah.join(",")}`);
    }
});

test("gerbang: orders/harga dengan CRON_SECRET melewati sesi; badan tidak valid 400 sebelum DB; secret salah = jalur sesi (401)", async () => {
    const bearer = { authorization: "Bearer rahasia-uji" };
    for (const badan of [{}, { order_date: "12-10-2026", lines: [{ code: "A", unit: "PCS" }] }, { order_date: "2026-10-12", lines: [] },
        { order_date: "2026-10-12", lines: [{ code: "A", unit: "" }] }]) {
        const r = await sebagai(null, () => harga.POST(req("POST", "/api/orders/harga", badan, bearer)));
        assert.equal(r.status, 400, JSON.stringify(badan));
        assert.equal((await r.json()).kode, "INPUT_TIDAK_VALID");
    }
    const salah = await sebagai(null, () => harga.POST(req("POST", "/api/orders/harga", {}, { authorization: "Bearer bukan" })));
    assert.equal(salah.status, 401);
});

test("gerbang: query tidak valid 400 sebelum DB (pencarian, salesmen); PUT tautan tanpa employeeNumber 400", async () => {
    const pel = ["websales.create"];
    for (const url of ["/api/customers/search?limit=0", "/api/customers/search?limit=51", "/api/customers/search?branchId=abc"]) {
        assert.equal((await sebagai(pel, () => cariPelanggan.GET(req("GET", url)))).status, 400, url);
    }
    for (const url of ["/api/items/search?customerId=x", "/api/items/search?tanggal=12-10-2026", "/api/items/search?limit=99"]) {
        assert.equal((await sebagai(pel, () => cariBarang.GET(req("GET", url)))).status, 400, url);
    }
    assert.equal((await sebagai(["order.edit"], () => salesmen.GET(req("GET", "/api/orders/salesmen?branchId=-3")))).status, 400);
    const put = await sebagai(["users.manage"], () => tautan.PUT(req("PUT", "/api/admin/users/u-target/salesman", { employeeNumber: "  " }), ctx));
    assert.equal(put.status, 400);
    assert.equal((await put.json()).code, "INPUT_TIDAK_VALID");
});
