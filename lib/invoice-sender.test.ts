/* Kunci: antrean beku dari sebelum perbaikan diskon (persen + rupiah satu baris, Accurate membuang
   rupiahnya — INV/2609/KN01376) tidak boleh terkirim, dan penolakan itu tidak boleh hilang di cron.
   Tanpa DB dan tanpa Accurate: `db` dan `fetch` diganti tiruan, request tulis dihitung. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { jawabanCron, sendQueuedInvoices } from "./invoice-sender.ts";
import type { InvoicePayload } from "./accurate-invoice-write.ts";

const SESI = { sessionHost: "https://contoh.invalid", sessionId: "sesi", accessToken: "token" };

const antre = (itemDiscPercent: string, itemCashDiscount: number) => ({
    orderId: "KINO:SO-A", state: "queued", attempts: 0, orderDate: "2026-09-30", createdAt: new Date(),
    payload: {
        customerNo: "C-001-KN", transDate: "30/09/2026", typeAutoNumber: 7, taxable: true, inclusiveTax: false,
        description: "", charField1: "KINO:SO-A", charField2: "",
        detailItem: [{ itemNo: "ITM-1", quantity: 24, unitPrice: 14414.4144, itemUnitId: 100,
            itemDiscPercent, itemCashDiscount, detailNotes: "order SO-A baris 1", charField1: "KINO:SO-A" }],
    } satisfies InvoicePayload,
});

/** DB tiruan: `select` mengembalikan baris antrean, `update` selalu berhasil mengklaim. */
function tiruan(t: TestContext, rows: ReturnType<typeof antre>[]) {
    const pilih = { from: () => pilih, where: () => pilih, orderBy: () => pilih, limit: async () => rows };
    const ubah = { set: () => ubah, where: () => ubah, returning: async () => rows.map((row) => ({ orderId: row.orderId })) };
    t.mock.method(db, "select", (() => pilih) as unknown as typeof db.select);
    const update = t.mock.method(db, "update", (() => ubah) as unknown as typeof db.update);
    // Accurate tiruan MENOLAK, supaya tidak ada pembaruan realisasi yang ikut berjalan.
    const kirim = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ s: false, d: ["ditolak tiruan"] })));
    return { update, kirim };
}

test("antrean lama persen + rupiah ditolak SEBELUM satu request pun ke Accurate", async (t) => {
    const { update, kirim } = tiruan(t, [antre("2+0+0+0+0", 4933.33)]);
    const hasil = await sendQueuedInvoices(SESI, { targetDb: "1", limit: 20 });
    assert.match(hasil.error ?? "", /KINO:SO-A \(1 baris persen \+ rupiah \(Accurate membuang rupiahnya\)/);
    assert.equal(kirim.mock.callCount(), 0);
    assert.equal(update.mock.callCount(), 0);
    assert.equal(hasil.sent + hasil.rejected + hasil.unknown, 0);
});

test("pembanding: rupiah murni (bentuk lama yang sah) tetap sampai ke Accurate", async (t) => {
    // Membuktikan tiruannya memang menjalankan jalur kirim — `callCount 0` di atas bukan kebetulan.
    const { kirim } = tiruan(t, [antre("", 18018.02)]);
    const hasil = await sendQueuedInvoices(SESI, { targetDb: "1", limit: 20 });
    assert.equal(hasil.error, undefined);
    assert.equal(kirim.mock.callCount(), 1);
    assert.equal(hasil.rejected, 1);
});

test("cron meneruskan penolakan sebelum kirim, bukan melapor ok dengan sent 0", () => {
    // Satu baris campuran lama yang paling tua menahan seluruh putaran; tanpa ini cron melapor
    // `{ok:true, sent:0}` tiap putaran dan antrean macet tanpa tanda.
    const tolak = jawabanCron({ results: [], sent: 0, unknown: 0, rejected: 0, error: "Tidak ada faktur dikirim: KINO:SO-A (1 baris persen + rupiah)" });
    assert.equal(tolak.status, 409);
    assert.equal(tolak.body.ok, false);
    assert.match(String(tolak.body.error), /Tidak ada faktur dikirim: KINO:SO-A/);

    const biasa = jawabanCron({ results: [{ orderId: "A", state: "posted" }, { orderId: "B", state: "unknown" }], sent: 1, unknown: 1, rejected: 0 });
    assert.equal(biasa.status, 200);
    assert.deepEqual(biasa.body, { ok: false, sent: 1, unknown: 1, results: [{ orderId: "A", state: "posted" }, { orderId: "B", state: "unknown" }] });
});
