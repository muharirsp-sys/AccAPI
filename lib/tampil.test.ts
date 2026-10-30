/*
 * Tujuan: Bukti kecil format tampilan bersama (lib/tampil.ts): WITA, tanggal kalender tidak bergeser, kosong, sebab galat.
 * Caller: npm test.
 * Dependensi: node:test.
 * Side Effects: Tidak ada.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { KOSONG, hariIniWita, sebabHttp, tanggalWita, waktuWita } from "./tampil";

test("tanggal dan waktu tampil WITA, tanggal kalender tidak bergeser", () => {
    assert.equal(tanggalWita("2026-10-06"), "06/10/2026");
    assert.equal(waktuWita("2026-10-06T01:40:00Z"), "06/10/2026 09.40");
    assert.equal(waktuWita("2026-10-06T16:30:00Z"), "07/10/2026 00.30");
    assert.equal(hariIniWita(new Date("2026-10-06T16:30:00Z")), "2026-10-07");
});

test("kosong dan tak valid jadi KOSONG, bukan em dash", () => {
    assert.equal(KOSONG, "-");
    assert.equal(tanggalWita(null), KOSONG);
    assert.equal(waktuWita("bukan tanggal"), KOSONG);
});

test("sebab galat tanpa kode mentah", () => {
    for (const s of [0, 400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 418]) assert.doesNotMatch(sebabHttp(s), /\d{3}|HTTP/);
});
