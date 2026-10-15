import { test } from "node:test";
import assert from "node:assert/strict";
import { bolehMuatUlang, galatVersiLama } from "./muat-ulang-versi";

test("galat versi lama dikenali, galat biasa tidak", () => {
    assert.equal(galatVersiLama({ name: "ChunkLoadError", message: "x" }), true);
    assert.equal(galatVersiLama(new Error("Loading chunk 4821 failed. (error: https://x/_next/static/chunks/4821.js)")), true);
    assert.equal(galatVersiLama(new Error("Loading CSS chunk app-layout failed")), true);
    assert.equal(galatVersiLama(new Error("Failed to load chunk /_next/static/chunks/0abc.js from module 7539")), true); // Turbopack (Next 16)
    assert.equal(galatVersiLama(new TypeError("Failed to fetch dynamically imported module: https://x/a.js")), true);
    assert.equal(galatVersiLama(new TypeError("Cannot read properties of undefined (reading 'map')")), false);
    assert.equal(galatVersiLama(null), false);
});

test("muat ulang paling banyak sekali per 60 detik; storage rusak = tidak", () => {
    const isi = new Map<string, string>();
    const s = { getItem: (k: string) => isi.get(k) ?? null, setItem: (k: string, v: string) => void isi.set(k, v) };
    assert.equal(bolehMuatUlang(1_000_000, s), true);
    assert.equal(bolehMuatUlang(1_030_000, s), false);
    assert.equal(bolehMuatUlang(1_061_000, s), true);
    const rusak = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => undefined };
    assert.equal(bolehMuatUlang(1_000_000, rusak), false);
});
