/* S6e-2 butir 9: parsePelunasan mengembalikan hitungan baris dibaca + dilewati (dengan alasan) untuk langkah Tinjau, tanpa
 * mengubah payload/manualRows (golden S6e-1 di pelunasan.test.ts tetap identik). Tanpa sesi Accurate = tanpa panggilan. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePelunasan } from "./parser.ts";
import { buatEmulator } from "./uji/emulator-accurate.ts";
import { FIXTURES } from "./uji/fixture.ts";
import { deteksiFormatPelunasan } from "./parser.ts";
import type { AccurateFetch } from "./retur.ts";

const PETA = { mapTunaiAutoNum: "300", mapTunaiBank: "110102", mapTrfAutoNum: "", mapTrfBank: "", mapBgAutoNum: "", mapBgBank: "",
    mapPot1Account: "", mapPot2Account: "", mapPot3Account: "" };
const tanpaAkses: AccurateFetch = async () => { throw new Error("TIDAK BOLEH ke Accurate"); };

test("hitungan: dibaca = semua baris data; dilewati = tanpa Code Outlet / tanpa nominal, bernomor baris mulai 1", async () => {
    const rows = [
        { "Code Outlet": "PLG-1", "No. Nota": "INV-1", "Tunai": 1000 },
        { "Code Outlet": "", "No. Nota": "INV-2", "Tunai": 500 },
        { "Code Outlet": "PLG-3", "No. Nota": "INV-3", "Tunai": 0, "Ket. All Trx": "-" },
        { "Code Outlet": "PLG-4", "No. Nota": "INV-4", "Pot.1 Kwtnsi": 200 },
    ];
    const r = await parsePelunasan(rows, { trxDate: "2026-10-09", isKeySaved: false, peta: PETA, accurateFetch: tanpaAkses });
    assert.equal(r.counts.read, 4);
    assert.deepEqual(r.counts.skipped, [{ row: 2, reason: "KODE_OUTLET_KOSONG" }, { row: 3, reason: "TANPA_NOMINAL" }]);
    assert.equal(r.payload.length, 2, "PLG-1 (tunai) dan PLG-4 (potongan saja) tetap jadi pelunasan");
});

test("hitungan konsisten di semua fixture golden: dibaca = jumlah baris, dilewati unik & dalam rentang", async () => {
    for (const buat of FIXTURES) {
        const fx = buat();
        if (!deteksiFormatPelunasan(fx.rows)) continue;
        const { trxDate, isKeySaved, ...peta } = fx.opsi;
        const r = await parsePelunasan(fx.rows, { trxDate, isKeySaved, peta, accurateFetch: buatEmulator(fx.data).accurateFetch as AccurateFetch });
        assert.equal(r.counts.read, fx.rows.length, fx.nama);
        const nomor = r.counts.skipped.map((x) => x.row);
        assert.equal(new Set(nomor).size, nomor.length, fx.nama);
        assert.ok(nomor.every((n) => n >= 1 && n <= fx.rows.length), fx.nama);
    }
});
