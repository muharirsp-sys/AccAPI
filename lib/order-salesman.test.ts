/* C7 (owner 8 Okt 2026): faktur dari Order Masuk membawa SATU salesman per order, disalin ke tiap baris — bentuk yang sama
   dengan jalur Order Principal (`masterSalesmanId` di kepala + `salesmanListNumber` di SETIAP baris, termasuk bonus).
   Salesman wajib dipilih saat antre; yang tidak sah DITOLAK, bukan diam-diam terbit tanpa sales. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInvoicePayload, type InvoiceOrder } from "./accurate-invoice-write.ts";
import { salesmanDariPayload, salesmanOrder, type PegawaiAccurate } from "./order-salesman.ts";

const UNITS = new Map([["KRT", 100], ["LSN", 200]]);
const OPSI = { unitIds: UNITS, branchId: 50, typeAutoNumber: 7 };
const ORDER: InvoiceOrder = {
    id: "8f1c0000-aaaa-bbbb-cccc-000000000001",
    customer_no: "C-A001-KN", outlet: "TOKO A", channel: "GT", order_date: "2026-10-06", status: "draft",
    lines: [
        { code: "BRG-A1", unit: "KRT", quantity: "5", price: "456000" },
        { code: "BRG-A2", unit: "LSN", quantity: "10", price: "120000" },
    ],
    sources: [{ draft_id: "d1d1d1d1-0000", revision: 3 }],
    result: {
        gross: "3480000.00", discount: "68400.00", net: "3411600.00",
        lines: [
            { code: "BRG-A1", unit: "KRT", quantity: "5", gross: "2280000.00", net: "2211600.00", percents: ["3"], cash: "0" },
            { code: "BRG-A2", unit: "LSN", quantity: "10", gross: "1200000.00", net: "1200000.00" },
        ],
        bonuses: [{ program_id: "P-A", code: "BRG-A1", unit: "KRT", quantity: "1" }],
    },
};
const SALES_A: PegawaiAccurate = { id: 4652, number: "M-SLA", name: "SALES A", salesman: true, suspended: false };

test("C7: salesman order internal satu per order, disalin ke SETIAP baris (bentuk jalur principal)", () => {
    const pilih = salesmanOrder({ queue: true, kode: " m-sla ", pegawai: [SALES_A] });
    assert.equal(pilih.ok, true);
    assert.ok(pilih.ok && pilih.opsi, "antre dengan salesman sah menghasilkan opsi payload");
    const internal = buildInvoicePayload(ORDER, { ...OPSI, ...pilih.opsi });
    assert.equal(internal.masterSalesmanId, 4652);
    // 2 baris barang + 1 baris bonus: semuanya membawa salesman yang sama (Accurate menyimpan sales per baris).
    assert.deepEqual(internal.detailItem.map((line) => line.salesmanListNumber), [["M-SLA"], ["M-SLA"], ["M-SLA"]]);
    // Bentuknya PERSIS jalur Order Principal (app/api/principal-order/queue): opsi yang sama, payload yang sama.
    const principal = buildInvoicePayload(ORDER, { ...OPSI, masterSalesmanId: 4652, salesmanNumber: "M-SLA" });
    assert.deepEqual(internal, principal);
    // Pelipatan diskon (#114) tidak tersentuh: rantai persen baris 1 tetap "3", rupiah 0.
    assert.equal(internal.detailItem[0].itemDiscPercent, "3");
    assert.equal(internal.detailItem[0].itemCashDiscount, 0);
});

test("C7: antre TANPA salesman ditolak; pratinjau tanpa salesman boleh (payload tanpa sales)", () => {
    const antre = salesmanOrder({ queue: true, kode: "  ", pegawai: [] });
    assert.equal(antre.ok, false);
    assert.ok(!antre.ok && antre.status === 400 && /Pilih salesman/.test(antre.error));
    const pratinjau = salesmanOrder({ queue: false, kode: "", pegawai: [] });
    assert.deepEqual(pratinjau, { ok: true });
    const tanpa = buildInvoicePayload(ORDER, { ...OPSI, ...(pratinjau.ok ? pratinjau.opsi : {}) });
    assert.ok(!("masterSalesmanId" in tanpa));
    assert.ok(tanpa.detailItem.every((line) => !("salesmanListNumber" in line)));
});

test("C7: salesman tak dikenal, bukan sales, nonaktif, atau ganda DITOLAK (409), juga saat pratinjau", () => {
    for (const [pegawai, pola] of [
        [[], /tidak ditemukan/],
        [[{ ...SALES_A, salesman: false }], /bukan salesman/],
        [[{ ...SALES_A, suspended: true }], /nonaktif/],
        [[SALES_A, { ...SALES_A, id: 4653 }], /lebih dari satu/],
    ] as const) {
        for (const queue of [true, false]) {
            const hasil = salesmanOrder({ queue, kode: "M-SLA", pegawai: [...pegawai] });
            assert.equal(hasil.ok, false, `${pola} (queue=${queue}) harus ditolak`);
            assert.ok(!hasil.ok && hasil.status === 409 && pola.test(hasil.error), `${pola}: ${!hasil.ok ? hasil.error : ""}`);
        }
    }
    // Pegawai yang nomornya lain tidak pernah dipakai, walau satu-satunya baris.
    const lain = salesmanOrder({ queue: true, kode: "M-SLA", pegawai: [{ ...SALES_A, number: "M-SLB" }] });
    assert.equal(lain.ok, false);
});

// Daftar Antrean Faktur menyebut sales order INTERNAL dari payload beku (tinjauan S6d A): baris pertama `salesmanListNumber[0]`.
const PG_URL = process.env.AM040_DATABASE_URL ?? "";
test("C7: sales order internal di daftar Antrean Faktur dibaca dari payload beku (PG)", { skip: PG_URL ? false : "AM040_DATABASE_URL tidak di-set" }, async () => {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { sql } = await import("drizzle-orm");
    const pool = new Pool({ connectionString: PG_URL });
    try {
        const pg = drizzle(pool);
        const baca = async (payload: unknown) => (await pg.execute(sql`select ${salesmanDariPayload(sql`${JSON.stringify(payload)}::jsonb`)} as s`)).rows[0]?.s ?? null;
        const dengan = buildInvoicePayload(ORDER, { ...OPSI, masterSalesmanId: 4652, salesmanNumber: "M-SLA" });
        assert.equal(await baca(dengan), "M-SLA");
        assert.equal(await baca(buildInvoicePayload(ORDER, OPSI)), null, "payload lama tanpa sales = kosong, bukan galat");
        assert.equal(await baca({ detailItem: [] }), null);
    } finally {
        await pool.end();
    }
});
