/* S6e-2 butir 7 (+ C11 butir 4): orkestrasi kirim Pelunasan sebagai fungsi murni — lock → paket 100 → laporan per baris →
 * complete. Server (lock/proxy/complete) TIRUAN di sini; riwayat Accurate = emulator lib/pelunasan/uji (tanpa jaringan). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GalatKirim, kirimPelunasan, type JawabanHttp } from "./kirim.ts";
import { buatEmulator } from "./uji/emulator-accurate.ts";
import { pratinjauRiwayatAccurate } from "./pratinjau-ganda.ts";
import type { AccurateFetch } from "./retur.ts";
import { buildSalesReceiptIdempotencyPayload } from "../sales-receipt-fingerprint.ts";

const baris = (i: number) => ({ customerNo: `C${i}`, transDate: "09/10/2026", detailInvoice: [{ invoiceNo: `INV-${i}`, paymentAmount: 1000 + i }] });
const banyak = (n: number) => Array.from({ length: n }, (_, i) => baris(i));
type Body = { payload: unknown[]; idempotencyLockId: string; expectedDatabaseId: string };

/** Server tiruan: `proxy(body, ke)` menjawab kiriman ke-`ke` (mulai 0). */
function server(proxy: (b: Body, ke: number) => JawabanHttp | Promise<JawabanHttp>, lock: JawabanHttp = { status: 200, data: { ok: true, lockId: "L1", blockedKeys: [] } }) {
    const log = { lock: [] as unknown[], proxy: [] as Body[], complete: [] as Array<{ keys: string[]; status: string; lockId: string }> };
    const postJson = async (url: string, body: unknown): Promise<JawabanHttp> => {
        if (url === "/api/idempotency/lock") { log.lock.push(body); return lock; }
        if (url === "/api/idempotency/complete") { log.complete.push(body as never); return { status: 200, data: { ok: true } }; }
        if (url === "/api/proxy") { log.proxy.push(body as Body); return proxy(body as Body, log.proxy.length - 1); }
        throw new Error(`url tak dikenal ${url}`);
    };
    return { postJson, log };
}
const sukses = (b: Body): JawabanHttp => ({ status: 200, data: { s: true, d: b.payload.map((_, k) => ({ s: true, r: { number: `PR-${k}` } })) } });
const hitung = (rows: { outcome: string }[]) => rows.reduce<Record<string, number>>((a, r) => ({ ...a, [r.outcome]: (a[r.outcome] ?? 0) + 1 }), {});
const statusComplete = (log: ReturnType<typeof server>["log"]) => log.complete.reduce<Record<string, number>>((a, c) => ({ ...a, [c.status]: (a[c.status] ?? 0) + c.keys.length }), {});

test("paket 100: 250 baris = 3 kiriman (100/100/50) membawa lockId + expectedDatabaseId; semua terposting", async () => {
    const s = server(sukses);
    const r = await kirimPelunasan(banyak(250), { postJson: s.postJson, expectedDatabaseId: "DB-1" });
    assert.equal(r.lockId, "L1");
    assert.equal((s.log.lock[0] as { expectedDatabaseId?: string }).expectedDatabaseId, "DB-1", "lock mencatat database tujuan");
    assert.deepEqual(s.log.proxy.map((b) => b.payload.length), [100, 100, 50]);
    assert.ok(s.log.proxy.every((b) => b.idempotencyLockId === "L1" && b.expectedDatabaseId === "DB-1"));
    assert.deepEqual(hitung(r.rows), { terposting: 250 });
    assert.deepEqual(statusComplete(s.log), { SUCCESS: 250 });
    assert.deepEqual(r.rows.map((x) => x.paket).filter((p, i, a) => a.indexOf(p) === i), [1, 2, 3]);
});

test("putus di tengah (paket 2 galat jaringan / 504) = TIDAK PASTI, paket lain tetap; tidak ada 'gagal'", async () => {
    for (const putus of [() => { throw new Error("Failed to fetch"); }, () => ({ status: 504, data: { error: "Accurate tidak merespons dalam 30 detik (timeout)" } })]) {
        const s = server((b, ke) => (ke === 1 ? putus() : sukses(b)));
        const r = await kirimPelunasan(banyak(250), { postJson: s.postJson, expectedDatabaseId: "DB-1" });
        assert.deepEqual(hitung(r.rows), { terposting: 150, tidak_pasti: 100 });
        assert.match(r.rows[150].message, /^Tanpa jawaban Accurate \((Failed to fetch|Accurate tidak merespons)/);
        assert.deepEqual(statusComplete(s.log), { SUCCESS: 150, UNKNOWN: 100 });
    }
});

test("sesi belum lengkap (400 sent:false) = GAGAL tidak terkirim, FAILED, kirim berhenti (paket sisa tidak dikirim)", async () => {
    const s = server(() => ({ status: 400, data: { error: "Sesi Accurate belum lengkap.", code: "ACCURATE_SESSION_INCOMPLETE", sent: false } }));
    const r = await kirimPelunasan(banyak(150), { postJson: s.postJson, expectedDatabaseId: "DB-1" });
    assert.equal(s.log.proxy.length, 1, "paket 2 tidak dikirim");
    assert.deepEqual(hitung(r.rows), { gagal: 150 });
    assert.ok(r.rows.every((x) => x.code === "ACCURATE_SESSION_INCOMPLETE"));
    assert.deepEqual(statusComplete(s.log), { FAILED: 150 });
});

test("database berubah di paket 2 -> paket 2 & 3 gagal (tidak dikirim), paket 1 tetap terposting", async () => {
    const s = server((b, ke) => (ke === 1 ? { status: 409, data: { error: "Database berubah", code: "database_changed", sent: false } } : sukses(b)));
    const r = await kirimPelunasan(banyak(250), { postJson: s.postJson, expectedDatabaseId: "DB-1" });
    assert.equal(s.log.proxy.length, 2);
    assert.deepEqual(hitung(r.rows), { terposting: 100, gagal: 150 });
    assert.equal(r.rows[249].code, "database_changed");
});

test("409 ACCURATE_HISTORY: baris itu DITAHAN (FAILED), sisa paket dikirim ulang SEKALI tanpa baris itu", async () => {
    const rows = banyak(3);
    const k1 = buildSalesReceiptIdempotencyPayload(rows[1]).key;
    const s = server((b, ke) => ke === 0
        ? { status: 409, data: { code: "ACCURATE_HISTORY", sent: false, error: "1 baris ditahan", rows: [{ index: 1, key: k1, reason: "ACCURATE_HISTORY", receiptNumbers: ["PR.9"] }] } }
        : sukses(b));
    const r = await kirimPelunasan(rows, { postJson: s.postJson, expectedDatabaseId: "DB-1" });
    assert.deepEqual(s.log.proxy.map((b) => b.payload.length), [3, 2]);
    assert.deepEqual(r.rows.map((x) => x.outcome), ["terposting", "ditahan", "terposting"]);
    assert.deepEqual(r.rows[1].receiptNumbers, ["PR.9"]);
    assert.deepEqual(s.log.complete.find((c) => c.status === "FAILED")?.keys, [k1]);
    // Ditahan lagi pada kiriman ulang -> tidak dikirim ketiga kalinya.
    const s2 = server(() => ({ status: 409, data: { code: "ACCURATE_HISTORY", sent: false, rows: [{ index: 0, key: "x", reason: "ACCURATE_HISTORY_UNREADABLE", detail: "timeout" }] } }));
    const r2 = await kirimPelunasan(rows, { postJson: s2.postJson, expectedDatabaseId: "DB-1" });
    assert.equal(s2.log.proxy.length, 2);
    assert.deepEqual(r2.rows.map((x) => x.outcome), ["ditahan", "ditahan", "gagal"]);
    assert.match(r2.rows[0].message, /riwayat Accurate gagal dibaca/);
});

test("C11: s:false per baris = TIDAK PASTI (tanpa 'menolak'); kemiripan riwayat hanya petunjuk, tidak menaikkan ke terposting", async () => {
    const rows = banyak(2);
    const s = server(() => ({ status: 200, data: [{ s: true, r: { number: "PR-0" } }, { s: false, d: ["Nilai pelunasan melebihi nilai piutang"] }] }));
    const emu = buatEmulator({ salesInvoice: [], salesReturn: [], salesReceipt: [
        { id: 1, number: "PR.LAMA", customer: { customerNo: "C1" }, transDate: "09/10/2026", detailInvoice: [{ invoice: { number: "INV-1" }, paymentAmount: 1001, detailDiscount: [] }] }] });
    const r = await kirimPelunasan(rows, { postJson: s.postJson, expectedDatabaseId: "DB-1",
        cariRiwayat: (x) => pratinjauRiwayatAccurate(x, emu.accurateFetch as AccurateFetch) });
    assert.deepEqual(r.rows.map((x) => x.outcome), ["terposting", "tidak_pasti"]);
    assert.doesNotMatch(r.rows[1].message, /menolak|ditolak/i);
    assert.deepEqual(r.rows[1].receiptNumbers, ["PR.LAMA"]);
    assert.match(r.rows[1].message, /Ditemukan mirip di riwayat Accurate: PR\.LAMA/);
    assert.deepEqual(statusComplete(s.log), { SUCCESS: 1, UNKNOWN: 1 });
});

test("409 LOCK_REQUIRED = gagal (tidak terkirim) hanya paket itu; placeholder akun = gagal tanpa lock; lock terblokir = melempar tanpa kirim", async () => {
    const s = server((b, ke) => (ke === 0 ? { status: 409, data: { error: "tidak terkunci", code: "SALES_RECEIPT_LOCK_REQUIRED", sent: false } } : sukses(b)));
    const r = await kirimPelunasan(banyak(150), { postJson: s.postJson, expectedDatabaseId: "DB-1" });
    assert.deepEqual(hitung(r.rows), { gagal: 100, terposting: 50 });

    const p = server(sukses);
    const rp = await kirimPelunasan([{ ...baris(1), detailInvoice: [{ invoiceNo: "I", paymentAmount: 1, detailDiscount: [{ amount: 1, accountNo: "ISI_KODE_AKUN_POT1_DI_UI" }] }] }],
        { postJson: p.postJson, expectedDatabaseId: "DB-1" });
    assert.equal(rp.rows[0].code, "PLACEHOLDER_AKUN");
    assert.equal(p.log.lock.length + p.log.proxy.length, 0);

    const b = server(sukses, { status: 200, data: { ok: true, lockId: null, blockedKeys: ["K"] } });
    await assert.rejects(kirimPelunasan(banyak(2), { postJson: b.postJson, expectedDatabaseId: "DB-1" }), /berubah status duplikat/);
    assert.equal(b.log.proxy.length, 0);
});

test("galat lock membawa code/status/sent:false (GalatKirim) — UI memetakan menurut kode, bukan teks; tanpa kiriman", async () => {
    const kasus: Array<[JawabanHttp | "putus", string, number]> = [
        [{ status: 403, data: { error: "butuh pelunasan.kirim", code: "PERMISSION_REQUIRED" } }, "PERMISSION_REQUIRED", 403],
        [{ status: 403, data: { error: "hanya Finance", code: "OVERRIDE_PERMISSION_REQUIRED" } }, "OVERRIDE_PERMISSION_REQUIRED", 403],
        [{ status: 409, data: { error: "database berubah", code: "database_changed" } }, "database_changed", 409],
        [{ status: 500, data: { error: "x" } }, "HTTP_500", 500],
        [{ status: 200, data: { ok: true, lockId: null, blockedKeys: ["K"] } }, "BLOCKED_KEYS", 200],
        [{ status: 200, data: { ok: true, lockId: null, blockedKeys: [] } }, "LOCK_NOT_ISSUED", 200],
        ["putus", "NETWORK", 0],
    ];
    for (const [jawab, code, status] of kasus) {
        const s = jawab === "putus"
            ? { postJson: async () => { throw new Error("Failed to fetch"); }, log: { proxy: [] as unknown[] } }
            : server(sukses, jawab);
        const e = await kirimPelunasan(banyak(2), { postJson: s.postJson, expectedDatabaseId: "DB-1" }).then(() => null, (x: unknown) => x);
        assert.ok(e instanceof GalatKirim, code);
        assert.deepEqual([e.code, e.status, e.sent], [code, status, false]);
        assert.equal(s.log.proxy.length, 0);
    }
});

test("A5 (tinjauan 11 Okt): sent:false hanya dipercaya untuk 4xx — 500/502 ber-sent:false = TIDAK PASTI (UNKNOWN), bukan gagal", async () => {
    for (const status of [500, 502, 200]) {
        const s = server(() => ({ status, data: { error: "galat", sent: false } }));
        const r = await kirimPelunasan(banyak(3), { postJson: s.postJson, expectedDatabaseId: "DB-1" });
        assert.deepEqual(hitung(r.rows), { tidak_pasti: 3 }, `HTTP ${status}`);
        assert.deepEqual(statusComplete(s.log), { UNKNOWN: 3 }, `HTTP ${status}`);
    }
    // Kontrol: 409 sent:false = gagal (pasti tidak terkirim).
    const s = server(() => ({ status: 409, data: { error: "x", code: "SALES_RECEIPT_LOCK_REQUIRED", sent: false } }));
    assert.deepEqual(hitung((await kirimPelunasan(banyak(2), { postJson: s.postJson, expectedDatabaseId: "DB-1" })).rows), { gagal: 2 });
});

test("UI S6e-2b: baris tidak_pasti membawa code server bila ada (409 database_changed tanpa sent:false, 500 ber-sent:false); klasifikasi tetap tidak pasti", async () => {
    for (const [status, code] of [[409, "database_changed"], [500, "X_GALAT"]] as const) {
        const s = server(() => ({ status, data: { error: "galat server", code, ...(status === 500 ? { sent: false } : {}) } }));
        const r = await kirimPelunasan(banyak(2), { postJson: s.postJson, expectedDatabaseId: "DB-1" });
        assert.deepEqual(r.rows.map((x) => [x.outcome, x.code]), [["tidak_pasti", code], ["tidak_pasti", code]], `HTTP ${status}`);
        assert.deepEqual(statusComplete(s.log), { UNKNOWN: 2 });
    }
    // Jawaban Accurate tanpa kode -> tanpa code.
    const s = server(() => ({ status: 200, data: { s: false, d: ["ditolak"] } }));
    assert.equal((await kirimPelunasan(banyak(1), { postJson: s.postJson, expectedDatabaseId: "DB-1" })).rows[0].code, undefined);
});
