import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildNoClaimFromRule,
  isNoClaimRuleWithVariants,
  mergeNoClaimTemplates,
  noClaimRuleConfigs,
  validateNoClaimTemplate,
  type NoClaimRule,
} from "./no-claim-rules.ts";

const row = (o: Partial<Parameters<typeof mergeNoClaimTemplates>[0][number]>) => ({
  principleCode: "URC", variantKey: "", label: "URC", pattern: "{seq}/X-RC/{month}/{year4}", padWidth: 3, sequenceType: "number", ...o,
});

test("templat DB menimpa bawaan; tanpa baris = bawaan kode", () => {
  const merged = mergeNoClaimTemplates([row({}), row({ principleCode: "HEINZ", variantKey: "BS", pattern: "{seq}/BS/{year2}" }), row({ principleCode: "BARU" })]);
  const urc = merged.find((c) => c.principleCode === "URC") as NoClaimRule;
  assert.equal(buildNoClaimFromRule(urc, { sequence: "1", month: "10", year: 2026 }), "001/X-RC/10/2026");
  const rb = merged.find((c) => c.principleCode === "RB") as NoClaimRule;
  assert.equal(buildNoClaimFromRule(rb, { sequence: "1", month: "10", year: 2026 }), "01/SP-10/26");
  const heinz = merged.find((c) => c.principleCode === "HEINZ")!;
  assert.ok(isNoClaimRuleWithVariants(heinz));
  assert.deepEqual(heinz.variants.map((v) => v.pattern), ["{seq}/SUPER-HZ/{month}/{year4}", "{seq}/BS/{year2}"]);
  assert.equal(merged.length, noClaimRuleConfigs.length + 1);
});

test("validasi templat: varian sesuai bawaan, field kosong dari bawaan, karakter pola", () => {
  const ok = (i: Record<string, unknown>) => {
    const v = validateNoClaimTemplate(i);
    assert.ok(v.ok, JSON.stringify(v));
    return v.row;
  };
  // field yang tidak dikirim = bawaan
  assert.equal(ok({ principleCode: "urc", pattern: "{seq}/A/{month}/{year2}" }).padWidth, 2);
  assert.equal(ok({ principleCode: "ENI", pattern: "DC/{seq}/{month}/{year4}" }).sequenceType, "text");
  assert.equal(ok({ principleCode: "HEINZ", variantKey: "bs", pattern: "{seq}/BS/{year4}" }).label, "Heinz (BS)");
  assert.equal(ok({ principleCode: "URC", pattern: "{seq}", padWidth: null }).padWidth, null);
  // varian
  assert.equal(validateNoClaimTemplate({ principleCode: "HEINZ", pattern: "{seq}" }).ok, false);
  assert.equal(validateNoClaimTemplate({ principleCode: "URC", variantKey: "X", pattern: "{seq}" }).ok, false);
  assert.equal(validateNoClaimTemplate({ principleCode: "BARU", variantKey: "X", pattern: "{seq}" }).ok, false);
  // pola
  assert.equal(validateNoClaimTemplate({ principleCode: "URC", pattern: "A/{month}" }).ok, false);
  assert.equal(validateNoClaimTemplate({ principleCode: "URC", pattern: "{seq}/{bulan}" }).ok, false);
  assert.equal(validateNoClaimTemplate({ principleCode: "URC", pattern: "{seq}/{ {month}" }).ok, false);
  assert.equal(validateNoClaimTemplate({ principleCode: "URC", pattern: "{seq}<b>" }).ok, false);
  assert.equal(validateNoClaimTemplate({ principleCode: "URC", pattern: "{seq}", padWidth: 9 }).ok, false);
});
