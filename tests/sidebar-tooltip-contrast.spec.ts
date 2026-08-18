import { expect, test } from "@playwright/test";

test("collapsed sidebar tooltip keeps readable contrast in the iOS theme", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("off-theme", "ios"));
    await page.goto("/");

    const toggle = page.getByRole("button", { name: "Buka/tutup sidebar" });
    if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
    await page.getByRole("link", { name: "Format SPPD" }).hover();

    const tooltip = page.locator('[role="tooltip"]');
    await expect(tooltip).toHaveText("Format SPPD");
    const contrast = await tooltip.evaluate((element) => {
        const style = getComputedStyle(element);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        const rgb = (color: string) => {
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
        };
        const luminance = (color: string) => rgb(color)
            .map((value) => value / 255)
            .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
            .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
        const foreground = luminance(style.color);
        const background = luminance(style.backgroundColor);
        return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });

    expect(contrast).toBeGreaterThanOrEqual(4.5);
});

test("collapsed active icon follows each theme without recoloring inactive icons", async ({ page }) => {
    await page.goto("/");

    const toggle = page.getByRole("button", { name: "Buka/tutup sidebar" });
    if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
    const desktopSidebar = page.locator("aside").first();
    const activeIcon = desktopSidebar.locator('a[href="/"] svg');
    const inactiveIcon = desktopSidebar.locator('a[href="/validator"] svg');

    for (const [theme, expected] of [
        ["office-calm", "rgb(200, 148, 50)"],
        ["neon", "rgb(62, 208, 255)"],
        ["ios", "rgb(67, 94, 190)"],
    ] as const) {
        await page.evaluate((selectedTheme) => document.documentElement.setAttribute("data-theme", selectedTheme), theme);
        await expect(activeIcon).toHaveCSS("color", expected);
        await expect(inactiveIcon).not.toHaveCSS("color", expected);
    }
});

test("desktop navigation keeps the sidebar collapsed after changing pages", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("smart-erp:sidebar-expanded", "true"));
    await page.reload();

    const toggle = page.getByRole("button", { name: "Buka/tutup sidebar" });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await page.locator("aside").first().getByRole("link", { name: "Validator Diskon" }).click();

    await expect(page).toHaveURL(/\/validator$/);
    await expect(page.getByRole("button", { name: "Buka/tutup sidebar" })).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("smart-erp:sidebar-expanded"))).toBe("false");
});

test("collapsed desktop navigation does not reload and flash the expanded sidebar", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("smart-erp:sidebar-expanded", "false"));
    await page.reload();

    const toggle = page.getByRole("button", { name: "Buka/tutup sidebar" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await page.evaluate(() => ((window as typeof window & { sidebarDocumentMarker?: boolean }).sidebarDocumentMarker = true));

    await page.locator("aside").first().getByRole("link", { name: "Validator Diskon" }).click();

    await expect(page).toHaveURL(/\/validator$/);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => page.evaluate(() => (window as typeof window & { sidebarDocumentMarker?: boolean }).sidebarDocumentMarker)).toBe(true);
});

test("collapsed desktop tooltip closes after selecting an icon and leaving it", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("smart-erp:sidebar-expanded", "false"));
    await page.reload();

    const link = page.locator("aside").first().getByRole("link", { name: "OFF Program Control" });
    const tooltip = page.locator('[role="tooltip"]');
    await link.hover();
    await expect(tooltip).toHaveText("OFF Program Control");

    await link.click();
    await page.mouse.move(400, 300);

    await expect(page).toHaveURL(/\/off-program-control$/);
    await expect(tooltip).toHaveAttribute("aria-hidden", "true");
    await expect(tooltip).toHaveText("");
});
