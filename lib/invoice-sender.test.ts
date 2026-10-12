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
import { cekTanggalFaktur, jawabanCron, MAKS_PER_TEKAN, orderIdsDariQuery, pratinjauKirim, sendQueuedInvoices } from "./invoice-sender.ts";
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
    cekSesi: Jawab = { status: 200, body: JSON.stringify({ s: true, d: [] }) },
    // Klaim GAGAL (0 baris) + jawaban kueri diagnosis: null = barisnya sudah tidak ada.
    klaimGagal?: { state: string; sama: boolean } | null) {
    const pilih = { from: () => pilih, where: () => pilih, orderBy: () => pilih, limit: async () => rows };
    t.mock.method(db, "select", (() => pilih) as unknown as typeof db.select);
    const sqls: { sql: string; params: unknown[] }[] = [];
    t.mock.method(db, "execute", (async (query: SQL) => {
        const rendered = dialect.sqlToQuery(query);
        sqls.push(rendered);
        if (rendered.sql.includes("AS sama")) return { rows: klaimGagal ? [klaimGagal] : [] };
        const claim = rendered.sql.includes("'kirim'") && klaimGagal === undefined;
        const orderId = rendered.params.find((p) => rows.some((r) => r.orderId === p));
        // Payload dari KLAIM (RETURNING) — ditandai supaya uji bisa membedakannya dari payload rencana.
        const payload = { ...rows.find((r) => r.orderId === orderId)?.payload, description: `dari-klaim ${orderId}` };
        return { rows: claim ? [{ order_id: orderId, payload }] : [] };
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

test("A-RENDAH: yang dikirim = payload HASIL KLAIM (RETURNING), dan klaim mensyaratkan payload yang diperiksa", async (t) => {
    const { klaim, kirim } = tiruan(t, [antre("", 0)], { status: 200, body: JSON.stringify({ s: true, r: { id: 5, number: "INV/5" } }) });
    await sendQueuedInvoices(SESI, { targetDb: "1", limit: 20, actor: "p" }, { refresh: async () => undefined });
    const { sql: claimSql, params } = klaim()[0];
    assert.match(claimSql, /WHERE order_id = \$\d+ AND state = 'queued' AND payload = \$\d+::jsonb/);
    assert.match(claimSql, /SELECT order_id, payload FROM c/);
    assert.ok(params.includes(JSON.stringify(antre("", 0).payload)), "klaim harus mencocokkan payload yang diperiksa rencanaKirim");
    const save = kirim.mock.calls.find((c) => String(c.arguments[0]).includes("/save.do"));
    const body = JSON.parse(String((save?.arguments[1] as RequestInit).body));
    assert.equal(body.description, "dari-klaim KINO:SO-A");
});

test("putaran 3: klaim yang dilewati TIDAK senyap — results menyebut sebabnya, tanpa save.do", async (t) => {
    for (const [diag, pola] of [
        [{ state: "queued", sama: false }, /payload berubah sejak diperiksa — muat ulang/],
        [{ state: "sending", sama: true }, /sudah diambil proses lain \(status sending\)/],
        [null, /dibuang dari antrean sejak diperiksa/],
    ] as const) {
        await t.test(String(diag?.state ?? "hilang"), async (st) => {
            const { saveCalls } = tiruan(st, [antre("", 0)], undefined, undefined, diag);
            const hasil = await sendQueuedInvoices(SESI, { targetDb: "1", limit: 20, actor: "p" });
            assert.equal(saveCalls(), 0);
            assert.equal(hasil.results.length, 1);
            assert.equal(hasil.results[0].state, "dilewati");
            assert.match(hasil.results[0].error ?? "", pola);
            assert.equal(hasil.sent + hasil.unknown + hasil.rejected, 0);
        });
    }
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

// ---------------------------------------------------------------- BL-39 pratinjau Kirim
const baris = (orderId: string, detailItem: InvoicePayload["detailItem"]) => {
    const a = antre("", 0, orderId);
    return { ...a, payload: { ...a.payload, detailItem } };
};
const BARIS_TERLIPAT = [
    // Bentuk #114: rupiah baris campuran SUDAH dilipat jadi persen di ujung rantai (posisi 5).
    { itemNo: "ITM-1", quantity: 24, unitPrice: 14414.4144, itemUnitId: 100, itemDiscPercent: "2+0+0+0+1.5", itemCashDiscount: 0, detailNotes: "b1", charField1: "" },
    // Rupiah murni (bentuk lama yang sah).
    { itemNo: "ITM-2", quantity: 10, unitPrice: 5000, itemUnitId: 100, itemDiscPercent: "", itemCashDiscount: 2500, detailNotes: "b2", charField1: "" },
];

test("BL-39: pratinjau = daftar yang AKAN dikirim — fungsi kueri & urutan yang sama dengan Kirim", async (t) => {
    const rows = [antre("", 0, "KINO:SO-1"), antre("", 0, "HEINZ:SO-2"), antre("", 0, "11111111-2222-3333-4444-555555555555")];
    const { klaim } = tiruan(t, rows);
    const lihat = await pratinjauKirim(db, { limit: MAKS_PER_TEKAN });
    assert.equal(lihat.error, undefined);
    const kirim = await sendQueuedInvoices(SESI, { targetDb: "1", limit: MAKS_PER_TEKAN, actor: "p" });
    assert.deepEqual(lihat.orders.map((o) => o.orderId), kirim.results.map((r) => r.orderId));
    assert.deepEqual(lihat.orders.map((o) => o.orderId), klaim().map((q) => q.params.find((v) => rows.some((r) => r.orderId === v))));
    assert.deepEqual(lihat.perPrincipal.map((p) => [p.principal, p.jumlah]), [["HEINZ", 1], ["KINO", 1], ["ORDER INTERNAL", 1]]);
});

test("BL-39: DPP + PPN dihitung dari payload TERLIPAT (#114), sama dengan rumus verifikasi balik", async (t) => {
    tiruan(t, [baris("KINO:SO-1", BARIS_TERLIPAT)]);
    const lihat = await pratinjauKirim(db, { limit: MAKS_PER_TEKAN, invoiceDate: "2026-10-01" });
    // 24 × 14.414,4144 = 345.945,95 −2% −1,5% = 333.941,62; 10 × 5.000 − 2.500 = 47.500.
    assert.deepEqual(lihat.total, { dpp: 381441.62, ppn: 41958.58, total: 423400.2 });
    assert.equal(lihat.orders[0].transDate, "01/10/2026", "tanggal faktur pilihan ikut, seperti di Kirim");
    assert.equal(lihat.orders[0].dpp, 381441.62);
});

test("BL-39: baris campuran persen + rupiah -> pratinjau menolak dengan pesan yang SAMA dengan Kirim", async (t) => {
    tiruan(t, [antre("2+0+0+0+0", 4933.33)]);
    const lihat = await pratinjauKirim(db, { limit: MAKS_PER_TEKAN });
    const kirim = await sendQueuedInvoices(SESI, { targetDb: "1", limit: MAKS_PER_TEKAN, actor: "p" });
    assert.ok(lihat.error);
    assert.equal(lihat.error, kirim.error);
});

test("pratinjau: kunci SO berkoma tidak terpecah — parameter berulang `orderId` atau JSON `orderIds`; daftar berkoma ditolak", () => {
    const berkoma = "KINO:1671-SOP-260014013,A";
    const q1 = new URLSearchParams();
    q1.append("orderId", berkoma);
    q1.append("orderId", " HEINZ:SO-2 ");
    assert.deepEqual(orderIdsDariQuery(q1), { ids: [berkoma, "HEINZ:SO-2"] });
    assert.deepEqual(orderIdsDariQuery(new URLSearchParams({ orderIds: JSON.stringify([berkoma, "HEINZ:SO-2"]) })), { ids: [berkoma, "HEINZ:SO-2"] });
    assert.deepEqual(orderIdsDariQuery(new URLSearchParams()), { ids: [] });
    // Bentuk lama "a,b" tidak lagi ditebak: kunci berkoma akan salah terbaca.
    assert.ok("error" in orderIdsDariQuery(new URLSearchParams({ orderIds: "KINO:SO-1,HEINZ:SO-2" })));
    assert.ok("error" in orderIdsDariQuery(new URLSearchParams({ orderIds: JSON.stringify([1, 2]) })));
});

test("tanggal faktur pilihan: format & batas hari ini (WITA) dicek satu fungsi untuk Kirim dan pratinjau", () => {
    assert.equal(cekTanggalFaktur(undefined, "2026-10-09"), null);
    assert.equal(cekTanggalFaktur("2026-10-09", "2026-10-09"), null);
    assert.match(cekTanggalFaktur("2026-10-10", "2026-10-09") ?? "", /paling lambat hari ini 2026-10-09/);
    assert.match(cekTanggalFaktur("2026-02-30", "2026-10-09") ?? "", /tidak sah/);
    assert.match(cekTanggalFaktur("09/10/2026", "2026-10-09") ?? "", /tidak sah/);
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
