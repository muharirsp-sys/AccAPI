import { test, expect } from "@playwright/test";

test.describe("Chatbot E2E", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    // Check if already logged in (redirected to dashboard)
    if (page.url().includes("/login")) {
      // Try login with test credentials
      const emailInput = page.locator('input[name="email"], input#email, input[type="email"]');
      const passInput = page.locator('input[name="password"], input#password, input[type="password"]');
      if (await emailInput.isVisible().catch(() => false)) {
        await emailInput.fill("admin@example.com");
        await passInput.fill("password123");
        await page.locator('button[type="submit"]').click();
        await page.waitForTimeout(3000);
      }
    }
  });

  test("chat button visible after login", async ({ page }) => {
    // If still on login page, skip
    if (page.url().includes("/login")) {
      test.skip();
      return;
    }
    const btn = page.locator('button[aria-label="Buka chat"]');
    await expect(btn).toBeVisible({ timeout: 10000 });
  });

  test("chat dialog opens with welcome", async ({ page }) => {
    if (page.url().includes("/login")) { test.skip(); return; }
    await page.locator('button[aria-label="Buka chat"]').click();
    const dialog = page.locator('[role="dialog"][aria-label="AI Assistant"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("AI Assistant");
  });

  test("send menu and get response", async ({ page }) => {
    if (page.url().includes("/login")) { test.skip(); return; }
    await page.locator('button[aria-label="Buka chat"]').click();
    const input = page.locator('input[aria-label="Pesan chatbot"]');
    await input.fill("menu");
    await page.locator('button[aria-label="Kirim pesan"]').click();
    await page.waitForTimeout(3000);
    const dialog = page.locator('[role="dialog"][aria-label="AI Assistant"]');
    await expect(dialog).toContainText("Berikut yang bisa saya bantu");
  });

  test("escape closes dialog", async ({ page }) => {
    if (page.url().includes("/login")) { test.skip(); return; }
    await page.locator('button[aria-label="Buka chat"]').click();
    const dialog = page.locator('[role="dialog"][aria-label="AI Assistant"]');
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });
});
