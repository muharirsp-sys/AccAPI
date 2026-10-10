/* S6e-1 uji karakterisasi Pelunasan: keluaran lib/pelunasan (payload sales-receipt, baris manual, toast, multiset
 * panggilan Accurate) atas fixture generik HARUS identik dengan uji/golden.json — direkam dari kode LAMA W
 * (salinan verbatim app/(dashboard)/api-wrapper/page.tsx basis 5d6cc936, uji/lama.ts) dan dibekukan. Perekam & salinan
 * lama dihapus; untuk merekam ulang/menambah fixture: checkout ec4e3d94 (lama.ts + rekam-golden.ts masih ada di sana).
 * Golden TIDAK boleh disunting tangan: perubahan perilaku disengaja = commit terpisah yang menjelaskan selisihnya. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buatEmulator } from "./uji/emulator-accurate.ts";
import { FIXTURES, fixturePratinjau } from "./uji/fixture.ts";
import { jalankanLib } from "./uji/jalankan.ts";
import { pratinjauDuplikat } from "./pratinjau-ganda.ts";
import type { AccurateFetch } from "./retur.ts";

type Golden = Record<string, { payload?: unknown; manualRows?: unknown; toasts?: unknown; panggilan: string[]; hasil?: unknown }>;
const golden = JSON.parse(readFileSync("lib/pelunasan/uji/golden.json", "utf8")) as Golden;
const json = (v: unknown) => JSON.stringify(v, null, 2);

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
