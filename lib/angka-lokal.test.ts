/* Kunci angkaLokalTeks: desimal dibaca dari TEKS (bukan float) — dasar penolakan > 2 desimal di layar /kasir. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { angkaLokalTeks, parseLocaleNumber } from "./angka-lokal.ts";

test("angkaLokalTeks: teks desimal persis, tanpa pembulatan float", () => {
    assert.equal(angkaLokalTeks("Rp 1.250.000"), "1250000");
    assert.equal(angkaLokalTeks("1.250.000,50"), "1250000.50");
    assert.equal(angkaLokalTeks("1,0000000000000001"), "1.0000000000000001");
    assert.equal(angkaLokalTeks("99999999999,999999"), "99999999999.999999");
    assert.equal(angkaLokalTeks("-250,5"), "-250.5");
    assert.equal(angkaLokalTeks(""), "0");
    assert.equal(angkaLokalTeks("1.2.3"), null);
    assert.equal(parseLocaleNumber("1.250.000,50"), 1250000.5);
    assert.ok(Number.isNaN(parseLocaleNumber("5 juta")));
});
