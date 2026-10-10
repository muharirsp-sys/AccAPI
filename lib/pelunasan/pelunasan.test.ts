/* S6e-1 uji karakterisasi Pelunasan: keluaran (payload sales-receipt, baris manual, toast, multiset panggilan Accurate)
 * atas fixture generik HARUS identik dengan golden yang direkam dari kode LAMA W (app/(dashboard)/api-wrapper/page.tsx). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buatEmulator } from "./uji/emulator-accurate.ts";
import { FIXTURES, fixturePratinjau } from "./uji/fixture.ts";
import { jalankanPelunasanLama, jalankanPratinjauLama } from "./uji/lama.ts";

type Golden = Record<string, { payload?: unknown; manualRows?: unknown; toasts?: unknown; panggilan: string[]; hasil?: unknown }>;
const golden = JSON.parse(readFileSync("lib/pelunasan/uji/golden.json", "utf8")) as Golden;
const json = (v: unknown) => JSON.stringify(v, null, 2);

for (const buat of FIXTURES) {
    const fx = buat();
    test(`golden kode lama: ${fx.nama}`, async () => {
        const g = golden[fx.nama];
        assert.ok(g, `golden ${fx.nama} belum direkam`);
        const emu = buatEmulator(fx.data);
        const k = await jalankanPelunasanLama(fx.rows, { ...fx.opsi, accurateFetch: emu.accurateFetch });
        assert.equal(k.payloadStr === null ? "null" : json(JSON.parse(k.payloadStr)), json(g.payload ?? null), "payload");
        assert.equal(json(k.manualRows), json(g.manualRows), "baris manual");
        assert.equal(json(k.toasts), json(g.toasts), "toast");
        assert.deepEqual(emu.panggilanKanonik(), g.panggilan, "panggilan Accurate");
    });
}

test("golden kode lama: p01-pratinjau-duplikat", async () => {
    const p = fixturePratinjau();
    const emu = buatEmulator(p.data);
    const hasil = await jalankanPratinjauLama(p.rows, p.routeKey, { blockedEntries: p.blockedEntries, accurateFetch: emu.accurateFetch });
    assert.equal(json(hasil), json(golden["p01-pratinjau-duplikat"].hasil));
    assert.deepEqual(emu.panggilanKanonik(), golden["p01-pratinjau-duplikat"].panggilan);
});

// ---- lib/pelunasan (S6e-1 tahap 2): HARUS identik dengan golden yang sama.
import { deteksiFormatPelunasan, parsePelunasan, type JenisLapor } from "./parser.ts";
import { pratinjauDuplikat } from "./pratinjau-ganda.ts";
import type { AccurateFetch } from "./retur.ts";

/** Jalankan lib persis seperti halaman: deteksi dulu; toast direkam dalam bentuk panggilan `toast[jenis](pesan, opsi?)`. */
export async function jalankanLib(fx: ReturnType<(typeof FIXTURES)[number]>, emu: ReturnType<typeof buatEmulator>) {
    const toasts: unknown[][] = [];
    if (!deteksiFormatPelunasan(fx.rows)) return { payload: null, manualRows: null, toasts };
    const { trxDate, isKeySaved, ...peta } = fx.opsi;
    const hasil = await parsePelunasan(fx.rows, {
        trxDate, isKeySaved, peta, accurateFetch: emu.accurateFetch as AccurateFetch,
        lapor: (jenis: JenisLapor, pesan: string, opsi?: { id: string }) => { toasts.push(opsi ? [jenis, pesan, opsi] : [jenis, pesan]); },
    });
    return { payload: hasil.payload, manualRows: hasil.manualRows, toasts };
}

for (const buat of FIXTURES) {
    const fx = buat();
    test(`golden lib/pelunasan: ${fx.nama}`, async () => {
        const g = golden[fx.nama];
        const emu = buatEmulator(fx.data);
        const k = await jalankanLib(fx, emu);
        assert.equal(json(k.payload), json(g.payload ?? null), "payload");
        assert.equal(json(k.manualRows), json(g.manualRows), "baris manual");
        assert.equal(json(k.toasts), json(g.toasts), "toast");
        assert.deepEqual(emu.panggilanKanonik(), g.panggilan, "panggilan Accurate");
    });
}

test("golden lib/pelunasan: p01-pratinjau-duplikat", async () => {
    const p = fixturePratinjau();
    const emu = buatEmulator(p.data);
    const hasil = await pratinjauDuplikat(p.rows, p.routeKey, {
        accurateFetch: emu.accurateFetch as AccurateFetch,
        pratinjauKunci: async () => ({ blockedEntries: p.blockedEntries }),
    });
    assert.equal(json(hasil), json(golden["p01-pratinjau-duplikat"].hasil));
    assert.deepEqual(emu.panggilanKanonik(), golden["p01-pratinjau-duplikat"].panggilan);
});

test("cari faktur: paling banyak 4 pencarian sales-invoice serentak (dulu Promise.all tanpa batas), golden tetap", async () => {
    const fx = FIXTURES[1](); // f02: 8 No. Nota
    const emu = buatEmulator(fx.data);
    const k = await jalankanLib(fx, emu);
    assert.equal(json(k.payload), json(golden[fx.nama].payload));
    assert.ok(emu.maksSerentak("/api/sales-invoice/list.do") <= 4, `serentak ${emu.maksSerentak("/api/sales-invoice/list.do")}`);
    assert.ok(emu.maksSerentak("/api/sales-invoice/list.do") >= 2, "tetap paralel");
});
