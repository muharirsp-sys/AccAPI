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
    assert.equal(n("KINO\u00A0NON\u00A0FOOD"), "KINO NON FOOD");
    assert.equal(n("KINO\tNON\t\tFOOD\n"), "KINO NON FOOD");
    assert.equal(n("\u202FKINO\u2003NON\u3000FOOD\u2028"), "KINO NON FOOD");
    assert.equal(n("\uFEFFKINO NON FOOD"), "KINO NON FOOD");
    assert.equal(n("KI\u200BNO\u00AD NON FOOD"), "KINO NON FOOD");
    assert.equal(n("KINO\u0000NON\u0085FOOD"), "KINO NON FOOD", "karakter kendali = pemisah, tak pernah tersimpan");
    assert.equal(n("ＫＩＮＯ\u3000ＮＯＮ\u3000ＦＯＯＤ"), "KINO NON FOOD", "huruf lebar penuh (NFKC)");
});

test("kosong/null -> '' (pemanggil wajib menolak)", () => {
    for (const v of [undefined, null, "", "   ", "\u00A0\t\u200B"]) assert.equal(n(v), "");
    assert.equal(bentukNormalSah(""), false);
});

test("titik tetap + cermin CHECK principal_alias_norm_bentuk", () => {
    const contoh = ["kino", " Forisa  MT ", "Heinz (HZ)", "straße", "ǰ", "ﬀ", "ᵃbc", "é\u0301", "a\u200D\u0301", "KINO\u00A0NON FOOD"];
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
    assert.equal(bentukNormalSah("KINO\u00A0NON"), false, "NBSP lolos CHECK Postgres — normalizer yang menolaknya");
});

test("rapikanTeks: spasi dirapikan, huruf tidak diubah", () => {
    assert.equal(rapikanTeks("  Heinz\u00A0(HZ)\t"), "Heinz (HZ)");
    assert.equal(rapikanTeks("Priskila\u2019s – Makmur"), "Priskila's - Makmur", "tanda baca tipografis juga di teks tampilan");
});

test("tanda baca tipografis OCR/Word disamakan: \u2018 \u2019 \u201A \u201B -> ', \u201C \u201D \u201E \u201F -> \", tanda hubung/pisah/minus -> -", () => {
    assert.equal(n("PRISKILA\u2019S PRIMA"), "PRISKILA'S PRIMA");
    assert.equal(n("\u2018kino\u2019 \u201Ax\u201B"), "'KINO' 'X'");
    assert.equal(n("\u201CKINO\u201D \u201ENON\u201F"), "\"KINO\" \"NON\"");
    assert.equal(n("KINO – NON — FOOD \u2015 X"), "KINO - NON - FOOD - X");
    assert.equal(n("A\u2010B\u2011C\u2012D\u2212E"), "A-B-C-D-E");
    assert.equal(n("PRISKILA\u2019S"), n("PRISKILA'S"), "ejaan Word = ejaan ketik");
});

test("karakter tak terlihat non-Cf dibuang: penggabung grafem U+034F, variation selector, pengisi Hangul, selektor Mongol", () => {
    assert.equal(n("KI\u034FNO"), "KINO");
    assert.equal(n("KINO\uFE0F NON\uFE00 FOOD"), "KINO NON FOOD");
    assert.equal(n("KINO\u{E0100}"), "KINO");
    assert.equal(n("KI\u3164NO\uFFA0"), "KINO");
    assert.equal(n("KINO\u180B\u115F"), "KINO");
});

test("sapuan BMP: setiap karakter -> titik tetap + lolos cermin CHECK", () => {
    for (let cp = 0; cp <= 0xFFFF; cp++) {
        if (cp >= 0xD800 && cp <= 0xDFFF) continue;
        const c = String.fromCodePoint(cp);
        for (const s of [`A${c}B`, `${c}\u0301`]) {
            const x = n(s);
            assert.equal(n(x), x, `titik tetap U+${cp.toString(16)}`);
            if (x) assert.ok(bentukNormalSah(x), `sah U+${cp.toString(16)}`);
        }
    }
});
