/* Kunci angkaLokalTeks: desimal dibaca dari TEKS (bukan float) — dasar penolakan > 2 desimal di layar /kasir; nominalKeTeks + isianNominal = satu pengurai rupiah bersama (No 122). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { angkaLokalTeks, isianNominal, nominalKeTeks, parseLocaleNumber } from "./angka-lokal.ts";

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

test("nominalKeTeks (pengurai rupiah bersama, audit desain 001 No 122): ribuan id-ID dan angka polos = nilai sama; tidak sah = galat, bukan 0", () => {
    const teks = (s: string) => { const r = nominalKeTeks(s); assert.ok("teks" in r, `${s}: ${JSON.stringify(r)}`); return r.teks; };
    assert.equal(teks("1.500.000"), "1500000");
    assert.equal(teks("1500000"), "1500000");
    assert.equal(teks("Rp 1.250.000,50"), "1250000.5");
    assert.equal(teks(""), "0"); // kosong = 0 (kebijakan Kasir dan Support)
    for (const salah of ["abc", "1.2.3", "-500", "1500000,555", "1e6"]) assert.ok("galat" in nominalKeTeks(salah), salah);
});

test("isianNominal: format ribuan sesudah blur dibaca balik ke angka yang SAMA; > 2 desimal / negatif = null", () => {
    for (const n of [0, 5, 1500, 1_500_000, 1250.5, 1.15, 999.99, 100_000_000_000]) {
        const t = isianNominal(n);
        assert.ok(t !== null, String(n));
        const r = nominalKeTeks(t);
        assert.ok("teks" in r && Number(r.teks) === n, `${n} -> ${t} -> ${JSON.stringify(r)}`);
    }
    assert.equal(isianNominal(1_500_000), "1.500.000");
    for (const n of [123.456, -1, Number.NaN, 100_000_000_001]) assert.equal(isianNominal(n), null, String(n));
});
