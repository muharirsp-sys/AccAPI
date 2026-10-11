/* S7-2: normalizer baku principal — spasi Unicode, tanda baca tetap, titik tetap, cermin CHECK S7-0. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bentukNormalSah, normalisasiPrincipal as n, rapikanTeks } from "./normalisasi.ts";

test("huruf besar, trim, spasi tunggal; tanda baca & PT TIDAK dibuang", () => {
    assert.equal(n("  kino indonesia. tbk, pt  "), "KINO INDONESIA. TBK, PT");
    assert.equal(n("**PT.PRISKILA PRIMA MAKMUR**"), "**PT.PRISKILA PRIMA MAKMUR**");
    assert.equal(n("PT. PRISKILA   PRIMA MAKMUR"), "PT. PRISKILA PRIMA MAKMUR");
    assert.equal(n("URC INDONESIA, PTMIX FOOD"), "URC INDONESIA, PTMIX FOOD");
    assert.notEqual(n("PT. PRISKILA PRIMA MAKMUR"), n("PRISKILA PRIMA MAKMUR, PT"), "pencocokan longgar = laporan, bukan normalizer");
});

test("spasi Unicode -> spasi biasa: NBSP, tab, baris baru, spasi sempit/ideografis, BOM; lebar-nol dibuang", () => {
    assert.equal(n("KINO NON FOOD"), "KINO NON FOOD");
    assert.equal(n("KINO\tNON\t\tFOOD\n"), "KINO NON FOOD");
    assert.equal(n(" KINO NON　FOOD "), "KINO NON FOOD");
    assert.equal(n("﻿KINO NON FOOD"), "KINO NON FOOD");
    assert.equal(n("KI​NO­ NON FOOD"), "KINO NON FOOD");
    assert.equal(n("KINO\u0000NON\u0085FOOD"), "KINO NON FOOD", "karakter kendali = pemisah, tak pernah tersimpan");
    assert.equal(n("ＫＩＮＯ　ＮＯＮ　ＦＯＯＤ"), "KINO NON FOOD", "huruf lebar penuh (NFKC)");
});

test("kosong/null -> '' (pemanggil wajib menolak)", () => {
    for (const v of [undefined, null, "", "   ", " \t​"]) assert.equal(n(v), "");
    assert.equal(bentukNormalSah(""), false);
});

test("titik tetap + cermin CHECK principal_alias_norm_bentuk", () => {
    const contoh = ["kino", " Forisa  MT ", "Heinz (HZ)", "straße", "ǰ", "ﬀ", "ᵃbc", "é́", "a‍́", "KINO NON FOOD"];
    for (const c of contoh) {
        const x = n(c);
        assert.equal(n(x), x, `titik tetap: ${JSON.stringify(c)}`);
        assert.ok(bentukNormalSah(x), `sah: ${JSON.stringify(c)} -> ${JSON.stringify(x)}`);
        assert.equal(x, x.toUpperCase());
        assert.match(x, /^\S+( \S+)*$/);
    }
    assert.equal(bentukNormalSah("kino"), false);
    assert.equal(bentukNormalSah(" KINO"), false);
    assert.equal(bentukNormalSah("KINO  NON"), false);
    assert.equal(bentukNormalSah("KINO NON"), false, "NBSP lolos CHECK Postgres — normalizer yang menolaknya");
});

test("rapikanTeks: spasi dirapikan, huruf tidak diubah", () => {
    assert.equal(rapikanTeks("  Heinz (HZ)\t"), "Heinz (HZ)");
});
