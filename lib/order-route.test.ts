/* Uji route order (tanpa Postgres, tanpa jaringan): sesi & grup dipalsukan, `db` diganti tiruan per tabel yang MENCATAT kueri.
 * - BL-21 (owner 6 Okt, tinjauan S6d B-H1/A-M2): batch Order Principal yang SO-nya sudah punya baris Antrean Faktur TIDAK boleh
 *   dihapus atau diganti — ditegakkan server di dalam transaksi (409), `replace=true` butuh `order.edit` (ia menghapus batch lama);
 *   status antrean batch dibaca dari SEMUA nomor SO batch, bukan hanya kandidat yang lolos validasi saat ini.
 * - C7 (owner 8 Okt, tinjauan S6d A-M1): payload faktur Order Masuk yang DIBEKUKAN ke antrean membawa salesman yang dipilih —
 *   `masterSalesmanId` + `salesmanListNumber` di setiap baris termasuk bonus, bentuk sama dengan jalur Order Principal. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as XLSX from "xlsx";
import { DELETE as hapusBatch, POST as unggahBatch } from "../app/api/principal-order/route.ts";
import { GET as statusAntrean } from "../app/api/principal-order/queue/route.ts";
import { POST as antreOrder } from "../app/api/orders/[id]/invoice/route.ts";
import { auth } from "./auth.ts";
import { db } from "./db.ts";
import { accurateEmployee, accurateUnit, customer, invoiceOutbox, principalMapping, principalOrderBatch, principalOrderLine, userGroup } from "../db/schema.ts";

type Tabel = object;
type Catatan = { where: { tabel: Tabel; params: unknown[] }[]; delete: Tabel[]; insert: { tabel: Tabel; values: unknown }[]; fetch: string[] };

const dialek = new PgDialect();
const paramsOf = (cond: unknown) => (cond ? dialek.sqlToQuery(cond as SQL).params : []);

/** Rantai kueri drizzle tiruan: setiap pemanggil `await` mendapat `rows`; kondisi `where` dicatat (param SQL-nya). */
function rantai(tabel: Tabel, rows: unknown[], catat: Catatan) {
    const c: Record<string, unknown> = {};
    for (const m of ["leftJoin", "innerJoin", "limit", "orderBy", "for"]) c[m] = () => c;
    c.where = (cond: unknown) => { catat.where.push({ tabel, params: paramsOf(cond) }); return c; };
    c.then = (ok: (v: unknown) => unknown, gagal?: (e: unknown) => unknown) => Promise.resolve(rows).then(ok, gagal);
    return c;
}

/** Jalankan `fn` sebagai user bergrup dengan izin `keys`; `tabel` = isi tiap tabel untuk SEMUA select (db dan transaksi). */
export async function denganDb<T>(keys: string[], tabel: Map<Tabel, unknown[]>, fn: (catat: Catatan) => Promise<T>, fetchPalsu?: (url: string) => Response): Promise<T> {
    const catat: Catatan = { where: [], delete: [], insert: [], fetch: [] };
    const izin = keys.map((key) => ({ groupId: "g1", key }));
    const pilih = () => ({ from: (t: Tabel) => rantai(t, t === userGroup ? izin : tabel.get(t) ?? [], catat) });
    const tx = {
        select: pilih, selectDistinct: pilih,
        delete: (t: Tabel) => ({
            where: (cond: unknown) => {
                catat.where.push({ tabel: t, params: paramsOf(cond) });
                catat.delete.push(t);
                const p = Promise.resolve([] as unknown[]);
                return Object.assign(p, { returning: async () => (tabel.get(t) ?? []).slice(0, 1) });
            },
        }),
        insert: (t: Tabel) => ({
            values: (values: unknown) => {
                catat.insert.push({ tabel: t, values });
                const rows = (Array.isArray(values) ? values : [values]).map((v) => ({ orderId: (v as { orderId?: string }).orderId }));
                const p = Promise.resolve(rows);
                return Object.assign(p, { onConflictDoNothing: () => ({ returning: async () => rows }), returning: async () => rows });
            },
        }),
    };
    const saved = [
        [auth.api, "getSession", Object.getOwnPropertyDescriptor(auth.api, "getSession")],
        [db, "select", Object.getOwnPropertyDescriptor(db, "select")],
        [db, "selectDistinct", Object.getOwnPropertyDescriptor(db, "selectDistinct")],
        [db, "delete", Object.getOwnPropertyDescriptor(db, "delete")],
        [db, "insert", Object.getOwnPropertyDescriptor(db, "insert")],
        [db, "transaction", Object.getOwnPropertyDescriptor(db, "transaction")],
        [globalThis, "fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch")],
    ] as const;
    const env = process.env.LOCAL_AUTH_BYPASS;
    delete process.env.LOCAL_AUTH_BYPASS;
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => ({ user: { id: "u-petugas", email: "petugas.a@contoh.test", role: "staff" }, session: { id: "s1" } }) });
    for (const [k, v] of Object.entries(tx)) Object.defineProperty(db, k, { configurable: true, value: v });
    Object.defineProperty(db, "transaction", { configurable: true, value: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx) });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string | URL) => {
        catat.fetch.push(String(url));
        if (!fetchPalsu) throw new Error("TIDAK BOLEH ke jaringan");
        return fetchPalsu(String(url));
    } });
    try {
        return await fn(catat);
    } finally {
        for (const [obj, k, d] of saved) {
            if (d) Object.defineProperty(obj, k, d);
            else delete (obj as unknown as Record<string, unknown>)[k];
        }
        if (env === undefined) delete process.env.LOCAL_AUTH_BYPASS;
        else process.env.LOCAL_AUTH_BYPASS = env;
    }
}

// ── BL-21 Order Principal ──────────────────────────────────────────────────────────────────────────────

const PRINCIPAL = "KINO NON FOOD";
const BATCH_LAMA = { id: "lama", principal: PRINCIPAL, fileName: "OrderDetail_CABANG-A_lama.xlsx", uploadedAt: new Date("2026-10-02T07:30:00Z"), period: "2026-10-02" };
const BARIS_LAMA = [{ soNo: "1671-SOP-260013022" }, { soNo: "1671-SOP-260013022" }, { soNo: "1671-SOP-260013024" }];
const ANTRE = [{ orderId: "KINO-NON-FOOD:1671-SOP-260013024", state: "posted" }];

function berkasOrderDetail(): File {
    const head = ["SLSMAN_ID", "CUST_ID1", "CUST_ID2", "CUSTOMER", "CUST_TYPE1", "SO_NO", "SO_DATE", "SO_STS", "PRD_ID", "PRD_DESC", "QTY", "PRICE",
        "GROSS", "DISC_1", "DISC_4", "DISC_7", "TOTAL_DISC", "TOTAL_PROMO", "NET", "FLAG_BONUS"];
    const baris = ["S-A", "C-A001", "C-A001", "TOKO A C-A001", "General Trade", "1671-SOP-260013022", "2026-10-05", "SHIPMENT", "BRG-A1",
        "BARANG A1 100ML", 36, 10000, 360000, 0, 0, 0, 0, 0, 399600, "N"];
    const sheet = XLSX.utils.aoa_to_sheet([["REPORT ORDER DETAIL"], ["Periode", ": 2026-10-05 s/d 2026-10-05"], ["Cabang", ": 1201671 - CABANG A"], head, baris]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Sheet1");
    const bytes = XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    return new File([bytes], "OrderDetail_CABANG-A_2026-10-05.xlsx");
}

const unggah = (replace: boolean) => {
    const form = new FormData();
    form.append("file", berkasOrderDetail());
    form.append("principal", PRINCIPAL);
    form.append("apply", "true");
    form.append("replace", String(replace));
    return new NextRequest("http://app.test/api/principal-order", { method: "POST", body: form });
};
const tabelUnggah = (antre: unknown[]) => new Map<Tabel, unknown[]>([
    [principalMapping, [{ source: "BRG-A1", unit: "PCS", pack: "36", kind: "item" }]],
    [principalOrderBatch, [BATCH_LAMA]],
    [principalOrderLine, BARIS_LAMA],
    [invoiceOutbox, antre],
]);

test("BL-21: Ganti batch lama (replace=true) butuh order.edit — order.create saja 403 sebelum apa pun dibaca/ditulis", async () => {
    const res = await denganDb(["order.view", "order.create"], tabelUnggah([]), async (catat) => {
        const r = await unggahBatch(unggah(true));
        assert.equal(catat.delete.length + catat.insert.length, 0, "tidak ada yang dihapus/ditulis");
        return r;
    });
    assert.equal(res.status, 403);
    assert.match(String((await res.json()).error), /ubah order/);
});

test("BL-21: Ganti batch lama DITOLAK 409 di dalam transaksi bila ada SO batch lama di Antrean Faktur; kontrol positif tanpa antrean", async () => {
    const tolak = await denganDb(["order.view", "order.create", "order.edit"], tabelUnggah(ANTRE), async (catat) => {
        const r = await unggahBatch(unggah(true));
        assert.deepEqual(catat.delete, [], "batch lama TIDAK dihapus");
        assert.deepEqual(catat.insert, [], "batch baru TIDAK ditulis");
        // Kunci antrean dibentuk dari SEMUA SO batch lama (bukan hanya kandidat).
        const kunci = catat.where.filter((w) => w.tabel === invoiceOutbox).flatMap((w) => w.params);
        assert.ok(kunci.includes("KINO-NON-FOOD:1671-SOP-260013022") && kunci.includes("KINO-NON-FOOD:1671-SOP-260013024"), `kunci: ${kunci}`);
        return r;
    });
    assert.equal(tolak.status, 409);
    assert.match(String((await tolak.json()).error), /1 SO batch lama sudah di Antrean Faktur/);

    const boleh = await denganDb(["order.view", "order.create", "order.edit"], tabelUnggah([]), async (catat) => {
        const r = await unggahBatch(unggah(true));
        assert.deepEqual(catat.delete, [principalOrderBatch], "batch lama dihapus");
        assert.ok(catat.insert.some((i) => i.tabel === principalOrderBatch), "batch baru ditulis");
        return r;
    });
    assert.equal(boleh.status, 200);
});

const hapus = () => new NextRequest("http://app.test/api/principal-order?id=lama", { method: "DELETE" });

test("BL-21: Hapus batch DITOLAK 409 bila ada SO-nya di Antrean Faktur; tanpa order.edit 403; kontrol positif menghapus", async () => {
    const tanpaIzin = await denganDb(["order.view", "order.create"], tabelUnggah([]), () => hapusBatch(hapus()));
    assert.equal(tanpaIzin.status, 403);

    const tolak = await denganDb(["order.view", "order.edit"], tabelUnggah(ANTRE), async (catat) => {
        const r = await hapusBatch(hapus());
        assert.deepEqual(catat.delete, [], "batch TIDAK dihapus");
        return r;
    });
    assert.equal(tolak.status, 409);
    assert.match(String((await tolak.json()).error), /1 SO batch ini sudah di Antrean Faktur.*1671-SOP-260013024/);

    const boleh = await denganDb(["order.view", "order.edit"], tabelUnggah([]), async (catat) => {
        const r = await hapusBatch(hapus());
        assert.deepEqual(catat.delete, [principalOrderBatch]);
        return r;
    });
    assert.equal(boleh.status, 200);
    assert.equal((await boleh.json()).removed, 1);
});

test("BL-21: status antrean batch dibaca dari SEMUA nomor SO batch, termasuk SO yang kini ditinjau (bukan kandidat)", async () => {
    const baris = [
        { batchId: "b1", rowNumber: 1, soNo: "1671-SOP-260013022", status: "ok", customerNo: "TKA01-KN", soDate: "2026-10-05" },
        // Sudah antre/terposting, lalu (Cabut / Segarkan harga / validasi ulang) kini ditinjau: TIDAK boleh hilang dari status antrean.
        { batchId: "b1", rowNumber: 2, soNo: "1671-SOP-260013024", status: "review", customerNo: "TKA01-KN", soDate: "2026-10-05" },
    ];
    const res = await denganDb(["order.view"], new Map<Tabel, unknown[]>([
        [principalOrderBatch, [{ id: "b1", principal: PRINCIPAL, period: "2026-10-05", fileName: "b1.xlsx" }]],
        [principalOrderLine, baris],
        [invoiceOutbox, [{ orderId: "KINO-NON-FOOD:1671-SOP-260013024", state: "posted", number: "INV/2610/KN01412", error: null }]],
    ]), async (catat) => {
        const r = await statusAntrean(new NextRequest("http://app.test/api/principal-order/queue?id=b1"));
        const kunci = catat.where.filter((w) => w.tabel === invoiceOutbox).flatMap((w) => w.params);
        assert.ok(kunci.includes("KINO-NON-FOOD:1671-SOP-260013024"), `SO ditinjau ikut dicari: ${kunci}`);
        assert.ok(kunci.includes("KINO-NON-FOOD:1671-SOP-260013022"));
        return r;
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).queue.length, 1);
});

// ── C7 Order Masuk: salesman di payload faktur yang DIBEKUKAN ke antrean ──────────────────────────────────

const ID_ORDER = "8f1c0000-aaaa-4bbb-8ccc-000000000001";
const ORDER = {
    id: ID_ORDER, customer_no: "C-A001-KN", outlet: "TOKO A", channel: "GT", order_date: "2026-10-06", status: "draft", note: "",
    lines: [{ code: "BRG-A1", unit: "KRT", quantity: "5", price: "456000" }, { code: "BRG-A2", unit: "LSN", quantity: "10", price: "120000" }],
    sources: [{ draft_id: "d1d1d1d1-0000", revision: 3 }], rules: [],
    result: {
        gross: "3480000.00", discount: "68400.00", net: "3411600.00",
        lines: [
            { code: "BRG-A1", unit: "KRT", quantity: "5", gross: "2280000.00", net: "2211600.00", percents: ["3"], cash: "0" },
            { code: "BRG-A2", unit: "LSN", quantity: "10", gross: "1200000.00", net: "1200000.00" },
        ],
        bonuses: [{ program_id: "P-A", code: "BRG-A1", unit: "KRT", quantity: "1" }],
    },
};
const tabelOrder = () => new Map<Tabel, unknown[]>([
    [accurateEmployee, [{ id: 4652, number: "M-SLA", name: "SALES A", salesman: true, suspended: false }]],
    [accurateUnit, [{ id: 100, name: "KRT" }, { id: 200, name: "LSN" }]],
    [customer, [{ branchId: 50, branchName: "CABANG A", autoNumberId: 7, autoNumberName: "SERI A" }]],
]);
const fastapiOrder = (url: string) => {
    assert.match(url, new RegExp(`/orders/${ID_ORDER}$`));
    return new Response(JSON.stringify({ ok: true, order: ORDER }), { status: 200, headers: { "content-type": "application/json" } });
};
const postInvoice = (body: unknown) => antreOrder(new NextRequest(`http://app.test/api/orders/${ID_ORDER}/invoice`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: ID_ORDER }) });
type PayloadFaktur = { masterSalesmanId?: number; detailItem: { itemNo: string; unitPrice: number; salesmanListNumber?: string[] }[] };

/** Salesman SATU per order: kepala `masterSalesmanId` + `salesmanListNumber` di SETIAP baris (2 barang + 1 bonus). */
function salesmanDiSetiapBaris(payload: PayloadFaktur) {
    assert.equal(payload.masterSalesmanId, 4652);
    assert.equal(payload.detailItem.length, 3, "2 barang + 1 bonus");
    assert.deepEqual(payload.detailItem.map((line) => line.salesmanListNumber), [["M-SLA"], ["M-SLA"], ["M-SLA"]]);
}

test("C7 route: pratinjau POST /api/orders/[id]/invoice dengan salesman → payload membawa salesman di kepala dan setiap baris", async () => {
    const res = await denganDb(["order.view", "order.edit"], tabelOrder(), async (catat) => {
        const r = await postInvoice({ queue: false, salesman: " m-sla " });
        assert.deepEqual(catat.insert, [], "pratinjau tidak menulis");
        return r;
    }, fastapiOrder);
    assert.equal(res.status, 200);
    const data = await res.json() as { payload: PayloadFaktur; salesman: { number: string; id: number; name: string } };
    salesmanDiSetiapBaris(data.payload);
    assert.deepEqual(data.salesman, { number: "M-SLA", id: 4652, name: "SALES A" });
});

test("C7 route: antre (queue:true) MEMBEKUKAN payload bersalesman ke invoice_outbox; tanpa salesman 400 sebelum order dibaca", async () => {
    const tanpa = await denganDb(["order.view", "order.edit"], tabelOrder(), async (catat) => {
        const r = await postInvoice({ queue: true });
        assert.deepEqual(catat.fetch, [], "order FastAPI tidak dibaca");
        assert.deepEqual(catat.insert, [], "tidak ada baris antrean");
        return r;
    }, fastapiOrder);
    assert.equal(tanpa.status, 400);
    assert.match(String((await tanpa.json()).error), /Pilih salesman/);

    const res = await denganDb(["order.view", "order.edit"], tabelOrder(), async (catat) => {
        const r = await postInvoice({ queue: true, salesman: "M-SLA" });
        const antre = catat.insert.find((i) => i.tabel === invoiceOutbox);
        assert.ok(antre, "baris invoice_outbox ditulis");
        const [baris] = antre.values as { orderId: string; state: string; payload: PayloadFaktur }[];
        assert.equal(baris.orderId, ID_ORDER);
        assert.equal(baris.state, "queued");
        salesmanDiSetiapBaris(baris.payload);
        return r;
    }, fastapiOrder);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).queued, true);
});
