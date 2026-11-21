/*
 * Tujuan: Self-check primitive grafik Fiori: skala bersama, posisi terjepit, dan penanda acuan di posisi yang benar.
 * Caller: npm test (tsx --test components/**\/*.test.ts).
 * Dependensi: node:test, react-dom/server, components/fiori/chart.
 * Main Functions: tes skalaBullet, posisiBullet, Bullet.
 * Side Effects: Tidak ada.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Bullet, posisiBullet, skalaBullet } from "./chart";

test("skalaBullet: minimal 100, kelipatan 10 di atas nilai terbesar, abaikan bukan angka", () => {
    assert.equal(skalaBullet([]), 100);
    assert.equal(skalaBullet([46.5, 68, 75.1]), 100);
    assert.equal(skalaBullet([101, 68]), 110);
    assert.equal(skalaBullet([150, Number.NaN, Number.POSITIVE_INFINITY]), 150);
});

test("posisiBullet: proporsional pada skala, dijepit 0..100", () => {
    assert.equal(posisiBullet(68, 100), 68);
    assert.equal(posisiBullet(55, 110), 50);
    assert.equal(posisiBullet(130, 110), 100);
    assert.equal(posisiBullet(-5, 100), 0);
    assert.equal(posisiBullet(50, 0), 0);
    assert.equal(posisiBullet(Number.NaN, 100), 0);
});

test("Bullet: batang = nilai, penanda = acuan, garis penuh = 100%, tersembunyi dari pembaca layar", () => {
    const html = renderToStaticMarkup(createElement(Bullet, { nilai: 55, acuan: 66, skala: 110, tone: "warn" }));
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /data-tone="warn"/);
    assert.match(html, /class="fi-bullet-bar" x="0" y="6" width="50"/);
    assert.match(html, /class="fi-bullet-ref" x1="60" x2="60"/);
    assert.match(html, /class="fi-bullet-full" x1="90.9\d*" x2="90.9\d*"/);
});
