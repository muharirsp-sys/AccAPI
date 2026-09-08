/*
 * Tujuan: Validasi browser desain Surya, akses navigasi, preferensi, dan drawer mobile.
 * Caller: Playwright; aplikasi development lokal dengan LOCAL_AUTH_BYPASS=true.
 * Dependensi: Playwright, server Next.js lokal; tidak membuat transaksi.
 * Main Functions: navigasi/search/favorite, small laptop, focus/resize mobile, unggah, screenshots.
 * Side Effects: Preferensi browser terisolasi dan screenshot di test-results.
 */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { localStorage.setItem("off-theme", "surya"); localStorage.setItem("smart-erp:sidebar-expanded", "true"); });
});

test("small laptop navigation is grouped, searchable, persistent, and fits the viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Selamat bekerja." })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Menu ruang kerja", exact: true });
    await expect(nav.getByRole("button", { name: "Promo & Klaim", exact: true })).toHaveAttribute("aria-expanded", "false");
    await nav.getByRole("button", { name: "Promo & Klaim", exact: true }).click();
    await expect(nav.getByRole("link", { name: "Summary Promo", exact: true })).toBeVisible();
    await expect.poll(() => nav.evaluate(element => element.scrollHeight <= element.clientHeight + 2)).toBe(true);
    await nav.getByRole("button", { name: "Favoritkan Summary Promo", exact: true }).click();
    await expect(nav.getByText("Favorit", { exact: true })).toBeVisible();
    await nav.getByRole("textbox", { name: "Cari menu" }).fill("Format SPPD");
    await expect(nav.getByRole("link", { name: "Format SPPD", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Summary Promo", exact: true })).toHaveCount(0);
    await nav.getByRole("textbox", { name: "Cari menu" }).fill("tidak-ada-menu");
    await expect(nav.getByText("Menu tidak ditemukan.")).toBeVisible();
    await nav.getByRole("button", { name: "Hapus pencarian" }).click();
    await nav.getByRole("link", { name: "Summary Promo", exact: true }).first().click();
    await expect(page).toHaveURL(/\/summary$/);
    await expect(page.getByRole("button", { name: "Buka/tutup sidebar" })).toHaveAttribute("aria-expanded", "true");
    await expect(nav.getByRole("button", { name: "Promo & Klaim", exact: true })).toHaveAttribute("aria-expanded", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("rail exposes groups and keeps the user choice when navigating", async ({ page }) => {
    await page.goto("/");
    const toggle = page.getByRole("button", { name: "Buka/tutup sidebar" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("smart-erp:sidebar-expanded"))).toBe("false");
    const nav = page.getByRole("navigation", { name: "Menu ruang kerja", exact: true });
    await nav.getByRole("button", { name: "Keuangan", exact: true }).click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(nav.getByRole("link", { name: "Format SPPD", exact: true })).toBeVisible();
});

test("mobile drawer traps focus, closes on escape, and fits its screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: "Buka menu navigasi" }).click();
    const dialog = page.getByRole("dialog", { name: "Menu navigasi" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Tutup menu", exact: true }).focus();
    await page.keyboard.press("Shift+Tab");
    // Native dialogs may yield focus to browser chrome; background app controls remain inert.
    expect(await page.evaluate(() => document.activeElement === document.body || Boolean(document.activeElement?.closest("dialog")))).toBe(true);
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Tutup menu", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Keluar", exact: true }).evaluate(element => element.focus());
    await expect(dialog.getByRole("button", { name: "Tutup menu", exact: true })).toBeFocused();
    await dialog.getByRole("button", { name: "Promo & Klaim", exact: true }).click();
    await expect(dialog.getByRole("link", { name: "Summary Promo", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Buka menu navigasi" })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/surya-mobile.png", fullPage: true });
    await page.getByRole("button", { name: "Semua menu", exact: true }).click();
    await expect(dialog).toBeVisible();
    await page.setViewportSize({ width: 1366, height: 768 });
    await expect(dialog).not.toBeVisible();
    await page.getByRole("button", { name: "Buka/tutup sidebar" }).click();
    await expect(page.getByRole("button", { name: "Buka/tutup sidebar" })).toHaveAttribute("aria-expanded", "false");
});

test("operational screens fit mobile and Summary upload stays readable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ["/summary", "/faktur", "/rekapan-nota", "/reconciliation"]) {
        await page.goto(path);
        const content = page.locator("#workspace-content");
        await expect(content.locator("h1")).toBeVisible();
        expect(await content.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        if (path === "/summary") {
            const input = content.locator('input[type="file"]').first();
            await expect(input).toHaveCSS("color", "rgb(82, 100, 93)");
            const button = await input.evaluate(element => {
                const style = getComputedStyle(element, "::file-selector-button");
                return { background: style.backgroundColor, color: style.color };
            });
            expect(button).toEqual({ background: "rgb(23, 105, 79)", color: "rgb(255, 255, 255)" });
        }
        await page.screenshot({ path: `test-results/surya-${path.slice(1)}-390.png` });
    }
});

test("desktop reference capture and readable primary colors", async ({ page }) => {
    await page.setViewportSize({ width: 1536, height: 1024 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Selamat bekerja." })).toHaveCSS("color", "rgb(24, 45, 41)");
    await page.getByRole("navigation", { name: "Menu ruang kerja", exact: true }).getByRole("button", { name: "Promo & Klaim", exact: true }).click();
    await page.screenshot({ path: "test-results/surya-desktop.png", fullPage: true });
});
