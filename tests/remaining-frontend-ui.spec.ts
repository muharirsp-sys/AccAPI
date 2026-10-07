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
