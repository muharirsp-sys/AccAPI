import assert from "node:assert/strict";
import { test } from "node:test";
import { PESAN_CARA_BAYAR, computeOffPaymentSummary, normalizeOffPaymentMethod } from "./payments.ts";

test("cara bayar: Transfer, Tunai, Potong Tagihan dikenali; lainnya ditolak", () => {
  assert.equal(normalizeOffPaymentMethod(" transfer "), "Transfer");
  assert.equal(normalizeOffPaymentMethod("TUNAI"), "Tunai");
  assert.equal(normalizeOffPaymentMethod("potong  tagihan"), "Potong Tagihan");
  assert.throws(() => normalizeOffPaymentMethod("Giro"), { message: PESAN_CARA_BAYAR });
});

test("ringkasan bayar memisahkan Potong Tagihan dan beban distributor (DM)", () => {
  const r = computeOffPaymentSummary([
    { nominal: 100, caraBayar: "Transfer", beban: "CL" },
    { nominal: 50, caraBayar: "Potong Tagihan", beban: "DM" },
    { nominal: 25, caraBayar: "Tunai", beban: null },
  ]);
  assert.deepEqual(r, { total: 175, transfer: 100, tunai: 25, potongTagihan: 50, bebanDistributor: 50 });
});
