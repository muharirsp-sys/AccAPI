/*
 * Tujuan: Self-check helper layar Laporan Harian: run macet vs mengirim (batas 10 menit), label status, mode dari catatan.
 * Caller: npm test
 * Dependensi: node:test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { modeDariNote, statusRun } from "@/lib/laporan-harian/ui";

test("status run: sending > 10 menit = macet, sebaliknya mengirim", () => {
    const now = new Date("2026-10-07T01:00:00Z");
    assert.equal(statusRun("sending", "2026-10-07T00:55:00Z", now).kode, "mengirim");
    assert.equal(statusRun("sending", "2026-10-07T00:49:00Z", now).kode, "macet");
    assert.equal(statusRun("sent", now, now).kode, "terkirim");
    assert.equal(statusRun("failed", now, now).kode, "gagal");
    assert.equal(statusRun("dry_run", now, now).label, "Belum dikirim");
});

test("mode email dibaca dari catatan run", () => {
    assert.equal(modeDariNote("feed dashboard: +10; email_mode:closing"), "closing");
    assert.equal(modeDariNote("email_mode:daily"), "daily");
    assert.equal(modeDariNote("feed dashboard: +10"), null);
    assert.equal(modeDariNote(null), null);
});
