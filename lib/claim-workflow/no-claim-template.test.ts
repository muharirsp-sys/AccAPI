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

test("validasi templat", () => {
  assert.equal(validateNoClaimTemplate({ principleCode: "urc", pattern: "{seq}/A/{month}/{year2}" }).ok, true);
  assert.equal(validateNoClaimTemplate({ principleCode: "URC", pattern: "A/{month}" }).ok, false);
  assert.equal(validateNoClaimTemplate({ principleCode: "URC", pattern: "{seq}/{bulan}" }).ok, false);
  assert.equal(validateNoClaimTemplate({ principleCode: "URC", pattern: "{seq}", padWidth: 9 }).ok, false);
});
