/*
 * Tujuan: Memastikan tile Beranda menghitung dari respons endpoint dengan benar dan tidak tampil tanpa izin.
 * Caller: npm test (tsx --test lib/**\/*.test.ts).
 * Dependensi: node:test, lib/beranda.
 * Main Functions: uji pick per tile, nol = semua beres, tilesFor per profil/izin, cardFor, witaToday.
 * Side Effects: Tidak ada.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { TILES, cardFor, tilesFor, witaToday } from "./beranda";

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

test("tiles and cards never appear without the endpoint permission", () => {
    assert.deepEqual(tilesFor("fakturist", new Set(["order.view"])), ["antrean", "batchTinjau", "selisih"]);
    // Tile admin butuh izin sumber (users.manage) DAN halaman tujuan (/admin/users = users.view).
    assert.deepEqual(tilesFor("admin", new Set(["users.manage"])), []);
    assert.deepEqual(tilesFor("admin", new Set(["users.manage", "users.view"])), ["userTanpaGrup"]);
    assert.deepEqual(tilesFor("fakturist", new Set()), []);
    assert.deepEqual(tilesFor("gudang", new Set(["rekapan_nota.view"])), ["wave", "exception", "kanvas"]);
    // Tanpa profil: gabungan tugas dari izin, dibatasi 6.
    assert.deepEqual(tilesFor(undefined, new Set(["claim_workflow.view"])), ["outstanding", "siapTutup"]);
    assert.ok(tilesFor(undefined, new Set(["order.view", "rekapan_nota.view", "off_program_control.view", "claim_workflow.view"])).length <= 6);
    assert.equal(cardFor("sm", new Set()), undefined);
    assert.equal(cardFor("sm", new Set(["off_program_control.view"]))?.source, "opc");
});

test("today is computed in WITA, not UTC", () => {
    // 23.30 UTC tanggal 6 = 07.30 WITA tanggal 7.
    assert.equal(witaToday(new Date("2026-10-06T23:30:00Z")), "2026-10-07");
    assert.equal(witaToday(new Date("2026-10-07T15:59:00Z")), "2026-10-07");
    assert.equal(witaToday(new Date("2026-10-07T16:00:00Z")), "2026-10-08");
});
