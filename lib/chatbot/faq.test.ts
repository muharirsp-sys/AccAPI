// Audit desain 001 R-24: setiap tautan jawaban FAQ menuju halaman yang ada (dulu "Buka Validator" → /validator, tidak ada).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import faq from "./faq.json";

const appDir = fileURLToPath(new URL("../../app/", import.meta.url));

test("FAQ: semua href menunjuk ke page.tsx yang ada", () => {
    // Rute = path berkas page.tsx tanpa grup "(...)". ponytail: rute dinamis [x] tidak dicocokkan; tambahkan bila FAQ butuh.
    const rute = new Set(
        readdirSync(appDir, { recursive: true, encoding: "utf8" })
            .map((p) => p.replace(/\\/g, "/"))
            .filter((p) => p === "page.tsx" || p.endsWith("/page.tsx"))
            .map((p) => "/" + p.split("/").slice(0, -1).filter((s) => !/^\(.*\)$/.test(s)).join("/")),
    );
    const href = faq.flatMap((e) => ("links" in e && e.links ? e.links.map((l) => l.href) : []));
    assert.ok(href.length > 0);
    for (const h of href) assert.ok(rute.has(h), `FAQ menautkan halaman yang tidak ada: ${h}`);
});
