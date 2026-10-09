/* Kunci: antrean beku dari sebelum perbaikan diskon (persen + rupiah satu baris, Accurate membuang
   rupiahnya — INV/2609/KN01376) tidak boleh terkirim, dan penolakan itu tidak boleh hilang di cron.
   S6-0d: tiap klaim dan tiap hasil kirim tercatat di riwayat (status HTTP + potongan jawaban +
   pengirim) dalam pernyataan yang sama dengan perubahan statusnya.
   Tanpa DB dan tanpa Accurate: `db` dan `fetch` diganti tiruan, request tulis dihitung. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { db } from "./db.ts";
import { jawabanCron, sendQueuedInvoices } from "./invoice-sender.ts";
import type { InvoicePayload } from "./accurate-invoice-write.ts";

const SESI = { sessionHost: "https://contoh.invalid", sessionId: "sesi", accessToken: "token" };
const dialect = new PgDialect();

const antre = (itemDiscPercent: string, itemCashDiscount: number, orderId = "KINO:SO-A") => ({
    orderId, state: "queued", attempts: 0, orderDate: "2026-09-30", createdAt: new Date(),
    payload: {
        customerNo: "C-001-KN", transDate: "30/09/2026", typeAutoNumber: 7, taxable: true, inclusiveTax: false,
        description: "", charField1: orderId, charField2: "",
        detailItem: [{ itemNo: "ITM-1", quantity: 24, unitPrice: 14414.4144, itemUnitId: 100,
            itemDiscPercent, itemCashDiscount, detailNotes: "order SO-A baris 1", charField1: orderId }],
    } satisfies InvoicePayload,
});

type Jawab = { status: number; body: string } | Error;

/**
 * DB tiruan: `select` mengembalikan baris antrean; `execute` (klaim / hasil / penyapu) dicatat
 * sebagai SQL ter-render — klaim berhasil untuk setiap baris. `fetch` menjawab per URL:
 * pemeriksaan sesi baca-saja selalu sah, save.do menjawab `simpan`.
 */
function tiruan(t: TestContext, rows: ReturnType<typeof antre>[], simpan: Jawab = { status: 200, body: JSON.stringify({ s: false, d: ["ditolak tiruan"] }) },
    cekSesi: Jawab = { status: 200, body: JSON.stringify({ s: true, d: [] }) }) {
    const pilih = { from: () => pilih, where: () => pilih, orderBy: () => pilih, limit: async () => rows };
    t.mock.method(db, "select", (() => pilih) as unknown as typeof db.select);
    const sqls: { sql: string; params: unknown[] }[] = [];
    t.mock.method(db, "execute", (async (query: SQL) => {
        const rendered = dialect.sqlToQuery(query);
        sqls.push(rendered);
        const claim = rendered.sql.includes("'kirim'");
        return { rows: claim ? [{ order_id: rendered.params.find((p) => rows.some((r) => r.orderId === p)) }] : [] };
    }) as unknown as typeof db.execute);
    const kirim = t.mock.method(globalThis, "fetch", async (url: string | URL) => {
        if (!String(url).includes("/sales-invoice/save.do")) {
            if (cekSesi instanceof Error) throw cekSesi;
            return new Response(cekSesi.body, { status: cekSesi.status });
        }
        if (simpan instanceof Error) throw simpan;
        return new Response(simpan.body, { status: simpan.status });
    });
    const saveCalls = () => kirim.mock.calls.filter((call) => String(call.arguments[0]).includes("/save.do")).length;
    const klaim = () => sqls.filter((q) => q.sql.includes("'kirim'"));
    const hasil = () => sqls.filter((q) => q.sql.includes("http_status"));
    return { kirim, saveCalls, klaim, hasil, sqls };
}

test("antrean lama persen + rupiah ditolak SEBELUM satu request pun ke Accurate", async (t) => {
    const { kirim, klaim } = tiruan(t, [antre("2+0+0+0+0", 4933.33)]);
    const hasil = await sendQueuedInvoices(SESI, { targetDb: "1", limit: 20, actor: "petugas@contoh" });
    assert.match(hasil.error ?? "", /KINO:SO-A \(1 baris persen \+ rupiah \(Accurate membuang rupiahnya\)/);
    assert.equal(kirim.mock.callCount(), 0);
    assert.equal(klaim().length, 0);
    assert.equal(hasil.sent + hasil.rejected + hasil.unknown, 0);
});

test("pembanding: rupiah murni (bentuk lama yang sah) tetap sampai ke Accurate", async (t) => {
    // Membuktikan tiruannya memang menjalankan jalur kirim — `callCount 0` di atas bukan kebetulan.
    const { saveCalls } = tiruan(t, [antre("", 18018.02)]);
    const hasil = await sendQueuedInvoices(SESI, { targetDb: "1", limit: 20, actor: "petugas@contoh" });
    assert.equal(hasil.error, undefined);
    assert.equal(saveCalls(), 1);
    assert.equal(hasil.rejected, 1);
});

test("S6-0d BL-17/R6: klaim mencatat pengirim, hasil mencatat status HTTP + potongan jawaban (tidak ditimpa)", async (t) => {
    const gateway = `{"message":"Bad Gateway"}${"x".repeat(700)}`;
    const { klaim, hasil: catatHasil } = tiruan(t, [antre("", 0)], { status: 502, body: gateway });
    const hasil = await sendQueuedInvoices(SESI, { targetDb: "DB-9", limit: 20, actor: "petugas@contoh" });
    assert.equal(hasil.unknown, 1);
    // Klaim queued -> sending dan event `kirim` dalam SATU pernyataan, dengan pengirimnya.
    assert.equal(klaim().length, 1);
    assert.match(klaim()[0].sql, /WITH c AS \(\s*UPDATE invoice_outbox SET state = 'sending'/);
    assert.match(klaim()[0].sql, /WHERE order_id = \$\d+ AND state = 'queued'/);
    assert.ok(klaim()[0].params.includes("petugas@contoh"));
    // Hasil + event dalam SATU pernyataan: status HTTP, potongan ≤ 500, pengirim, status baru.
    assert.equal(catatHasil().length, 1);
    const { sql, params } = catatHasil()[0];
    assert.match(sql, /WITH u AS \(\s*UPDATE invoice_outbox SET state = \$\d+/);
    assert.match(sql, /WHERE order_id = \$\d+ AND state = 'sending'/);
    assert.match(sql, /INSERT INTO invoice_outbox_event/);
    assert.ok(params.includes(502), "status HTTP tidak tercatat");
    assert.ok(params.includes(gateway.slice(0, 500)), "potongan jawaban ≤ 500 tidak tercatat");
    assert.ok(!params.includes(gateway), "jawaban penuh > 500 tidak boleh disimpan");
    assert.ok(params.includes("unknown") && params.includes("petugas@contoh"));
});

test("S6-0d: koneksi putus tercatat dengan kode galatnya, status tidak pasti", async (t) => {
    const putus = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    const { hasil: catatHasil } = tiruan(t, [antre("", 0)], putus);
    const hasil = await sendQueuedInvoices(SESI, { targetDb: "1", limit: 20, actor: "cron:officer-1" });
    assert.equal(hasil.unknown, 1);
    const { params } = catatHasil()[0];
    assert.ok(params.includes("TypeError:ECONNRESET"), `kode galat: ${JSON.stringify(params)}`);
    assert.ok(params.includes("cron:officer-1"));
});

test("S6-0d BL-16: penyapu `sending` > 15 menit jalan PERTAMA, menjadikan unknown + event `sapu`", async (t) => {
    const { sqls } = tiruan(t, [antre("", 0)]);
    await sendQueuedInvoices(SESI, { targetDb: "1", limit: 20, actor: "petugas@contoh" });
    const [pertama] = sqls;
    assert.match(pertama.sql, /UPDATE invoice_outbox SET state = 'unknown'/);
    assert.match(pertama.sql, /WHERE state = 'sending' AND updated_at < now\(\) - make_interval\(mins => \$\d+\)/);
    assert.match(pertama.sql, /'sapu', 'sending', 'unknown'/);
    assert.ok(pertama.params.includes(15), "ambang penyapu harus 15 menit");
    assert.ok(sqls.findIndex((q) => q.sql.includes("'kirim'")) > 0, "klaim terjadi SESUDAH penyapu");
});

test("S6-0d E7: sesi mati (401 / s:false / jaringan) -> batal TANPA klaim, pesan login ulang", async (t) => {
    for (const cekSesi of [
        { status: 401, body: '{"error":"invalid_token"}' },
        { status: 200, body: JSON.stringify({ s: false, d: ["Sesi sudah berakhir"] }) },
        { status: 302, body: "" },
        Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }),
    ]) {
        await t.test(cekSesi instanceof Error ? "jaringan" : `HTTP ${cekSesi.status}`, async (st) => {
            const { saveCalls, klaim, kirim } = tiruan(st, [antre("", 0)], undefined, cekSesi);
            const hasil = await sendQueuedInvoices(SESI, { targetDb: "1", limit: 20, actor: "petugas@contoh" });
            assert.match(hasil.error ?? "", /Sesi Accurate perlu login ulang/);
            assert.equal(klaim().length, 0, "tidak boleh ada klaim");
            assert.equal(saveCalls(), 0, "tidak boleh ada save.do");
            // Pemeriksaannya BACA-SAJA: GET branch/list.do, satu kali.
            assert.equal(kirim.mock.callCount(), 1);
            const [url, init] = kirim.mock.calls[0].arguments as [string, RequestInit];
            assert.match(String(url), /\/accurate\/api\/branch\/list\.do\?/);
            assert.equal(init.method, "GET");
        });
    }
});

test("S6-0d E7: antrean kosong tidak memanggil Accurate sama sekali", async (t) => {
    const { kirim } = tiruan(t, []);
    const hasil = await sendQueuedInvoices(SESI, { targetDb: "1", limit: 20, actor: "petugas@contoh" });
    assert.equal(hasil.error, undefined);
    assert.equal(kirim.mock.callCount(), 0);
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
