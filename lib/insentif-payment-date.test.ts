/* Kunci: tanggal bayar insentif tidak boleh di masa depan WITA, tidak sebelum awal periode,
   dan tanpa tanggal tetap "sekarang" seperti perilaku lama. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bacaAlasan, parsePaymentDate, perubahanLunas, resolvePaidAt } from "./insentif-payment-date.ts";

// 7 Okt 2026 17:30 UTC = 8 Okt 2026 01:30 WITA — server UTC masih "kemarin".
const now = new Date("2026-10-07T17:30:00Z");
const sept = { periodMonth: 9, periodYear: 2026 };

test("tanpa tanggal atau hari ini WITA = sekarang", () => {
    assert.deepEqual(parsePaymentDate(undefined, sept, now), { date: now });
    assert.deepEqual(parsePaymentDate("", sept, now), { date: now });
    assert.deepEqual(parsePaymentDate("2026-10-08", sept, now), { date: now });
});

test("tanggal lampau dalam rentang disimpan 12.00 WITA", () => {
    const r = parsePaymentDate("2026-09-01", sept, now);
    assert.ok("date" in r);
    assert.equal(r.date.toISOString(), "2026-09-01T04:00:00.000Z");
});

test("ditolak: format, tanggal kalender, masa depan WITA, sebelum periode", () => {
    for (const salah of ["2026-9-1", "08/10/2026", "2026-02-30", "2026-02-32", 20261001]) {
        assert.ok("error" in parsePaymentDate(salah, sept, now), String(salah));
    }
    assert.match((parsePaymentDate("2026-10-09", sept, now) as { error: string }).error, /masa depan/);
    assert.match((parsePaymentDate("2026-08-31", sept, now) as { error: string }).error, /awal periode/);
});

test("resolvePaidAt: hanya lunas yang membaca tanggal (POST = PATCH)", () => {
    assert.deepEqual(resolvePaidAt("belum", "bukan-tanggal", sept, now), { date: null });
    assert.deepEqual(resolvePaidAt(undefined, "2099-01-01", sept, now), { date: null });
    assert.ok("error" in resolvePaidAt("lunas", "2099-01-01", sept, now));
    assert.deepEqual(resolvePaidAt("lunas", undefined, sept, now), { date: now });
});

test("perubahanLunas: catat hanya bila baris lama sudah lunas dan tanggal/pencatat berubah", () => {
    const tgl = new Date("2026-09-30T04:00:00Z");
    const baru = { paymentDate: new Date("2026-09-01T04:00:00Z"), paidBy: "u1" };
    assert.equal(perubahanLunas(undefined, baru), null);
    assert.equal(perubahanLunas({ paymentStatus: "belum", paymentDate: null, paidBy: null }, baru), null);
    assert.equal(perubahanLunas({ paymentStatus: "lunas", paymentDate: baru.paymentDate, paidBy: "u1" }, baru), null);
    assert.deepEqual(perubahanLunas({ paymentStatus: "lunas", paymentDate: tgl, paidBy: "u2" }, baru), {
        paymentDate: { lama: "2026-09-30T04:00:00.000Z", baru: "2026-09-01T04:00:00.000Z" },
        paidBy: { lama: "u2", baru: "u1" },
    });
});

test("bacaAlasan: wajib string, dipangkas, min. 5, maks. 500", () => {
    for (const salah of [null, {}, { alasan: "  abcd " }, { alasan: ["abcde"] }, { alasan: 12345 }]) {
        assert.equal(bacaAlasan(salah), null, JSON.stringify(salah));
    }
    assert.equal(bacaAlasan({ alasan: "  Closing salah  " }), "Closing salah");
    assert.equal(bacaAlasan({ alasan: "x".repeat(600) })?.length, 500);
});
