/**
 * Tujuan: Mengklasifikasikan diff PR AccAPI, memilih validasi relevan, menjalankannya tanpa shell, dan membuat laporan gate deterministik.
 * Caller: .github/workflows/pr-guardian.yml dan tests/guardian/pr-guardian.test.mjs.
 * Dependensi: Node.js standard library, git, entrypoint JavaScript dependency terpasang, dan test repository yang sudah ada.
 * Main Functions: changedFilesFromGit, classifyChanges, selectChecks, evaluateGuardian, renderGuardianReport.
 * Side Effects: Membaca git diff; mode --execute menjalankan lint/typecheck/test dan menulis report bila diminta.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|sql|css|scss|json|ya?ml)$/i;

function normalizePath(file) {
  return String(file).replaceAll("\\", "/").replace(/^\.\//, "");
}

function matches(file, patterns) {
  return patterns.some((pattern) => pattern.test(file));
}

export function changedFilesFromGit(repo, base, head) {
  if (!/^[0-9a-f]{40}$/i.test(base) || !/^[0-9a-f]{40}$/i.test(head)) {
    throw new Error("Base and head must be full Git commit SHAs.");
  }
  const raw = execFileSync(
    "git",
    ["diff", "--name-status", "-z", "--find-renames", `${base}...${head}`],
    { cwd: repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return parseNameStatus(raw);
}

export function parseNameStatus(raw) {
  const fields = String(raw).split("\0");
  const files = [];
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++];
    if (!status) break;
    if (/^[RC]/.test(status)) {
      const previousPath = fields[index++];
      const nextPath = fields[index++];
      if (previousPath) files.push({ status: `${status}:source`, path: normalizePath(previousPath) });
      if (nextPath) files.push({ status: `${status}:destination`, path: normalizePath(nextPath) });
    } else {
      const file = fields[index++];
      if (file) files.push({ status, path: normalizePath(file) });
    }
  }
  return files;
}

export function classifyChanges(inputFiles) {
  if (!Array.isArray(inputFiles)) throw new Error("Changed files input must be a JSON array.");
  const files = inputFiles.flat(Infinity).map((entry) => {
    const value = typeof entry === "string" ? entry : entry?.path;
    if (typeof value !== "string" || !value) throw new Error("Each changed file must be a path string or an object with a path string.");
    return normalizePath(value);
  });
  const domains = new Set();

  for (const file of files) {
    if (matches(file, [/^(?:docs\/|SYSTEM_MAP\.md$|AGENTS\.md$|CLAUDE\.md$)/i, /\.md$/i])) domains.add("documentation");
    if (matches(file, [/^(?:tests?|scripts\/.*\.test|lib\/.*\.(?:test|spec))\b/i, /\.(?:test|spec)\.[cm]?[jt]sx?$/i])) domains.add("tests");
    if (matches(file, [/^app\/(?:\(dashboard\)|\(auth\)|\(cetak\))\//i, /^components\//i, /\.(?:css|scss)$/i])) domains.add("frontend");
    if (matches(file, [/^python_backend\//i, /^app\/api\//i])) domains.add("backend");
    if (matches(file, [/^db\//i, /^lib\/db\.[jt]s$/i, /^drizzle\.config\.[jt]s$/i, /\.sql$/i])) domains.add("database");
    if (matches(file, [/^db\/migrations\//i, /^scripts\/(?:init-db|migrat(?:e|ion))/i, /^scripts\/apply-.*migration/i])) domains.add("migration");
    if (matches(file, [/(^|\/)(?:auth|authentication)(?:\/|\.|-)/i, /^lib\/rbac(?:\/|\.)/i, /(^|\/)rbac(?:\/|\.|-)/i, /^app\/api\/admin\/(?:groups|users)/i])) {
      domains.add("auth");
      domains.add("RBAC");
    }
    if (matches(file, [/(^|\/)(?:finance|financial)(?:\/|\.|-)/i, /claim-workflow\/.*(?:calculation|payment|close)/i, /off-program-control\/.*(?:calculation|reconciliation|payment)/i, /^lib\/.*(?:-calc|calculation|financial-math)\.[cm]?[jt]s$/i, /off-finance/i])) domains.add("finance");
    if (matches(file, [/(^|\/)(?:payments?|sales-receipt)(?:\/|\.|-)/i, /idempotency/i])) domains.add("payments");
    if (matches(file, [/(^|\/)insentif(?:\/|\.|-)/i, /incentive/i])) domains.add("incentives");
    if (matches(file, [/sales-history/i, /sales_history/i, /ext-sync/i])) domains.add("sales-history");
    if (matches(file, [/accurate/i, /^lib\/sync\.[jt]s$/i, /^app\/api\/(?:proxy|cron\/sync-accurate)/i])) domains.add("Accurate integration");
    if (matches(file, [/(^|\/)(?:report|export|laporan)(?:\/|\.|-)/i, /^dashboard-generator\//i])) domains.add("reporting/export");
    if (matches(file, [/^\.github\//i, /^scripts\/guardian\//i, /^Dockerfile/i, /^docker-compose/i, /^\.env(?:\.|$)/i, /^package(?:-lock)?\.json$/i, /^(?:next|playwright|tsconfig)\.config/i])) domains.add("infrastructure");
  }

  const sensitiveCritical = ["finance", "payments", "incentives", "database", "migration"];
  const sensitiveHigh = ["auth", "RBAC", "sales-history", "Accurate integration", "infrastructure"];
  let risk = "MEDIUM";
  if (files.length === 0) risk = "CRITICAL";
  else if (sensitiveCritical.some((domain) => domains.has(domain))) risk = "CRITICAL";
  else if (sensitiveHigh.some((domain) => domains.has(domain))) risk = "HIGH";
  else {
    const docsOnly = files.every((file) => matches(file, [/^(?:docs\/|SYSTEM_MAP\.md$|AGENTS\.md$|CLAUDE\.md$)/i, /\.md$/i]));
    const uiOnly = files.every((file) => matches(file, [/^app\/(?:\(dashboard\)|\(auth\)|\(cetak\))\/.*\.tsx?$/i, /^components\/.*\.tsx?$/i, /\.(?:css|scss)$/i]));
    const testsOnly = files.every((file) => matches(file, [/^(?:tests?\/|scripts\/.*\.test|lib\/.*\.(?:test|spec))/i, /\.(?:test|spec)\.[cm]?[jt]sx?$/i]));
    if (docsOnly || uiOnly || testsOnly) risk = "LOW";
  }

  if (files.some((file) => SOURCE_EXTENSIONS.test(file)) && domains.size === 0) domains.add("application");
  return { files, domains: [...domains].sort(), risk };
}

const CHECKS = Object.freeze({
  lint: { id: "lint", command: "node", args: ["node_modules/eslint/bin/eslint.js", ".", "--quiet"], required: true, reason: "Static lint using the installed JS entrypoint, independent of PR-controlled package scripts and shell shims." },
  typecheck: { id: "typecheck", command: "node", args: ["node_modules/typescript/bin/tsc", "--noEmit"], required: true, reason: "TypeScript compile contract through the installed JS entrypoint." },
  reconciliation: { id: "finance-reconciliation", command: "node", args: ["node_modules/tsx/dist/cli.mjs", "--test"], required: true, reason: "Existing finance/reconciliation calculation and integrity checks, discovered without a shell glob." },
  salesHistory: { id: "sales-history-cursor", command: "node", args: ["node_modules/@playwright/test/cli.js", "test", "tests/ext-cursor.spec.ts"], required: true, reason: "Existing keyset/idempotency regression." },
  accurateWebhook: { id: "accurate-contract", command: "node", args: ["node_modules/@playwright/test/cli.js", "test", "tests/webhook-payload-parse.spec.ts"], required: true, reason: "Existing Accurate webhook contract regression." },
  guardianSelf: { id: "guardian-self-test", command: "node", args: ["--test"], required: true, reason: "Guardian classifier, report, lifecycle, and workflow-security regressions." },
});

export function selectChecks(classification) {
  const domains = new Set(classification.domains);
  const checks = [];
  const warnings = [];
  const codeChange = classification.files.some((file) => SOURCE_EXTENSIONS.test(file) && !/\.md$/i.test(file));
  if (codeChange) checks.push(CHECKS.lint, CHECKS.typecheck);
  if (domains.has("finance") || domains.has("incentives")) checks.push(CHECKS.reconciliation);
  if (domains.has("sales-history")) checks.push(CHECKS.salesHistory);
  if (domains.has("Accurate integration")) checks.push(CHECKS.accurateWebhook);
  if (domains.has("infrastructure") && classification.files.some((file) => /^\.?github\/workflows\/|^scripts\/guardian\/|^tests\/guardian\//i.test(file))) checks.push(CHECKS.guardianSelf);
  if (domains.has("auth") || domains.has("RBAC")) warnings.push("Auth/RBAC browser authorization checks need a configured PostgreSQL-backed test server; deterministic static checks are not sufficient.");
  if (domains.has("payments")) warnings.push("The existing payment import regression mutates local test data and needs an isolated full-stack environment; it is not silently treated as executed.");
  if (domains.has("database") || domains.has("migration")) warnings.push("No disposable PostgreSQL migration round-trip is configured in this workflow; schema/data compatibility requires human review.");
  return { checks: [...new Map(checks.map((check) => [check.id, check])).values()], warnings };
}

export function runChecks(checks, repo, runner = spawnSync) {
  return checks.map((check) => {
    const command = check.command === "node" ? process.execPath : check.command;
    const args = check.id === "finance-reconciliation"
      ? [...check.args, ...readdirSync(resolve(repo, "lib/off-program-control"), { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts")).map((entry) => `lib/off-program-control/${entry.name}`).sort()]
      : check.id === "guardian-self-test"
        ? [...check.args, ...readdirSync(resolve(repo, "tests/guardian"), { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs")).map((entry) => `tests/guardian/${entry.name}`).sort()]
      : check.args;
    const result = runner(command, args, { cwd: repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (output) process.stdout.write(`\n[${check.id}]\n${output}\n`);
    return { ...check, status: result.error || result.status !== 0 ? "FAILED" : "PASSED", exitCode: result.status ?? 1 };
  });
}

export function securitySignals(classification) {
  const domains = new Set(classification.domains);
  const signals = [];
  if (domains.has("auth") || domains.has("RBAC")) signals.push("Authorization boundary changed.");
  if (domains.has("infrastructure")) signals.push("CI/deployment or dependency trust boundary changed.");
  if (domains.has("Accurate integration")) signals.push("External API authentication or synchronization path changed.");
  return signals;
}

export function dataIntegritySignals(classification) {
  const domains = new Set(classification.domains);
  const signals = [];
  if (domains.has("database") || domains.has("migration")) signals.push("Database schema or migration compatibility changed.");
  if (domains.has("finance") || domains.has("payments") || domains.has("incentives")) signals.push("Finance-sensitive calculation or payment path changed.");
  if (domains.has("sales-history")) signals.push("Published/unpublished or incremental feed correctness may change.");
  return signals;
}

export function evaluateGuardian(classification, selection, results, executed) {
  const failed = results.some((result) => result.required && result.status === "FAILED");
  const executedIds = new Set(results.map((result) => result.id));
  const skippedRequired = selection.checks.some((check) => check.required && !executedIds.has(check.id));
  if (classification.files.length === 0 || failed || (executed && skippedRequired)) return "BLOCKED";
  if (["HIGH", "CRITICAL"].includes(classification.risk)) return "HUMAN REVIEW REQUIRED";
  if (!executed && selection.checks.length > 0) return "HUMAN REVIEW REQUIRED";
  if (selection.warnings.length > 0) return "PASS WITH WARNINGS";
  return classification.risk === "LOW" ? "PASS" : "PASS WITH WARNINGS";
}

export function renderGuardianReport({ classification, selection, results = [], executed = false }) {
  const verdict = evaluateGuardian(classification, selection, results, executed);
  const resultById = new Map(results.map((result) => [result.id, result]));
  const checksExecuted = results.length ? results.map((result) => `- ${result.id}: ${result.status} (exit ${result.exitCode})`) : ["- None"];
  const checksSkipped = selection.checks.filter((check) => !resultById.has(check.id)).map((check) => `- ${check.id}: NOT EXECUTED${check.required ? " (required)" : ""}`);
  if (!checksSkipped.length) checksSkipped.push("- None");
  const warnings = [...selection.warnings, "AI semantic review unavailable: no verified provider is configured; deterministic results remain explicit."];
  if (!executed && selection.checks.length) warnings.push("This is a plan/simulation report; selected checks were not executed.");
  const section = (items) => items.length ? items.map((item) => `- ${item}`).join("\n") : "- None";
  return `# ACCAPI PR GUARDIAN\n\n## Risk Level\n\n${classification.risk}\n\n## Domains Changed\n\n${section(classification.domains)}\n\n## Checks Executed\n\n${checksExecuted.join("\n")}\n\n## Checks Skipped\n\n${checksSkipped.join("\n")}\n\n## Security Review Signals\n\n${section(securitySignals(classification))}\n\n## Data Integrity Signals\n\n${section(dataIntegritySignals(classification))}\n\n## Warnings\n\n${section(warnings)}\n\n## Merge Verdict\n\n${verdict}\n`;
}

function parseArgs(argv) {
  const options = { execute: false, enforceHumanReview: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--execute") options.execute = true;
    else if (value === "--enforce-human-review") options.enforceHumanReview = true;
    else if (value === "--files-stdin") options.filesStdin = true;
    else if (value.startsWith("--")) options[value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++index];
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const repo = resolve(options.repo || ".");
  const changed = options.filesStdin
    ? JSON.parse(readFileSync(0, "utf8"))
    : changedFilesFromGit(repo, options.base, options.head);
  const classification = classifyChanges(changed);
  const selection = selectChecks(classification);
  const results = options.execute ? runChecks(selection.checks, repo) : [];
  const report = renderGuardianReport({ classification, selection, results, executed: options.execute });
  if (options.reportFile) writeFileSync(resolve(options.reportFile), report, "utf8");
  process.stdout.write(`${report}\n`);
  const verdict = evaluateGuardian(classification, selection, results, options.execute);
  if (verdict === "BLOCKED") process.exitCode = 1;
  else if (options.enforceHumanReview && verdict === "HUMAN REVIEW REQUIRED") process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
