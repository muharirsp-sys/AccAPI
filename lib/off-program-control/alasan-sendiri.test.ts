import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAlasanSendiri } from "./helpers.ts";

test("alasan setuju sendiri: wajib untuk pembuat, diabaikan untuk lainnya", () => {
  assert.deepEqual(resolveAlasanSendiri("u1", "u2", "x"), { ok: true, alasanSendiri: null });
  assert.deepEqual(resolveAlasanSendiri(null, "u1", ""), { ok: true, alasanSendiri: null });
  assert.deepEqual(resolveAlasanSendiri("u1", "u1", undefined), { ok: true, alasanSendiri: null, sendiriTanpaAlasan: true });
  assert.equal(resolveAlasanSendiri("u1", "u1", "").ok, false);
  assert.equal(resolveAlasanSendiri("u1", "u1", null).ok, false);
  assert.equal(resolveAlasanSendiri("u1", "u1", "  abcd  ").ok, false);
  assert.deepEqual(resolveAlasanSendiri("u1", "u1", "  SPV cuti  "), { ok: true, alasanSendiri: "SPV cuti" });
});
