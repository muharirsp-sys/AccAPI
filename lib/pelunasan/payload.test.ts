/* S6e-1 butir 4b: tanggal transaksi bawaan Pelunasan = KEMARIN menurut WITA, apa pun zona peramban/server.
 * Dulu `setDate(-1)` waktu lokal lalu `toISOString()` (UTC): pukul 00.00–07.59 WITA mundur DUA hari. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tanggalKemarin } from "./payload.ts";
import { getTextVal, hasMeaningfulCellValue } from "./sel.ts";
import { todayWita } from "../insentif-payment-date.ts";

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

test("susulan S6e-1 (B, RENDAH): lintas tahun 31 Des 23.59 / 1 Jan 00.00 WITA — sama dengan todayWita (lib/insentif-payment-date)", () => {
    for (const tz of ["Asia/Makassar", "UTC", "America/New_York"]) {
        denganTZ(tz, () => {
            assert.equal(tanggalKemarin(new Date("2026-12-31T23:59:00+08:00")), "2026-12-30", `${tz} 31 Des 23.59 WITA`);
            assert.equal(tanggalKemarin(new Date("2027-01-01T00:00:00+08:00")), "2026-12-31", `${tz} 1 Jan 00.00 WITA`);
            assert.equal(tanggalKemarin(new Date("2027-01-01T07:59:00+08:00")), "2026-12-31", `${tz} 1 Jan 07.59 WITA (UTC masih 31 Des)`);
            assert.equal(todayWita(new Date("2026-12-31T23:59:00+08:00")), "2026-12-31", `${tz} hari ini 31 Des`);
            assert.equal(todayWita(new Date("2027-01-01T00:00:00+08:00")), "2027-01-01", `${tz} hari ini 1 Jan`);
        });
    }
});

test("susulan S6e-1 (A/B, RENDAH): sel ber-NBSP (U+00A0) dirapikan seperti spasi — getTextVal & hasMeaningfulCellValue", () => {
    // NBSP di TENGAH sel: di tepi sudah dibuang trim(), jadi hanya kasus ini yang menjaga replace(/\u00A0/g, " ").
    const baris = { " Code Outlet ": "\u00A0PLG-A-001\u00A0", Nama: "PELANGGAN\u00A0A", Kosong: "\u00A0\u00A0", Nan: "\u00A0nan\u00A0" };
    assert.equal(getTextVal(baris, "Nama"), "PELANGGAN A");
    assert.equal(getTextVal(baris, "Code Outlet"), "PLG-A-001");
    assert.equal(getTextVal(baris, "Kosong"), "");
    assert.equal(getTextVal(baris, "Nan"), "");
    assert.deepEqual(["Code Outlet", "Kosong", "Nan"].map((k) => hasMeaningfulCellValue(baris, k)), [true, false, false]);
});
