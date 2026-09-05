/**
 * Tujuan: Mengunci trigger, permission, credential persistence, dan pemisahan privilege workflow Guardian/deploy.
 * Caller: node --test tests/guardian/*.test.mjs dan required guardian-self-test PR Guardian.
 * Dependensi: node:test, node:assert, file .github/workflows/*.yml.
 * Main Functions: Static regression terhadap pull_request_target, SHA pins, write permission, PR metadata, secrets, concurrency, dan auto-close.
 * Side Effects: Membaca file workflow saja.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(`.github/workflows/${name}`, "utf8");

test("PR Guardian is pull_request read-only and does not consume PR metadata or secrets", () => {
  const workflow = read("pr-guardian.yml");
  assert.match(workflow, /\n  pull_request:\n/);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.match(workflow, /permissions:\n  contents: read\n/);
  assert.doesNotMatch(workflow, /(?:issues|pull-requests|id-token|packages): write/);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\.|pull_request\.(?:title|body)/);
  assert.doesNotMatch(workflow, /actions\/checkout|persist-credentials|github\.token/);
  assert.match(workflow, /refs\/pull\/\$PR_NUMBER\/head/);
  assert.match(workflow, /vars\.GUARDIAN_BOOTSTRAP_SHA/);
  assert.doesNotMatch(workflow, /uses:\s*[^\s]+@v\d/);
  assert.doesNotMatch(workflow, /--enforce-human-review/);
});

test("issue mutation privilege is isolated, serialized, and never includes auto-close input", () => {
  const workflow = read("system-map-issues.yml");
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /group: accapi-system-map-issues/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /pull_request(?:_target)?:/);
  assert.doesNotMatch(workflow, /allow_close|state:\s*closed/);
  assert.doesNotMatch(workflow, /uses:\s*[^\s]+@v\d/);
});

test("deploy has explicit read baseline, serialized cancellation, and no auth secret build arg", () => {
  const workflow = read("deploy.yml");
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /group: deploy-\$\{\{ github\.ref \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /BETTER_AUTH_SECRET/);
  assert.match(workflow, /FRONTEND_IMAGE \}\}:\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /BACKEND_IMAGE \}\}:\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(workflow, /uses:\s*[^\s]+@v\d/);
  assert.doesNotMatch(workflow, /--header "Authorization: Bearer \$\{\{/);
});

test("frontend image has no SQLite runtime default and fails closed without injected PostgreSQL", () => {
  const dockerfile = readFileSync("Dockerfile.frontend", "utf8");
  const runner = dockerfile.slice(dockerfile.indexOf("FROM node:22-slim AS runner"));
  assert.doesNotMatch(runner, /DATABASE_URL=file:/);
  assert.match(runner, /DATABASE_URL must be an injected PostgreSQL URL/);
  assert.match(runner, /postgres:\/\/\*\|postgresql:\/\/\*/);
});
