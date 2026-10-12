/* FK-MSM (pilot Form Kontrol cabang, 12 Okt 2026) TANPA DB: kunci hari JKS + bentuk baku unggah, paritas minggu ISO. Perilaku route
 * ASLI pada Postgres = lib/form-kontrol/fk-msm-pg.test.ts. Data contoh generik. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hariBaku, kunciHari } from "./constants.ts";
import { getWeekParity, parseDateString } from "./db.ts";

test("butir 2: kunci hari tak peka huruf/spasi/tanda; bentuk baku unggah; hari tak dikenal = null, kosong = ''", () => {
    for (const v of ["SENIN", " senin ", "Senin"]) assert.equal(kunciHari(v), "SENIN");
    for (const v of ["JUM'AT", "Jum’at", "jumat", "JUM AT"]) assert.equal(kunciHari(v), "JUMAT");
    assert.equal(hariBaku("SABTU"), "Sabtu");
    assert.equal(hariBaku(" jum'at "), "Jumat");
    assert.equal(hariBaku("Minggu"), null, "Minggu tidak punya rute");
    assert.equal(hariBaku("Senen"), null);
    assert.equal(hariBaku(""), "");
    assert.equal(hariBaku(undefined), "");
});

test("butir 2: paritas minggu = minggu ISO % 2", () => {
    assert.equal(getWeekParity(parseDateString("2026-10-12")), "genap"); // minggu 42
    assert.equal(getWeekParity(parseDateString("2026-10-18")), "genap"); // Minggu masih minggu ISO 42
    assert.equal(getWeekParity(parseDateString("2026-10-19")), "ganjil"); // minggu 43
    assert.equal(getWeekParity(parseDateString("2026-01-01")), "ganjil"); // Kamis 1 Jan 2026 = minggu 1
});
