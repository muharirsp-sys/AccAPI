// Tujuan: Runner lokal aman untuk test API yang butuh Next server.
// Caller: node scripts/run-local-api-debug.mjs
// Side effects: menulis DB copy dan log di runtime/debug-*, tidak menyentuh sqlite.db asli.

import { createClient } from "@libsql/client";
import { hashPassword } from "better-auth/crypto";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.env.DEBUG_PORT || 3000);
const baseUrl = process.env.SEED_BASE_URL || process.env.BASE_URL || `http://localhost:${port}`;
const dbCopyPath = process.env.DEBUG_DATABASE_PATH || "runtime/debug-db/local-api-debug.sqlite";
const dbUrl = `file:${dbCopyPath.replaceAll("\\", "/")}`;
const email = process.env.DEBUG_EMAIL || "admin@admin.com";
const password = process.env.DEBUG_PASSWORD || "Admin#2026";
const logDir = "runtime/debug-reports";
const serverOut = path.join(logDir, "local-api-debug.server.log");
const serverErr = path.join(logDir, "local-api-debug.server.err.log");

let serverProcess = null;

const qaUsers = [
  { email: "qa.admin@local.test", name: "LOCAL QA Admin", role: "admin" },
  { email: "qa.supervisor@local.test", name: "LOCAL QA Supervisor", role: "supervisor" },
  { email: "qa.sm@local.test", name: "LOCAL QA Sales Manager", role: "sm" },
  { email: "qa.claim@local.test", name: "LOCAL QA Claim", role: "claim" },
  { email: "qa.om@local.test", name: "LOCAL QA Operational Manager", role: "om" },
  { email: "qa.finance@local.test", name: "LOCAL QA Finance", role: "finance" },
  { email: "qa.staff@local.test", name: "LOCAL QA Staff", role: "staff" },
];

function ensureRuntime() {
  fs.mkdirSync(path.dirname(dbCopyPath), { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.copyFileSync("sqlite.db", dbCopyPath);
}

async function ensureAdminCredential() {
  const db = createClient({ url: dbUrl });
  const now = Date.now();
  const hash = await hashPassword(password);

  for (const localUser of [
    { email, name: "Local API Debug Admin", role: "admin" },
    ...qaUsers,
  ]) {
    const existing = await db.execute({
      sql: "SELECT id FROM user WHERE email = ?",
      args: [localUser.email],
    });
    let userId = existing.rows[0]?.id;
    if (!userId) {
      userId = randomUUID();
      await db.execute({
        sql: "INSERT INTO user (id, name, email, emailVerified, role, permissions, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        args: [userId, localUser.name, localUser.email, 1, localUser.role, "{}", now, now],
      });
    } else {
      await db.execute({
        sql: "UPDATE user SET name = ?, role = ?, emailVerified = 1, updatedAt = ? WHERE id = ?",
        args: [localUser.name, localUser.role, now, userId],
      });
    }

    const account = await db.execute({
      sql: "SELECT id FROM account WHERE userId = ? AND providerId = 'credential'",
      args: [userId],
    });
    if (account.rows[0]?.id) {
      await db.execute({
        sql: "UPDATE account SET password = ?, updatedAt = ? WHERE id = ?",
        args: [hash, now, account.rows[0].id],
      });
    } else {
      await db.execute({
        sql: "INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [randomUUID(), userId, "credential", userId, hash, now, now],
      });
    }
  }
}

function startServer() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  fs.rmSync(serverOut, { force: true });
  fs.rmSync(serverErr, { force: true });
  serverProcess = spawn(npm, ["run", "dev", "--", "--hostname", "localhost", "--port", String(port)], {
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
      BETTER_AUTH_URL: baseUrl,
      NEXT_PUBLIC_APP_URL: baseUrl,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: [
      "ignore",
      fs.openSync(serverOut, "a"),
      fs.openSync(serverErr, "a"),
    ],
    shell: process.platform === "win32",
    windowsHide: true,
  });
}

async function waitForServer() {
  const deadline = Date.now() + 90000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/off-program-control/principles`);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Next server tidak siap di ${baseUrl}. Last error: ${lastError}`);
}

async function loginCookie() {
  const res = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
    },
    body: JSON.stringify({ email, password }),
  });
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  if (!res.ok || !cookie) {
    throw new Error(`Login debug gagal: HTTP ${res.status} ${await res.text()}`);
  }
  return cookie;
}

function runNodeScript(script, env, args = []) {
  execFileSync(process.execPath, [script, ...args], {
    stdio: "inherit",
    env,
  });
}

function stopServer() {
  if (!serverProcess || serverProcess.killed) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(serverProcess.pid), "/t", "/f"], { stdio: "ignore" });
      return;
    } catch {
      // fall through to kill
    }
  }
  serverProcess.kill("SIGTERM");
}

async function main() {
  ensureRuntime();
  await ensureAdminCredential();
  startServer();
  try {
    await waitForServer();
    const cookie = await loginCookie();
    const env = {
      ...process.env,
      DATABASE_URL: dbUrl,
      SEED_BASE_URL: baseUrl,
      BASE_URL: baseUrl,
      API_COOKIE: cookie,
      STRESS_EMAIL: email,
      STRESS_PASSWORD: password,
    };
    console.log(`API debug server ready: ${baseUrl}`);
    console.log(`DB copy: ${dbCopyPath}`);
    runNodeScript("scripts/test-off-to-claim-full-flow.mjs", env);
    runNodeScript("scripts/test-r7k-ui-simulation.mjs", env);
    runNodeScript("scripts/stress-test.mjs", env, ["3", "2"]);
  } finally {
    stopServer();
  }
}

main().catch((error) => {
  stopServer();
  console.error("LOCAL API DEBUG FAILED:", error);
  process.exit(1);
});
