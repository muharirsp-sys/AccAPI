import { expect, test } from "@playwright/test";

test("Date picker exposes its popup as a combobox", async ({ page }) => {
    await page.goto("/finance");
    const picker = page.getByRole("combobox", { name: "Filter tanggal finance" });
    await expect(picker).toHaveAttribute("aria-haspopup", "dialog");
    await expect(picker).toHaveAttribute("aria-expanded", "false");
});

test("Claim Workflow replaces empty API responses with user-facing errors", async ({ page }) => {
  await page.route("**/api/claim-workflow", (route) =>
    route.fulfill({ status: 502, body: "" }),
  );
  await page.route("**/api/claim-workflow/outstanding", (route) =>
    route.fulfill({ status: 502, body: "" }),
  );

  await page.goto("/claim-workflow");

  await expect(page.getByText("Gagal memuat Claim Workflow.")).toBeVisible();
  await expect(page.getByText("Gagal memuat Outstanding.")).toBeVisible();
  await expect(page.getByText(/Unexpected end of JSON input/)).toHaveCount(0);
});

test("Claim Workflow outstanding counter follows the API summary contract", async ({ page }) => {
  const submission = { workflowId: "wf-1", claimWorkflowNo: "CW-001", principleName: "PT Uji", status: "submitted", totalClaim: 100, totalPaid: 0, remainingAmount: 100 };
  await page.route("**/api/claim-workflow", (route) =>
    route.fulfill({ json: { ok: true, workflows: [] } }),
  );
  await page.route("**/api/claim-workflow/outstanding", (route) =>
    route.fulfill({ json: {
      ok: true,
      outstanding: [
        { ...submission, submissionId: "sub-1", noClaim: "NC-1" },
        { ...submission, submissionId: "sub-2", noClaim: "NC-2" },
      ],
      summary: { submissionCount: 2, totalClaim: 200, totalPaid: 0, totalOutstanding: 200 },
    } }),
  );

  await page.goto("/claim-workflow");

  await expect(page.getByText("2 klaim", { exact: true })).toBeVisible();
  await expect(page.locator("p", { hasText: /^Outstanding$/ }).locator("xpath=preceding-sibling::p[1]")).toHaveText("2");
  await expect(page.getByRole("link", { name: "CW-001" }).first()).toHaveAttribute("href", "/claim-workflow/wf-1");
});

test("mobile Faktur keeps the empty state inside the visible panel", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/faktur**", (route) => route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, rows: [], hasMore: false }),
    }));

    await page.goto("/faktur");

    const emptyState = page.getByText("Belum ada faktur di cache.");
    await expect(emptyState).toBeVisible();
    const box = await emptyState.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});
