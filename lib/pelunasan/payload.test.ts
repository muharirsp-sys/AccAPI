/* S6e-1 butir 4b: tanggal transaksi bawaan Pelunasan = KEMARIN menurut WITA, apa pun zona peramban/server.
 * Dulu `setDate(-1)` waktu lokal lalu `toISOString()` (UTC): pukul 00.00–07.59 WITA mundur DUA hari. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tanggalKemarin } from "./payload.ts";

const denganTZ = (tz: string, fn: () => void) => {
    const lama = process.env.TZ;
    process.env.TZ = tz;
    try { fn(); } finally { if (lama === undefined) delete process.env.TZ; else process.env.TZ = lama; }
};

test("tanggal bawaan = kemarin WITA, di zona mana pun", () => {
    for (const tz of ["Asia/Makassar", "UTC", "Asia/Jakarta", "America/New_York"]) {
        denganTZ(tz, () => {
            assert.equal(tanggalKemarin(new Date("2026-10-10T01:30:00+08:00")), "2026-10-09", `${tz} 01.30 WITA`);
            assert.equal(tanggalKemarin(new Date("2026-10-10T00:00:00+08:00")), "2026-10-09", `${tz} 00.00 WITA`);
            assert.equal(tanggalKemarin(new Date("2026-10-10T07:59:00+08:00")), "2026-10-09", `${tz} 07.59 WITA`);
            assert.equal(tanggalKemarin(new Date("2026-10-10T12:00:00+08:00")), "2026-10-09", `${tz} 12.00 WITA`);
            assert.equal(tanggalKemarin(new Date("2026-10-10T23:59:00+08:00")), "2026-10-09", `${tz} 23.59 WITA`);
            assert.equal(tanggalKemarin(new Date("2026-03-01T06:00:00+08:00")), "2026-02-28", `${tz} lintas bulan`);
        });
    }
});
