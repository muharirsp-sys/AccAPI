import { expect, test } from "@playwright/test";

test("local auth bypass exposes the admin OFF workspace", async ({ page }) => {
  await page.goto("/off-program-control");

  await page.getByRole("button", { name: "Detail akses" }).click();
  await expect(page.getByText("Role OFF:").locator("..")).toContainText("admin");
  await expect(
    page.getByText("Anda belum memiliki akses OFF Program Control. Hubungi admin."),
  ).toBeHidden();
});
