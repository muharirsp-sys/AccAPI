/*
 * Tujuan: penjaga statik urutan kunci (AM-022/023, S6-0b) — setiap db.transaction di route yang memutasi
 *   ledger klaim / batch OFF mengambil kunci baris induk sebagai pernyataan PERTAMA: claim_workflow lewat
 *   lockClaimWorkflow(tx, id), off_batch lewat SELECT … FOR NO KEY UPDATE. Kunci terlambat / hilang =
 *   pembayaran ganda (applied 160 dari outstanding 100) atau siklus deadlock 40P01 antar-route.
 *   BL-21 (S6d lanjutan): principal_order_batch lewat kunciBatch — hapus/ganti `update`, antre (`antrekan` berbatch) `key share`,
 *   Validasi `key share` SEBELUM baris line (line dulu = siklus dengan Hapus yang CASCADE ke line -> 40P01).
 *   Bukti perilaku: lib/principal-order-lock.test.ts (PG).
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

const BATCH_ROUTE = "app/api/principal-order/route.ts";
const BATCH_LOCK = /^const \w+ = (?:existing \? )?await kunciBatch\(tx, [\w.]+, "update"\)/;
const VALIDASI_ROUTE = "app/api/principal-order/validate/route.ts";
const VALIDASI_LOCK = /^if \(!\(await kunciBatch\(tx, id, "key share"\)\)\) return false;/;
const ANTRE_LOCK = /^if \(input\.batchId && !batchSah\(await kunciBatch\(tx, input\.batchId, "key share"\), input\.batchVersi\)\) return null;/;

const CLAIM_LOCK = /^await lockClaimWorkflow\(tx, id\);/;
const OFF_LOCK = /^const \[\w+\] = await tx\.select\(\)\.from\(offBatch\)\.where\(eq\(offBatch\.id, id\)\)\.for\("no key update"\);/;

/** Pernyataan pertama (abaikan baris kosong & komentar //) di setiap callback db/database.transaction. */
function firstStatements(src: string) {
    return [...src.matchAll(/\b(?:db|database)\.transaction\(async \(tx\) => \{/g)].map((m) =>
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

test(`kunci batch = pernyataan pertama transaksi: ${BATCH_ROUTE}`, () => {
    const firsts = firstStatements(readFileSync(`${ROOT}${BATCH_ROUTE}`, "utf8"));
    assert.equal(firsts.length, 2, "hapus + ganti — daftar penjaga basi?");
    firsts.forEach((first, i) => assert.match(first, BATCH_LOCK, `transaksi #${i + 1} dimulai dengan: ${first}`));
});

test(`kunci batch = pernyataan pertama transaksi: ${VALIDASI_ROUTE}`, () => {
    const firsts = firstStatements(readFileSync(`${ROOT}${VALIDASI_ROUTE}`, "utf8"));
    assert.equal(firsts.length, 1, "satu transaksi tulis hasil validasi — daftar penjaga basi?");
    assert.match(firsts[0], VALIDASI_LOCK, `transaksi dimulai dengan: ${firsts[0]}`);
});

test("kunci batch = pernyataan pertama setiap transaksi tulis antrekan()", () => {
    const src = readFileSync(`${ROOT}lib/invoice-outbox-actions.ts`, "utf8");
    const awal = src.indexOf("export async function antrekan(");
    const firsts = firstStatements(src.slice(awal, src.indexOf("\nexport ", awal + 1)));
    assert.equal(firsts.length, 2, "jalur terposting + jalur biasa — daftar penjaga basi?");
    firsts.forEach((first, i) => assert.match(first, ANTRE_LOCK, `transaksi #${i + 1} dimulai dengan: ${first}`));
});

test("route queue membawa versi batch (validated_at) ke antrekan — payload basi ditolak di bawah kunci", () => {
    const src = readFileSync(`${ROOT}app/api/principal-order/queue/route.ts`, "utf8");
    assert.match(src, /batchId: id, batchVersi: batch\.validatedAt,/);
});
