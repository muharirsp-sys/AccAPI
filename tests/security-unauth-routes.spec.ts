import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";

const QA_EMAIL = "qa.admin@local.test";
const QA_PASSWORD = "Admin123!";

function seedQaUsers() {
  const result = spawnSync("node", ["scripts/seed-local-qa-users.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      ["Failed to seed local QA users.", result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

test.describe("security guardrails for sensitive utility routes", () => {
  test.beforeAll(() => {
    seedQaUsers();
  });

  test("rejects unauthenticated idempotency and Accurate proxy requests", async ({ request }) => {
    const lock = await request.post("/api/idempotency/lock", {
      data: {
        keys: [
          {
            key: `security-smoke-${Date.now()}`,
            invoiceNo: "INV-SEC",
            customerNo: "CUST-SEC",
            amount: 1000,
            transDate: "2026-06-18",
            paymentMethod: "CASH",
            source: "security-test",
          },
        ],
      },
    });
    expect(lock.status()).toBe(401);

    const complete = await request.post("/api/idempotency/complete", {
      data: { keys: ["security-smoke"], status: "SUCCESS" },
    });
    expect(complete.status()).toBe(401);

    const proxy = await request.post("/api/proxy", {
      data: {
        endpointPath: "/api/item/list.do",
        method: "GET",
        payload: null,
        sessionHost: "http://127.0.0.1:9",
        sessionId: "fake-session",
        apiKey: "fake-key",
      },
    });
    expect(proxy.status()).toBe(401);
  });

  test("allows authenticated idempotency preview requests", async ({ request, baseURL }) => {
    const login = await request.post("/api/auth/sign-in/email", {
      headers: { Origin: baseURL || "http://localhost:3000" },
      data: { email: QA_EMAIL, password: QA_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();

    const lock = await request.post("/api/idempotency/lock", {
      data: {
        preview: true,
        keys: [
          {
            key: `security-auth-preview-${Date.now()}`,
            invoiceNo: "INV-AUTH",
            customerNo: "CUST-AUTH",
            amount: 1000,
            transDate: "2026-06-18",
            paymentMethod: "CASH",
            source: "security-test",
          },
        ],
      },
    });
    expect(lock.status()).toBe(200);
    await expect(lock).toBeOK();
    await expect(await lock.json()).toMatchObject({ ok: true });

    const proxy = await request.post("/api/proxy", {
      data: {
        endpointPath: "/api/item/list.do",
        method: "GET",
        payload: null,
        sessionHost: "http://127.0.0.1:9",
        sessionId: "fake-session",
        apiKey: "fake-key",
      },
    });
    expect(proxy.status()).toBe(400);
    await expect(await proxy.json()).toMatchObject({
      error: "Session host Accurate tidak diizinkan",
    });
  });

  test("rejects Accurate webhook calls from unauthorized forwarded IPs", async ({ request }) => {
    const res = await request.post("/api/webhook/accurate", {
      headers: { "x-forwarded-for": "203.0.113.10" },
      data: [{ eventType: "SECURITY_SMOKE", module: "TEST" }],
    });
    expect(res.status()).toBe(403);
  });
});
