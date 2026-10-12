import { test } from "node:test";
import assert from "node:assert/strict";
import { alasanTutupPeriode, canPerformOffAction, getOffAccessibleTabs, normalizeOffRole, type OffAction } from "./access";

const izin = (...a: string[]) => new Set(a.map((x) => `off_program_control.${x}`));

test("Tutup periode: OM dikunci, Klaim boleh, preset lama tanpa izin granular diputuskan server", () => {
    assert.ok(alasanTutupPeriode(izin("view", "om_approve", "om_cancel")));
    assert.equal(alasanTutupPeriode(izin("view", "claim_review", "period_close")), undefined);
    assert.equal(alasanTutupPeriode(izin("view", "create", "update", "approve", "export")), undefined);
});

const SEMUA_AKSI: OffAction[] = ["create_batch", "edit_returned_batch", "submit_batch", "sm_approve", "sm_return", "claim_review", "claim_final",
    "om_approve", "om_cancel", "finance_payment", "submit_refund", "audit_read", "audit_export", "audit_correct", "period_close", "period_unlock",
    "discount_view", "discount_manage"];

test("AM-026 (D-01 §C): manager bukan admin — peran sendiri, 7 tab, hanya audit_read + audit_export; admin tidak berubah", () => {
    assert.equal(normalizeOffRole("manager"), "manager");
    assert.equal(normalizeOffRole(" Manager "), "manager");
    assert.equal(normalizeOffRole("admin"), "admin");
    assert.deepEqual(getOffAccessibleTabs("manager"), ["overview", "supervisor", "sales", "claim", "om", "finance", "audit"]);
    assert.deepEqual(getOffAccessibleTabs("manager"), getOffAccessibleTabs("admin"));
    assert.deepEqual(SEMUA_AKSI.filter((a) => canPerformOffAction("manager", a)), ["audit_read", "audit_export"]);
    assert.deepEqual(SEMUA_AKSI.filter((a) => canPerformOffAction("admin", a)), SEMUA_AKSI);
    assert.equal(canPerformOffAction("manager", "discount_view"), false, "PK-6: tanpa discount_view");
});
