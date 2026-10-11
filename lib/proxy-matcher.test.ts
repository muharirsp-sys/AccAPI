/* S7-sesi: matcher proxy.ts menentukan halaman mana yang mendapat header x-current-path (gerbang halaman layout dashboard).
 * Halaman berawalan "api" (Konsol /api-wrapper) WAJIB lewat proxy; route /api dan /api/... serta aset statis tidak. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config } from "../proxy.ts";

const cocok = (url: string) => unstable_doesMiddlewareMatch({ config, url });

test("matcher proxy: Konsol /api-wrapper lewat proxy (gerbang halaman berlaku); /api dan /api/... tidak", () => {
    for (const halaman of ["/", "/api-wrapper", "/api-wrapper?accurate=error&alasan=state_beda", "/sesi-accurate", "/pelunasan", "/login"]) {
        assert.equal(cocok(halaman), true, halaman);
    }
    for (const lewat of ["/api", "/api/auth/callback", "/api/proxy", "/_next/static/chunks/a.js", "/_next/image?url=x", "/favicon.ico", "/sw.js", "/manifest.json"]) {
        assert.equal(cocok(lewat), false, lewat);
    }
});
