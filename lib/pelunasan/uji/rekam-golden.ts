/**
 * SEKALI-PAKAI (S6e-1 tahap 1): merekam golden dari kode LAMA (lama.ts = salinan verbatim W) atas fixture generik.
 * Pakai: npx tsx lib/pelunasan/uji/rekam-golden.ts  → menulis lib/pelunasan/uji/golden.json. Dihapus bersama lama.ts.
 */
import { writeFileSync } from "node:fs";
import { jalankanPelunasanLama, jalankanPratinjauLama } from "./lama.ts";
import { buatEmulator } from "./emulator-accurate.ts";
import { FIXTURES, fixturePratinjau } from "./fixture.ts";

async function rekam() {
    const golden: Record<string, unknown> = {};
    for (const buat of FIXTURES) {
        const fx = buat();
        const emu = buatEmulator(fx.data);
        const k = await jalankanPelunasanLama(fx.rows, { ...fx.opsi, accurateFetch: emu.accurateFetch });
        golden[fx.nama] = {
            catatan: fx.catatan,
            payload: k.payloadStr === null ? null : JSON.parse(k.payloadStr),
            manualRows: k.manualRows,
            toasts: k.toasts,
            panggilan: emu.panggilanKanonik(),
        };
    }
    const p = fixturePratinjau();
    const emuP = buatEmulator(p.data);
    const hasilP = await jalankanPratinjauLama(p.rows, p.routeKey, { blockedEntries: p.blockedEntries, accurateFetch: emuP.accurateFetch });
    golden["p01-pratinjau-duplikat"] = { hasil: hasilP, panggilan: emuP.panggilanKanonik() };

    writeFileSync("lib/pelunasan/uji/golden.json", JSON.stringify(golden, null, 2) + "\n");
    console.log("golden:", Object.keys(golden).join(", "));
}
void rekam();
