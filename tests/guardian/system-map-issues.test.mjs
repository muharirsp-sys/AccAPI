/**
 * Tujuan: Membuktikan extraction, stable fingerprint, idempotensi, lifecycle konservatif, dan spam guard issue sync.
 * Caller: node --test tests/guardian/*.test.mjs.
 * Dependensi: node:test, node:assert, scripts/guardian/system-map-issues.mjs.
 * Main Functions: Skenario CREATE stabilization, SKIP, UPDATE, REOPEN, STALE, duplicate fingerprint, dan spam guard.
 * Side Effects: Tidak ada; GitHub API tidak dipanggil.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { extractRisks, MANAGED_LABEL, planIssueSync, stabilizeCreatePlan } from "../../scripts/guardian/system-map-issues.mjs";

function source({ title = "Runtime database mismatch", impact = "Routes can fail." } = {}) {
  return `# Map\n<!-- accapi-risk\nid: deploy-database-runtime-mismatch\ntitle: ${title}\npriority: P1\ncategory: deployment\naffected-area: Docker frontend runtime\nbusiness-impact: ${impact}\ntechnical-impact: SQLite fallback conflicts with PostgreSQL-only code.\nacceptance-criteria: Production runtime proves a PostgreSQL DATABASE_URL.\nsuggested-tests: Container startup and authenticated DB route smoke test.\n-->`;
}

function issueFrom(action, overrides = {}) {
  return { number: 7, state: "open", title: action.title, body: action.body, labels: (action.labels || []).map((name) => ({ name })), ...overrides };
}

test("CASE 5: one new actionable risk produces one CREATE", () => {
  const plan = planIssueSync(extractRisks(source()), []);
  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.actions.map(({ action }) => action), ["CREATE"]);
  assert.deepEqual(plan.actions[0].labels, [MANAGED_LABEL, "risk:P1"]);
});

test("CASE 6: repeated identical sync is SKIP with zero duplicate creates", () => {
  const risks = extractRisks(source());
  const first = planIssueSync(risks, []);
  const second = planIssueSync(risks, [issueFrom(first.actions[0])]);
  assert.equal(second.createCount, 0);
  assert.deepEqual(second.actions.map(({ action }) => action), ["SKIP"]);
});

test("CASE 7: matching closed issue is a REOPEN proposal", () => {
  const risks = extractRisks(source());
  const first = planIssueSync(risks, []);
  const plan = planIssueSync(risks, [issueFrom(first.actions[0], { state: "closed" })]);
  assert.equal(plan.actions[0].action, "REOPEN");
});

test("CASE 8: wording change retains identity and updates existing issue", () => {
  const initial = planIssueSync(extractRisks(source()), []);
  const existing = issueFrom(initial.actions[0]);
  existing.body += "\n\nHuman note is preserved.";
  const plan = planIssueSync(extractRisks(source({ title: "Runtime DB configuration mismatch", impact: "Finance routes may fail." })), [existing]);
  assert.equal(plan.actions[0].action, "UPDATE");
  assert.match(plan.actions[0].body, /Human note is preserved/);
  assert.match(plan.actions[0].body, /accapi-risk-id: deploy-database-runtime-mismatch/);
});

test("removed source becomes STALE and is never auto-closed", () => {
  const first = planIssueSync(extractRisks(source()), []);
  const plan = planIssueSync([], [issueFrom(first.actions[0])]);
  assert.equal(plan.actions[0].action, "STALE");
  assert.equal(plan.actions[0].mutate, true);
  assert.match(plan.actions[0].body, /VERIFICATION REQUIRED/);
  assert.doesNotMatch(plan.actions[0].body, /state: closed/);
});

test("CASE 10: excessive creates block the entire plan", () => {
  const block = (id) => source().replaceAll("deploy-database-runtime-mismatch", id);
  const risks = extractRisks([block("risk-one"), block("risk-two"), block("risk-three")].join("\n"));
  const plan = planIssueSync(risks, [], { maxCreates: 2 });
  assert.equal(plan.blocked, true);
  assert.equal(plan.createCount, 3);
});

test("duplicate source and duplicate existing fingerprints fail closed", () => {
  assert.throws(() => extractRisks(`${source()}\n${source()}`), /Duplicate risk id/);
  const first = planIssueSync(extractRisks(source()), []);
  const duplicate = issueFrom(first.actions[0]);
  assert.throws(() => planIssueSync(extractRisks(source()), [duplicate, { ...duplicate, number: 8 }]), /Duplicate existing/);
});

test("excessive updates or stale mutations are blocked even when create count is zero", () => {
  const initial = planIssueSync(extractRisks(source()), []);
  const issues = [1, 2, 3].map((number) => issueFrom(initial.actions[0], {
    number,
    body: initial.actions[0].body.replace("deploy-database-runtime-mismatch", `old-risk-${number}`),
  }));
  const plan = planIssueSync([], issues, { maxCreates: 5, maxMutations: 2 });
  assert.equal(plan.createCount, 0);
  assert.equal(plan.mutationCount, 3);
  assert.equal(plan.blocked, true);
});

test("managed label without fingerprint and damaged managed markers fail closed", () => {
  assert.throws(
    () => planIssueSync(extractRisks(source()), [{ number: 9, state: "open", title: "edited", body: "fingerprint removed", labels: [{ name: MANAGED_LABEL }] }]),
    /missing its AccAPI risk fingerprint/,
  );
  const first = planIssueSync(extractRisks(source()), []);
  const damaged = issueFrom(first.actions[0], { body: first.actions[0].body.replace("<!-- accapi-managed:end -->", "") });
  assert.throws(() => planIssueSync(extractRisks(source()), [damaged]), /invalid managed block/);
});

test("priority label changes without deleting unrelated human labels", () => {
  const initial = planIssueSync(extractRisks(source()), []);
  const existing = issueFrom(initial.actions[0], { labels: [{ name: MANAGED_LABEL }, { name: "risk:P2" }, { name: "operations" }] });
  const update = planIssueSync(extractRisks(source()), [existing]).actions[0];
  assert.equal(update.action, "UPDATE");
  assert.deepEqual(update.labels, [MANAGED_LABEL, "operations", "risk:P1"]);
});

test("CREATE waits through partial GitHub visibility and becomes SKIP before mutating", async () => {
  const risks = extractRisks(source());
  const initial = planIssueSync(risks, []);
  const primary = issueFrom(initial.actions[0]);
  const snapshots = [[], [primary], [primary], [primary]];
  const stabilized = await stabilizeCreatePlan(
    risks,
    initial,
    async () => snapshots.shift() || [primary],
    {},
    { stableReads: 3, maxReads: 5, delay: async () => {} },
  );
  assert.equal(stabilized.createCount, 0);
  assert.deepEqual(stabilized.actions.map(({ action }) => action), ["SKIP"]);
});
