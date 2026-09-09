/* Kunci: `list.do` TANPA `fields` hanya mengembalikan { id }, dan `fields` yang diisi TIDAK
   menyertakan `id` secara otomatis — dibuktikan live production 2026-07-13: tanpa "id" eksplisit
   seluruh baris masuk sebagai NaN dan primary key gagal. Regresi ini diam (Accurate tidak error),
   jadi dijaga dari sumbernya, bukan dari runtime. Sama pola dengan lib/rbac/registry.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SYNC_MODULE_NAMES } from "./sync.ts";

const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "sync.ts"), "utf8");

test("setiap modul sync meminta `id` secara eksplisit", () => {
    const fields = [...src.matchAll(/fields:\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(fields.length >= SYNC_MODULE_NAMES.length, "ada modul tanpa daftar fields");
    for (const list of fields) {
        assert.ok(list.split(",").map((f) => f.trim()).includes("id"), `fields tanpa "id": ${list}`);
    }
});

test("cabang terdaftar sebagai modul sync", () => {
    // Penomoran faktur Accurate per cabang: tanpa master cabang, order tidak punya branchId
    // yang sah dan fakturnya masuk urutan cabang default.
    assert.ok(SYNC_MODULE_NAMES.includes("branch"), "modul branch belum terdaftar");
    assert.match(src, /endpoint:\s*"\/branch\/list\.do"/);
});
