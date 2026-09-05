/**
 * Tujuan: Mengekstrak risk block eksplisit dari SYSTEM_MAP.md dan menyinkronkannya ke GitHub Issues secara idempoten serta konservatif.
 * Caller: .github/workflows/system-map-issues.yml, operator dry-run lokal, dan tests/guardian/system-map-issues.test.mjs.
 * Dependensi: Node.js standard library dan GitHub REST API saat --apply.
 * Main Functions: extractRisks, validate managed fingerprints/labels, planIssueSync, fetchManagedIssues, applyIssuePlan.
 * Side Effects: --fetch hanya membaca GitHub; --apply dapat create/update/reopen issue tetapi tidak pernah auto-close.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const REQUIRED_FIELDS = Object.freeze([
  "id", "title", "priority", "category", "affected-area", "business-impact",
  "technical-impact", "acceptance-criteria", "suggested-tests",
]);
const MANAGED_START = "<!-- accapi-managed:start -->";
const MANAGED_END = "<!-- accapi-managed:end -->";
const MANAGED_LABEL = "accapi-guardian";

function assertRisk(risk) {
  const missing = REQUIRED_FIELDS.filter((field) => !risk[field]);
  if (missing.length) throw new Error(`Risk block is missing fields: ${missing.join(", ")}`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(risk.id)) throw new Error(`Invalid stable risk id: ${risk.id}`);
  if (!/^P[0-3]$/.test(risk.priority)) throw new Error(`Invalid priority for ${risk.id}: ${risk.priority}`);
}

export function extractRisks(markdown, source = "SYSTEM_MAP.md") {
  const risks = [];
  const matcher = /<!--\s*accapi-risk\s*\r?\n([\s\S]*?)-->/g;
  for (const match of markdown.matchAll(matcher)) {
    const risk = { source };
    for (const rawLine of match[1].split(/\r?\n/)) {
      const separator = rawLine.indexOf(":");
      if (separator < 1) continue;
      const key = rawLine.slice(0, separator).trim().toLowerCase();
      const value = rawLine.slice(separator + 1).trim();
      if (key) risk[key] = value;
    }
    assertRisk(risk);
    risks.push(risk);
  }
  const ids = new Set();
  for (const risk of risks) {
    if (ids.has(risk.id)) throw new Error(`Duplicate risk id in source: ${risk.id}`);
    ids.add(risk.id);
  }
  return risks.sort((left, right) => left.id.localeCompare(right.id));
}

export function fingerprintFromBody(body = "") {
  const matches = [...String(body).matchAll(/<!--\s*accapi-risk-id:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*-->/g)];
  if (matches.length > 1) throw new Error("Issue body contains multiple AccAPI risk fingerprints.");
  return matches[0]?.[1] || null;
}

function labelNames(issue) {
  return (issue.labels || []).map((label) => typeof label === "string" ? label : label?.name).filter(Boolean);
}

function desiredLabels(risk, issue = {}) {
  const retained = labelNames(issue).filter((label) => label !== MANAGED_LABEL && !/^risk:P[0-3]$/i.test(label));
  return [...new Set([...retained, MANAGED_LABEL, `risk:${risk.priority}`])].sort();
}

function assertManagedEnvelope(issue, id) {
  const body = String(issue.body || "");
  const startCount = body.split(MANAGED_START).length - 1;
  const endCount = body.split(MANAGED_END).length - 1;
  if (id && (startCount !== 1 || endCount !== 1 || body.indexOf(MANAGED_END) < body.indexOf(MANAGED_START))) {
    throw new Error(`Managed issue #${issue.number} has an invalid managed block for risk id: ${id}`);
  }
  if (!id && labelNames(issue).includes(MANAGED_LABEL)) {
    throw new Error(`Managed issue #${issue.number} is missing its AccAPI risk fingerprint.`);
  }
}

function managedBody(risk, state = "ACTIVE") {
  return `${MANAGED_START}\n<!-- accapi-risk-id: ${risk.id} -->\nPriority: ${risk.priority}\nCategory: ${risk.category}\nAffected area: ${risk["affected-area"]}\nSource: ${risk.source}\nSource state: ${state}\n\n## Business impact\n${risk["business-impact"]}\n\n## Technical impact\n${risk["technical-impact"]}\n\n## Acceptance criteria\n${risk["acceptance-criteria"]}\n\n## Suggested tests\n${risk["suggested-tests"]}\n${MANAGED_END}`;
}

function replaceManagedBlock(existingBody, replacement) {
  const body = String(existingBody || "");
  const start = body.indexOf(MANAGED_START);
  const end = body.indexOf(MANAGED_END);
  if (start >= 0 && end > start) return `${body.slice(0, start)}${replacement}${body.slice(end + MANAGED_END.length)}`.trim();
  return body.trim() ? `${replacement}\n\n${body.trim()}` : replacement;
}

function staleBody(existingBody) {
  const body = String(existingBody || "");
  if (/^Source state: SOURCE NO LONGER DETECTED — VERIFICATION REQUIRED$/m.test(body)) return body;
  if (/^Source state: .*$/m.test(body)) return body.replace(/^Source state: .*$/m, "Source state: SOURCE NO LONGER DETECTED — VERIFICATION REQUIRED");
  return `${body}\n\nSource state: SOURCE NO LONGER DETECTED — VERIFICATION REQUIRED`.trim();
}

export function planIssueSync(risks, issues, { maxCreates = 5, maxMutations = 25 } = {}) {
  const byId = new Map();
  for (const issue of issues.filter((candidate) => !candidate.pull_request)) {
    const id = fingerprintFromBody(issue.body);
    assertManagedEnvelope(issue, id);
    if (!id) continue;
    if (byId.has(id)) throw new Error(`Duplicate existing GitHub issues for risk id: ${id}`);
    byId.set(id, issue);
  }

  const actions = [];
  const activeIds = new Set();
  for (const risk of risks) {
    activeIds.add(risk.id);
    const issue = byId.get(risk.id);
    if (!issue) {
      actions.push({ action: "CREATE", riskId: risk.id, title: `[${risk.priority}] ${risk.title}`, body: managedBody(risk), labels: desiredLabels(risk), mutate: true });
      continue;
    }
    const title = `[${risk.priority}] ${risk.title}`;
    const body = replaceManagedBlock(issue.body, managedBody(risk));
    const labels = desiredLabels(risk, issue);
    const labelsChanged = JSON.stringify(labelNames(issue).sort()) !== JSON.stringify(labels);
    if (issue.state === "closed") {
      actions.push({ action: "REOPEN", riskId: risk.id, issueNumber: issue.number, title, body, labels, mutate: true, note: "Proposal only unless an operator enables allow_reopen." });
    } else if (issue.title !== title || issue.body !== body || labelsChanged) {
      actions.push({ action: "UPDATE", riskId: risk.id, issueNumber: issue.number, title, body, labels, mutate: true });
    } else {
      actions.push({ action: "SKIP", riskId: risk.id, issueNumber: issue.number, mutate: false });
    }
  }

  for (const [riskId, issue] of byId) {
    if (activeIds.has(riskId)) continue;
    const body = staleBody(issue.body);
    actions.push({
      action: "STALE",
      riskId,
      issueNumber: issue.number,
      body,
      mutate: issue.state === "open" && body !== issue.body,
      note: "Source removed; verification required. Issue will not be closed automatically.",
    });
  }

  actions.sort((left, right) => left.riskId.localeCompare(right.riskId));
  const createCount = actions.filter(({ action }) => action === "CREATE").length;
  const mutationCount = actions.filter(({ mutate }) => mutate).length;
  const createLimitExceeded = createCount > maxCreates;
  const mutationLimitExceeded = mutationCount > maxMutations;
  return {
    actions,
    createCount,
    mutationCount,
    blocked: createLimitExceeded || mutationLimitExceeded,
    reason: createLimitExceeded
      ? `Safety limit exceeded: ${createCount} creates requested, maximum is ${maxCreates}.`
      : mutationLimitExceeded
        ? `Safety limit exceeded: ${mutationCount} total mutations requested, maximum is ${maxMutations}.`
        : null,
  };
}

export function renderSyncPlan(plan) {
  const lines = ["# ACCAPI SYSTEM_MAP ISSUE SYNC", "", `Status: ${plan.blocked ? "BLOCKED" : "READY"}`, `New issues: ${plan.createCount}`, `Total mutations: ${plan.mutationCount}`];
  if (plan.reason) lines.push(`Reason: ${plan.reason}`);
  lines.push("", "## Actions", "");
  if (!plan.actions.length) lines.push("- SKIP — no explicit risk blocks detected and no managed issues supplied.");
  else for (const item of plan.actions) lines.push(`- ${item.action} — ${item.riskId}${item.issueNumber ? ` (#${item.issueNumber})` : ""}${item.note ? ` — ${item.note}` : ""}`);
  lines.push("", "No issue is automatically closed.", "");
  return lines.join("\n");
}

function githubHeaders(token) {
  return { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "accapi-guardian", "X-GitHub-Api-Version": "2022-11-28" };
}

async function githubRequest(url, token, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...githubHeaders(token), ...options.headers } });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${options.method || "GET"} ${new URL(url).pathname}; request-id=${response.headers.get("x-github-request-id") || "unknown"}`);
  return response.status === 204 ? null : response.json();
}

export async function fetchManagedIssues(repository, token, { maxPages = 10 } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY must be owner/name.");
  const issues = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await githubRequest(`https://api.github.com/repos/${repository}/issues?state=all&per_page=100&page=${page}`, token);
    issues.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < 100) return issues.filter((issue) => fingerprintFromBody(issue.body) || labelNames(issue).includes(MANAGED_LABEL));
  }
  throw new Error(`Managed issue scan exceeded ${maxPages * 100} records; refusing incomplete deduplication.`);
}

export async function applyIssuePlan(plan, { repository, token, allowReopen = false }) {
  if (plan.blocked) throw new Error(plan.reason);
  for (const item of plan.actions) {
    if (!item.mutate || item.action === "SKIP") continue;
    if (item.action === "CREATE") {
      await githubRequest(`https://api.github.com/repos/${repository}/issues`, token, { method: "POST", body: JSON.stringify({ title: item.title, body: item.body, labels: item.labels }) });
    } else if (item.action === "UPDATE") {
      await githubRequest(`https://api.github.com/repos/${repository}/issues/${item.issueNumber}`, token, { method: "PATCH", body: JSON.stringify({ title: item.title, body: item.body, labels: item.labels }) });
    } else if (item.action === "REOPEN" && allowReopen) {
      await githubRequest(`https://api.github.com/repos/${repository}/issues/${item.issueNumber}`, token, { method: "PATCH", body: JSON.stringify({ title: item.title, body: item.body, labels: item.labels, state: "open" }) });
    } else if (item.action === "STALE") {
      await githubRequest(`https://api.github.com/repos/${repository}/issues/${item.issueNumber}`, token, { method: "PATCH", body: JSON.stringify({ body: item.body }) });
    }
  }
}

function parseArgs(argv) {
  const options = { apply: false, fetch: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") options.apply = true;
    else if (value === "--fetch") options.fetch = true;
    else if (value.startsWith("--")) options[value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++index];
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourcePath = resolve(options.source || "SYSTEM_MAP.md");
  const risks = extractRisks(readFileSync(sourcePath, "utf8"), options.source || "SYSTEM_MAP.md");
  const repository = options.repository || process.env.GITHUB_REPOSITORY;
  const token = process.env.GUARDIAN_GITHUB_TOKEN;
  let issues = options.issuesFile ? JSON.parse(readFileSync(resolve(options.issuesFile), "utf8")) : [];
  if (options.apply || options.fetch) {
    if (!repository || !token) throw new Error("--fetch/--apply requires GITHUB_REPOSITORY and GUARDIAN_GITHUB_TOKEN.");
    issues = await fetchManagedIssues(repository, token);
  }
  const limits = {
    maxCreates: Number(options.maxCreates || process.env.GUARDIAN_MAX_CREATES || 5),
    maxMutations: Number(options.maxMutations || process.env.GUARDIAN_MAX_MUTATIONS || 25),
  };
  let plan = planIssueSync(risks, issues, limits);
  if (options.apply && !plan.blocked) {
    // Re-read once immediately before mutation; workflow concurrency handles normal races.
    issues = await fetchManagedIssues(repository, token);
    plan = planIssueSync(risks, issues, limits);
    await applyIssuePlan(plan, { repository, token, allowReopen: String(process.env.GUARDIAN_ALLOW_REOPEN).toLowerCase() === "true" });
  }
  const report = renderSyncPlan(plan);
  if (options.reportFile) writeFileSync(resolve(options.reportFile), report, "utf8");
  process.stdout.write(`${report}\n`);
  if (plan.blocked) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { MANAGED_END, MANAGED_LABEL, MANAGED_START };
