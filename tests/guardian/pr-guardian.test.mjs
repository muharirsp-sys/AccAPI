/**
 * Tujuan: Membuktikan klasifikasi risiko, pemilihan check, dan perlindungan false PASS PR Guardian.
 * Caller: node --test tests/guardian/*.test.mjs.
 * Dependensi: node:test, node:assert, scripts/guardian/pr-guardian.mjs.
 * Main Functions: Skenario UI, RBAC, payment, migration, malicious filename, dan skipped-required check.
 * Side Effects: Tidak ada; seluruh input berupa fixture in-memory.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { classifyChanges, evaluateGuardian, parseNameStatus, renderGuardianReport, selectChecks } from "../../scripts/guardian/pr-guardian.mjs";

test("CASE 1: UI-only change is LOW", () => {
  const result = classifyChanges(["components/InvoiceBadge.tsx", "app/(dashboard)/profile/page.tsx"]);
  assert.equal(result.risk, "LOW");
  assert.deepEqual(result.domains, ["frontend"]);
});

test("CASE 2: RBAC/auth change is HIGH and requires human review", () => {
  const classification = classifyChanges(["lib/rbac/resolve.ts"]);
  const selection = selectChecks(classification);
  assert.equal(classification.risk, "HIGH");
  assert.equal(evaluateGuardian(classification, selection, selection.checks.map((check) => ({ ...check, status: "PASSED", exitCode: 0 })), true), "HUMAN REVIEW REQUIRED");
});

test("CASE 3: payment calculation change is CRITICAL", () => {
  const result = classifyChanges(["lib/claim-workflow/payments/calculation.ts"]);
  assert.equal(result.risk, "CRITICAL");
  assert.ok(result.domains.includes("payments"));
});

test("CASE 4: database migration change is CRITICAL", () => {
  const result = classifyChanges(["db/migrations/0099_drop_old_payments.sql"]);
  assert.equal(result.risk, "CRITICAL");
  assert.ok(result.domains.includes("migration"));
});

test("database adapter, env, and OFF finance calculations cannot bypass sensitive classification", () => {
  assert.equal(classifyChanges(["lib/db.ts"]).risk, "CRITICAL");
  assert.equal(classifyChanges([".env.example"]).risk, "HIGH");
  assert.equal(classifyChanges(["lib/off-program-control/sales-reconciliation.ts"]).risk, "CRITICAL");
});

test("malicious filename remains inert data and cannot lower risk", () => {
  const result = classifyChanges(["components/$(curl attacker).tsx", "db/migrations/x;echo PWNED.sql"]);
  assert.equal(result.risk, "CRITICAL");
  assert.ok(result.files.some((file) => file.includes("$(curl attacker)")));
});

test("required selected checks skipped in execute mode are BLOCKED", () => {
  const classification = classifyChanges(["lib/example.ts"]);
  const selection = selectChecks(classification);
  assert.ok(selection.checks.length > 0);
  assert.equal(evaluateGuardian(classification, selection, [], true), "BLOCKED");
  assert.match(renderGuardianReport({ classification, selection, results: [], executed: true }), /NOT EXECUTED \(required\)/);
});

test("failed required check is BLOCKED", () => {
  const classification = classifyChanges(["lib/example.ts"]);
  const selection = selectChecks(classification);
  const results = selection.checks.map((check, index) => ({ ...check, status: index ? "PASSED" : "FAILED", exitCode: index ? 0 : 1 }));
  assert.equal(evaluateGuardian(classification, selection, results, true), "BLOCKED");
});

test("CLI accepts JSON file list over stdin without shell quoting ambiguity", () => {
  const result = spawnSync(process.execPath, [resolve("scripts/guardian/pr-guardian.mjs"), "--files-stdin"], {
    input: JSON.stringify(["db/migrations/name;echo PWNED.sql"]),
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /CRITICAL/);
  assert.match(result.stdout, /migration/);
});

test("nested PowerShell-style file arrays are flattened instead of producing a false PASS", () => {
  const result = classifyChanges([["SYSTEM_MAP.md", ".github/workflows/deploy.yml"], ["scripts/guardian/pr-guardian.mjs"]]);
  assert.equal(result.risk, "HIGH");
  assert.ok(result.domains.includes("infrastructure"));
});

test("CASE 9: AI unavailable stays explicit while deterministic low-risk result still works", () => {
  const classification = classifyChanges(["docs/operator-guide.md"]);
  const selection = selectChecks(classification);
  const report = renderGuardianReport({ classification, selection, results: [], executed: true });
  assert.match(report, /AI semantic review unavailable/);
  assert.match(report, /## Merge Verdict\n\nPASS/);
});

test("Guardian engine changes are HIGH and select their own required regression", () => {
  const classification = classifyChanges(["scripts/guardian/pr-guardian.mjs"]);
  const selection = selectChecks(classification);
  assert.equal(classification.risk, "HIGH");
  assert.ok(selection.checks.some((check) => check.id === "guardian-self-test" && check.required));
});

test("rename classification includes sensitive source and neutral destination", () => {
  const files = parseNameStatus("R100\0lib/rbac/resolve.ts\0lib/helpers/resolve.ts\0");
  assert.deepEqual(files.map(({ path }) => path), ["lib/rbac/resolve.ts", "lib/helpers/resolve.ts"]);
  assert.equal(classifyChanges(files).risk, "HIGH");
});
