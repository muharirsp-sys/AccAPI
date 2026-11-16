/* Uji murni validasi wajah check-in (owner 16 Nov 2026): kosinus, status, tanda SPV. */
import assert from "node:assert/strict";
import test from "node:test";
import { AMBANG_WAJAH, benderaWajah, kosinus, nilaiWajah } from "./wajah";

const v = (...x: number[]) => x;

test("kosinus: sama = 1, tegak lurus = 0, panjang beda / vektor nol = NaN", () => {
    assert.equal(kosinus(v(1, 2, 3), v(2, 4, 6)), 1);
    assert.equal(kosinus(v(1, 0), v(0, 1)), 0);
    assert.ok(Number.isNaN(kosinus(v(1, 2), v(1, 2, 3))));
    assert.ok(Number.isNaN(kosinus(v(0, 0), v(1, 1))));
    assert.ok(Number.isNaN(kosinus([], [])));
});

test("nilaiWajah: tanpa wajah, acuan baru, cocok di atas ambang, beda di bawahnya", () => {
    assert.deepEqual(nilaiWajah(null, v(1, 0)), { status: "tanpa_wajah", skor: null });
    assert.deepEqual(nilaiWajah(v(1, 0), null), { status: "acuan_baru", skor: null });
    assert.deepEqual(nilaiWajah(v(1, 0), v(1, 0)), { status: "cocok", skor: 1 });
    // cos 0,5 rad ≈ 0,8776 (cocok); cos 1,3 rad ≈ 0,2675 (beda, < 0,363).
    assert.equal(nilaiWajah(v(1, 0), v(Math.cos(0.5), Math.sin(0.5))).status, "cocok");
    assert.deepEqual(nilaiWajah(v(1, 0), v(Math.cos(1.3), Math.sin(1.3))), { status: "beda", skor: 0.2675 });
    const pas = Math.acos(AMBANG_WAJAH);
    assert.equal(nilaiWajah(v(1, 0), v(Math.cos(pas) + 1e-9, Math.sin(pas))).status, "cocok", "tepat di ambang = cocok");
    assert.deepEqual(nilaiWajah(v(1, 2), v(1, 2, 3)), { status: "tidak_terbaca", skor: null });
});

test("benderaWajah: hanya beda dan tanpa wajah yang jadi tanda SPV", () => {
    assert.equal(benderaWajah("beda"), "wajah_beda");
    assert.equal(benderaWajah("tanpa_wajah"), "wajah_tanpa");
    for (const s of ["cocok", "acuan_baru", "tidak_terbaca", null, undefined]) assert.equal(benderaWajah(s), null);
});
