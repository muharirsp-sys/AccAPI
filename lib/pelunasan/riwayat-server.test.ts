/* S6e-2 (owner #6): pemeriksaan riwayat sales-receipt di SERVER, fail-closed — logika pencocokan sama dengan pratinjau
 * (golden p01 tetap identik), tetapi jawaban tak terbaca/terpotong/terlambat = kunci GAGAL (ditahan), bukan lolos. Emulator
 * Accurate tiruan, tanpa jaringan. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buatEmulator } from "./uji/emulator-accurate.ts";
import { fixturePratinjau } from "./uji/fixture.ts";
import { periksaRiwayatAccurate, pratinjauRiwayatAccurate } from "./pratinjau-ganda.ts";
import type { AccurateFetch } from "./retur.ts";
import { buildSalesReceiptIdempotencyPayload } from "../sales-receipt-fingerprint.ts";

const target = (r: Record<string, unknown>) => buildSalesReceiptIdempotencyPayload(r);

test("server: cocok sama dengan pratinjau klien (fixture p01)", async () => {
    const p = fixturePratinjau();
    const klien = await pratinjauRiwayatAccurate(p.rows, buatEmulator(p.data).accurateFetch as AccurateFetch);
    const server = await periksaRiwayatAccurate(p.rows.map(target), buatEmulator(p.data).accurateFetch as AccurateFetch);
    assert.deepEqual([...server.cocok], [...klien]);
    assert.equal(server.cocok.size, 1, "satu baris identik dengan RCP/2610/0001");
    assert.equal(server.gagal.size, 0);
});

test("server: galat baca satu kelompok -> kunci kelompok itu GAGAL (ditahan), kelompok lain tetap dinilai", async () => {
    const p = fixturePratinjau();
    const emu = buatEmulator({ ...p.data, galat: ["PLG-A-002"] });
    const r = await periksaRiwayatAccurate(p.rows.map(target), emu.accurateFetch as AccurateFetch);
    assert.deepEqual([...r.gagal.keys()], [target(p.rows[2]).key]);
    assert.match(r.gagal.get(target(p.rows[2]).key)!, /galat buatan/);
    assert.equal(r.cocok.size, 1, "PLG-A-003 tetap cocok");
    // Pratinjau klien (fail-open lama) TIDAK berubah: galat menghentikan pencarian tanpa melempar.
    await pratinjauRiwayatAccurate(p.rows, emu.accurateFetch as AccurateFetch);
});

test("server: jawaban bukan s:true / detail kosong / daftar terpotong = GAGAL (bukan lolos)", async () => {
    const row = { customerNo: "C1", transDate: "01/10/2026", detailInvoice: [{ invoiceNo: "I1", paymentAmount: 1 }] };
    const coba = async (f: AccurateFetch) => (await periksaRiwayatAccurate([target(row)], f)).gagal.size;
    assert.equal(await coba(async () => ({ s: false, d: ["Sesi habis"] })), 1, "list.do s:false");
    assert.equal(await coba(async (path) => path.endsWith("list.do") ? { s: true, d: [{ id: 1 }], sp: { pageCount: 1 } } : { s: false, d: ["x"] }), 1, "detail s:false");
    assert.equal(await coba(async () => ({ s: true, d: [], sp: { pageCount: 6 } })), 1, "> 5 halaman");
    // Kontrol positif: daftar kosong yang terbaca = tidak mirip, tidak gagal.
    assert.equal(await coba(async () => ({ s: true, d: [], sp: { pageCount: 1 } })), 0);
});

test("server: melewati batas waktu -> kelompok yang belum selesai GAGAL; paling banyak 4 serentak", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ customerNo: `C${i}`, transDate: "01/10/2026", detailInvoice: [{ invoiceNo: `I${i}`, paymentAmount: 1 }] }));
    let kini = 0;
    let maks = 0;
    const lambat: AccurateFetch = async (_p, _m, q) => {
        kini++; maks = Math.max(maks, kini);
        try {
            if ((q as Record<string, unknown>)["filter.customerNo"] === "C7") await new Promise(() => {}); // tidak pernah menjawab
            await new Promise((r) => setTimeout(r, 2));
            return { s: true, d: [], sp: { pageCount: 1 } };
        } finally { kini--; }
    };
    const r = await periksaRiwayatAccurate(rows.map(target), lambat, { batasMs: 200 });
    assert.deepEqual([...r.gagal.keys()], [target(rows[7]).key]);
    assert.match(r.gagal.get(target(rows[7]).key)!, /batas waktu/);
    assert.ok(maks <= 4 && maks >= 2, `serentak ${maks}`);
});
