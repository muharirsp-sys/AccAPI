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
