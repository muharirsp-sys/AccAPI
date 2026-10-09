/*
 * Tujuan: penjaga statik urutan kunci (AM-022/023, S6-0b) — setiap db.transaction di route yang memutasi
 *   ledger klaim / batch OFF mengambil kunci baris induk sebagai pernyataan PERTAMA: claim_workflow lewat
 *   lockClaimWorkflow(tx, id), off_batch lewat SELECT … FOR NO KEY UPDATE. Kunci terlambat / hilang =
 *   pembayaran ganda (applied 160 dari outstanding 100) atau siklus deadlock 40P01 antar-route.
 * Caller: npm test (tanpa Postgres). Bukti perilaku nyata: harness am040 (claim/off/patch/deadlock).
 * Dependensi: berkas sumber route (dibaca sebagai teks).
 * Side Effects: tidak ada.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CW = "app/api/claim-workflow/[id]";
const SUB = `${CW}/submissions/[submissionId]`;

const CLAIM_ROUTES = [
    `${CW}/payments/route.ts`,
    `${CW}/payments/[paymentId]/void/route.ts`,
    `${CW}/close/route.ts`,
    `${SUB}/payments/route.ts`,
    `${SUB}/payments/[paymentId]/void/route.ts`,
    `${SUB}/close/route.ts`,
    `${SUB}/route.ts`,
    `${SUB}/claim-letter/route.ts`,
    `${SUB}/receipt/route.ts`,
    `${SUB}/summary/route.ts`,
    `${CW}/submissions/from-items/route.ts`,
    `${SUB}/items/route.ts`,
    `${CW}/items/[itemId]/route.ts`,
];
const OFF_ROUTES = [
    "app/api/off-program-control/batches/[id]/finance-payment/route.ts",
    "app/api/off-program-control/batches/[id]/route.ts",
];

const CLAIM_LOCK = /^await lockClaimWorkflow\(tx, id\);/;
const OFF_LOCK = /^const \[\w+\] = await tx\.select\(\)\.from\(offBatch\)\.where\(eq\(offBatch\.id, id\)\)\.for\("no key update"\);/;

/** Pernyataan pertama (abaikan baris kosong & komentar //) di setiap callback db.transaction. */
function firstStatements(src: string) {
    return [...src.matchAll(/db\.transaction\(async \(tx\) => \{/g)].map((m) =>
        src.slice(m.index + m[0].length).split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("//")) ?? "");
}

for (const [routes, lock] of [[CLAIM_ROUTES, CLAIM_LOCK], [OFF_ROUTES, OFF_LOCK]] as const) {
    for (const route of routes) {
        test(`kunci induk = pernyataan pertama transaksi: ${route}`, () => {
            const firsts = firstStatements(readFileSync(`${ROOT}${route}`, "utf8"));
            assert.ok(firsts.length > 0, "route tanpa db.transaction — daftar penjaga basi?");
            firsts.forEach((first, i) => assert.match(first, lock, `transaksi #${i + 1} dimulai dengan: ${first}`));
        });
    }
}
