import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_ORDER_REASONS, TOKO_TUTUP_CODE, validateNoOrderReason } from "./constants.ts";

test("not_order wajib kode alasan aktif; status lain bebas", () => {
  const codes = NO_ORDER_REASONS.map((r) => r.reasonCode);
  assert.ok(codes.includes(TOKO_TUTUP_CODE));
  assert.equal(validateNoOrderReason("ordered", null, codes), null);
  assert.equal(validateNoOrderReason("not_order", TOKO_TUTUP_CODE, codes), null);
  assert.match(validateNoOrderReason("not_order", null, codes) ?? "", /wajib/);
  assert.match(validateNoOrderReason("not_order", "R99", codes) ?? "", /tidak dikenal/);
  // kirim ulang baris lama tanpa alasan = lolos; ubah dari priority tanpa alasan = ditolak
  assert.equal(validateNoOrderReason("not_order", null, codes, { status: "not_order", noOrderReasonCode: null }), null);
  assert.match(validateNoOrderReason("not_order", null, codes, { status: "priority", noOrderReasonCode: null }) ?? "", /wajib/);
});
