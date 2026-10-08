import { test } from "node:test";
import assert from "node:assert/strict";
import { alasanTutupPeriode } from "./access";

const izin = (...a: string[]) => new Set(a.map((x) => `off_program_control.${x}`));

test("Tutup periode: OM dikunci, Klaim boleh, preset lama tanpa izin granular diputuskan server", () => {
    assert.ok(alasanTutupPeriode(izin("view", "om_approve", "om_cancel")));
    assert.equal(alasanTutupPeriode(izin("view", "claim_review", "period_close")), undefined);
    assert.equal(alasanTutupPeriode(izin("view", "create", "update", "approve", "export")), undefined);
});
