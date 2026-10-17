/*
 * Tujuan: Memastikan tile Beranda menghitung dari respons endpoint dengan benar dan tidak tampil tanpa izin.
 * Caller: npm test (tsx --test lib/**\/*.test.ts).
 * Dependensi: node:test, lib/beranda.
 * Main Functions: uji pick per tile, nol = semua beres, tilesFor per profil/izin, cardFor, witaToday.
 * Side Effects: Tidak ada.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { TILES, cardFor, linksFor, sourceValid, tilesFor, witaToday } from "./beranda";

test("tiles count from real response shapes and treat zero as all clear", () => {
    const outbox = { escalateAfterMinutes: 120, summary: { queued: 7, unknown: 1, rejected: 2, posted: 30 }, overdueQueue: 3, pendingBatches: [{ reviewCount: 6 }, { reviewCount: 2 }] };
    // Belum terkirim = semua state selain posted (7 antre + 1 tidak pasti + 2 ditolak).
    assert.deepEqual(TILES.antrean.pick(outbox), { value: 10, unit: "faktur", tone: "warn", footer: "3 lewat 2 jam · 2 ditolak · 1 tidak pasti" });
    // Tidak ada yang antre tapi ada yang macet: bukan "semua beres".
    assert.equal(TILES.antrean.pick({ summary: { posted: 40, unknown: 2 } }).tone, "warn");
    assert.equal(TILES.antrean.pick({ summary: { posted: 40, unknown: 2 } }).value, 2);
    assert.deepEqual(TILES.batchTinjau.pick(outbox), { value: 2, unit: "batch", tone: "info", footer: "8 baris perlu tinjau" });
    assert.deepEqual(TILES.antrean.pick({ summary: { posted: 5 } }), { value: 0, unit: "faktur", tone: "pos", footer: "Tidak ada yang tertunda" });
    // Daftar OPC terpotong di 200: nol tidak boleh dibaca "semua beres".
    const capped = TILES.persetujuanOff.pick({ batches: Array.from({ length: 200 }, () => ({ status: "Draft" })) });
    assert.equal(capped.more, true);
    assert.notEqual(capped.tone, "pos");
    assert.equal(TILES.siapTutup.pick({ workflows: [{}], pagination: { hasMore: true } }).more, true);
    assert.equal(TILES.exception.pick({ wave: [{ exception_open: 2 }, { exception_open: 2 }] }).value, 4);
    const batches = { batches: [
        { status: "Submitted to SM", smStatus: "Waiting Review" },
        { status: "Returned by SM", smStatus: "Returned" },
        { status: "Approved by SM", smStatus: "Approved by SM", claimStatus: "Not Started" },
        { status: "Claim Approved", smStatus: "Approved by SM", claimStatus: "Approved", omStatus: "Approved", financeStatus: "Partial Paid" },
    ] };
    assert.equal(TILES.persetujuanOff.pick(batches).value, 1);
    assert.equal(TILES.dikembalikan.pick(batches).value, 1);
    assert.equal(TILES.reviewKlaim.pick(batches).value, 1);
    assert.equal(TILES.pembayaranOff.pick(batches).value, 1);
    // Respons rusak tidak melempar: dihitung nol, bukan angka palsu.
    assert.equal(TILES.persetujuanOff.pick({ batches: "x" }).value, 0);
    assert.equal(TILES.userTanpaGrup.pick({ users: [{ groupId: null }, { groupId: "g" }, { groupId: null, banned: true }] }).value, 1);
});

test("BL-41 Admin Incaso: tidak pasti + gagal dari ringkasan; jawaban tanpa angka = galat, bukan nol", () => {
    const summary = { ok: true, uncertain: { unknown: 2, sendingStale: 1, total: 3 }, retryable: 4, processingStale: 1, staleMinutes: 15,
        perDatabase: [{ databaseId: "77", label: "77", uncertain: { unknown: 2, sendingStale: 0, total: 2 }, retryable: 1, processingStale: 0 },
            { databaseId: null, label: "tidak tercatat", uncertain: { unknown: 0, sendingStale: 1, total: 1 }, retryable: 3, processingStale: 1 }],
        rows: [{ key: "PAY_A", status: "UNKNOWN", customerNo: "PELANGGAN-A", transDate: "09/10/2026", invoiceNo: "INV/A/001", amount: 120000, databaseId: "77", updatedAt: "2026-10-10T01:00:00.000Z", category: "uncertain" },
            { key: "PAY_B", status: "FAILED", customerNo: "PELANGGAN-B", transDate: "09/10/2026", invoiceNo: "INV/A/002", amount: 2500000, databaseId: null, updatedAt: null, category: "retryable" }],
        rowsTruncated: false };
    assert.deepEqual(TILES.pelunasanTidakPasti.pick(summary), { value: 4, unit: "baris", tone: "warn", footer: "2 tidak pasti · 1 mengirim macet · 1 kunci macet > 15 mnt (tak terkirim)" });
    assert.deepEqual(TILES.pelunasanGagal.pick(summary), { value: 4, unit: "baris", tone: "neg", footer: "Perbaiki lalu unggah ulang lewat wizard" });
    assert.equal(TILES.pelunasanTidakPasti.pick({ ok: true, uncertain: { total: 0 }, retryable: 0, processingStale: 0 }).tone, "pos");
    assert.equal(sourceValid("pelunasan", summary), true);
    assert.equal(sourceValid("pelunasan", { ok: false, error: "x" }), false);
    assert.equal(sourceValid("pelunasan", { ok: true }), false, "tanpa angka = galat");
    assert.equal(sourceValid("pelunasan", { ...summary, rows: undefined }), false, "?rows=1 tanpa daftar = galat");
    assert.equal(sourceValid("pelunasan", { ...summary, perDatabase: null }), false, "tanpa perDatabase = galat");
    assert.equal(sourceValid("outbox", {}), true, "sumber lama tidak berubah");
    assert.deepEqual(tilesFor("incaso", new Set(["pelunasan.kirim"])), ["pelunasanTidakPasti", "pelunasanGagal"]);
    assert.deepEqual(tilesFor("incaso", new Set()), []);
    assert.deepEqual(linksFor("incaso", new Set(["pelunasan.kirim"])).map((l) => l.title), ["Unggah pelunasan", "Cek incaso"]);
    assert.deepEqual(linksFor("incaso", new Set()).map((l) => l.title), ["Cek incaso"], "pintasan tanpa izin halaman tidak tampil");

    // Kartu Pantauan: database aktif dari sesi Accurate (alias), angka per database, lalu baris terbaru.
    const card = cardFor("incaso", new Set(["pelunasan.kirim"]));
    assert.equal(card?.source, "pelunasan");
    assert.equal(card?.extra, "sesiAccurate");
    const sesi = { status: "siap" as const, data: { ok: true, connected: true, databaseConnected: true, databaseId: "77", databaseAlias: "PT CONTOH" } };
    assert.deepEqual(card?.notes?.(summary, sesi), [
        "Database aktif Anda: PT CONTOH (id 77).", "PT CONTOH (aktif): 2 tidak pasti · 1 gagal", "tidak tercatat: 1 tidak pasti · 3 gagal · 1 kunci macet",
    ]);
    assert.match(card?.notes?.(summary, { status: "galat" })[0] ?? "", /tidak terbaca/, "sesi gagal ≠ belum membuka database");
    assert.match(card?.notes?.(summary, { status: "galat" })[1] ?? "", /^database id 77:/);
    const baris = card?.rows(summary, sesi) ?? [];
    assert.equal(baris.length, 2);
    assert.deepEqual(baris[0].badge, ["warn", "Tidak pasti"]);
    assert.match(baris[0].meta, /PT CONTOH \(aktif\)/);
    assert.match(baris[0].meta, /WITA$/);
    assert.deepEqual(baris[1].badge, ["neg", "Gagal · boleh diulang"]);
    assert.match(baris[1].meta, /tidak tercatat/);
    assert.equal(cardFor("incaso", new Set()), undefined);
});

test("tiles and cards never appear without the endpoint permission", () => {
    assert.deepEqual(tilesFor("fakturist", new Set(["order.view"])), ["antrean", "batchTinjau", "selisih"]);
    // Tile admin butuh izin sumber (users.manage) DAN halaman tujuan (/admin/users = users.view ATAU users.manage, S7a anyOf).
    assert.deepEqual(tilesFor("admin", new Set(["users.manage"])), ["userTanpaGrup"]);
    assert.deepEqual(tilesFor("admin", new Set(["users.manage", "users.view"])), ["userTanpaGrup"]);
    assert.deepEqual(tilesFor("admin", new Set(["users.view"])), [], "users.view saja: izin sumber (users.manage) tidak ada");
    assert.deepEqual(tilesFor("fakturist", new Set()), []);
    assert.deepEqual(tilesFor("gudang", new Set(["rekapan_nota.view"])), ["wave", "exception", "kanvas"]);
    // Tanpa profil: gabungan tugas dari izin, dibatasi 6.
    assert.deepEqual(tilesFor(undefined, new Set(["claim_workflow.view"])), ["outstanding", "siapTutup"]);
    assert.ok(tilesFor(undefined, new Set(["order.view", "rekapan_nota.view", "off_program_control.view", "claim_workflow.view"])).length <= 6);
    // S7-3: profil baru (grup utama) tidak jatuh ke gabungan tugas peran lain — OM pemegang OPC tidak melihat "Persetujuan OFF" milik SM.
    // Tile Kasir menyusul di K3.
    for (const id of ["spv", "om", "kasir"]) {
        assert.deepEqual(tilesFor(id, new Set(["off_program_control.view", "kasir.view", "claim_workflow.view", "order.view"])), [], id);
        assert.equal(cardFor(id, new Set(["off_program_control.view"])), undefined, id);
    }
    assert.equal(cardFor("sm", new Set()), undefined);
    assert.equal(cardFor("sm", new Set(["off_program_control.view"]))?.source, "opc");
});

test("today is computed in WITA, not UTC", () => {
    // 23.30 UTC tanggal 6 = 07.30 WITA tanggal 7.
    assert.equal(witaToday(new Date("2026-10-06T23:30:00Z")), "2026-10-07");
    assert.equal(witaToday(new Date("2026-10-07T15:59:00Z")), "2026-10-07");
    assert.equal(witaToday(new Date("2026-10-07T16:00:00Z")), "2026-10-08");
});
