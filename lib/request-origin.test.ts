/** Tujuan: Cegah regresi penolakan situs publik di balik proxy tanpa menerima situs asing.
 * Caller: node --experimental-strip-types --test lib/request-origin.test.ts.
 * Dependensi: node assert/test, request-origin. Main Functions: tests. Side Effects: tidak ada.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { hasExpectedOrigin } from "./request-origin.ts";

test("alamat publik diterima, alamat proxy internal bukan origin pengguna", () => {
    assert.equal(hasExpectedOrigin("https://web-super.online", "https://web-super.online/"), true);
    assert.equal(hasExpectedOrigin("http://localhost:3000", "https://web-super.online"), false);
    assert.equal(hasExpectedOrigin("http://localhost:3000", "http://localhost:3000"), true);
});

test("origin asing, kosong, opaque, port/protokol berbeda, dan konfigurasi salah ditolak", () => {
    for (const origin of [null, "", "null", "https://evil.example", "https://web-super.online.evil.example", "http://web-super.online", "https://web-super.online:8443", "https://web-super.online/"]) {
        assert.equal(hasExpectedOrigin(origin, "https://web-super.online"), false, String(origin));
    }
    for (const configured of ["", "invalid", "file:///tmp", "null"]) {
        assert.equal(hasExpectedOrigin("null", configured), false, configured);
    }
});
