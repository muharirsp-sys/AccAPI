/*
 * Tujuan: Validasi browser shell Fiori: navigasi dari izin, cari menu Ctrl K, menu profil (mode, Bantuan), drawer + navigasi bawah ponsel.
 * Caller: Playwright; aplikasi development lokal dengan LOCAL_AUTH_BYPASS=true (izin admin).
 * Dependensi: Playwright, server Next.js lokal; tidak membuat transaksi.
 * Main Functions: desktop nav + Ctrl K, menu profil, ponsel (drawer, navigasi bawah, chat), layar lama di ponsel, tangkapan.
 * Side Effects: Preferensi browser terisolasi dan screenshot di test-results.
 */
import { expect, test, type Locator } from "@playwright/test";

const overlaps = async (first: Locator, second: Locator) => {
    const [a, b] = await Promise.all([first.boundingBox(), second.boundingBox()]);
    if (!a || !b) throw new Error("Elemen yang diuji tidak terlihat");
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
};

test("desktop: navigation is grouped by permission and Ctrl K finds menus", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/");
    await expect(page.getByRole("link", { name: "CV. Surya Perkasa, ke Beranda" })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Menu ruang kerja", exact: true });
    await expect(nav.getByText("Promo & Klaim", { exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Beranda", exact: true })).toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: "Antrean Faktur", exact: true }).click();
    await expect(page).toHaveURL(/\/antrean-faktur$/, { timeout: 60_000 }); // kompilasi rute pertama di mode dev bisa > 10 dtk
    await expect(nav.getByRole("link", { name: "Antrean Faktur", exact: true })).toHaveAttribute("aria-current", "page");

    await page.locator("body").click({ position: { x: 5, y: 300 } });
    await page.keyboard.press("Control+k");
    const search = page.getByRole("dialog", { name: "Cari menu" });
    await expect(search).toBeVisible();
    await expect(search.getByRole("searchbox", { name: "Cari menu" })).toBeFocused();
    await page.keyboard.type("tidak-ada-menu");
    await expect(search.getByText("Menu “tidak-ada-menu” tidak ditemukan.")).toBeVisible();
    await search.getByRole("searchbox").fill("format sppd");
    await expect(search.getByRole("link", { name: /Format SPPD/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/payments\/sppd$/, { timeout: 60_000 }); // kompilasi rute pertama di mode dev bisa > 10 dtk
    await expect(search).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("profile menu switches the Fiori mode and opens Bantuan", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/");
    await page.getByRole("button", { name: /^Menu profil/ }).click();
    const profile = page.getByRole("dialog", { name: "Menu profil" });
    await expect(profile.getByText("Admin", { exact: true })).toBeVisible();
    await profile.getByRole("group", { name: "Mode" }).getByRole("button", { name: "Gelap" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
    await expect(page.locator(".fi-shellbar")).toHaveCSS("background-color", "rgb(21, 29, 40)");
    await profile.getByRole("group", { name: "Mode" }).getByRole("button", { name: "Sistem" }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-scheme", /.+/);
    await profile.getByRole("button", { name: /Bantuan/ }).click();
    await expect(profile).toBeHidden();
    const chat = page.getByRole("dialog", { name: "AI Assistant" });
    await expect(chat).toBeVisible();
    await chat.getByRole("button", { name: "Tutup chat" }).click();
    await expect(chat).toBeHidden();
    // Tanpa tombol chat mengambang, fokus kembali ke pemicu menu profil.
    await expect(page.getByRole("button", { name: /^Menu profil/ })).toBeFocused();
});

test("mobile: drawer, role bottom navigation, and chat stay usable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const bottomNav = page.getByRole("navigation", { name: "Navigasi utama" });
    // Bypass lokal = izin admin → pintasan profil Admin.
    for (const name of ["Beranda", "Akses", "AOL", "Master"]) await expect(bottomNav.getByRole("link", { name, exact: true })).toBeVisible();
    for (const control of await bottomNav.locator("a, button").all()) {
        const box = await control.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(52);
        expect(Number.parseFloat(await control.evaluate(element => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
    }
    await page.getByRole("button", { name: "Buka menu navigasi" }).click();
    const drawer = page.getByRole("dialog", { name: "Menu", exact: true });
    await expect(drawer.getByRole("link", { name: "OFF Program Control" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("button", { name: "Buka menu navigasi" })).toBeFocused();
    await bottomNav.getByRole("button", { name: "Menu" }).click();
    await expect(drawer).toBeVisible();
    await drawer.getByRole("link", { name: "Summary Promo" }).click();
    await expect(page).toHaveURL(/\/summary$/, { timeout: 60_000 }); // kompilasi rute pertama di mode dev bisa > 10 dtk
    await expect(drawer).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: /^Menu profil/ }).click();
    await page.getByRole("dialog", { name: "Menu profil" }).getByRole("button", { name: /Bantuan/ }).click();
    const chat = page.getByRole("dialog", { name: "AI Assistant" });
    await expect(chat).toBeVisible();
    await expect.poll(() => overlaps(bottomNav, chat)).toBe(false);
    await page.screenshot({ path: "test-results/fiori-shell-mobile.png" });
    await page.getByRole("button", { name: "Buka menu navigasi" }).click();
    await page.setViewportSize({ width: 1366, height: 768 });
    await expect(drawer).toBeHidden();
});

test("legacy screens fit mobile inside the new shell and Summary upload stays readable", async ({ page }) => {
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
        await page.screenshot({ path: `test-results/fiori-shell-${path.slice(1)}-390.png` });
    }
});

test("desktop reference capture", async ({ page }) => {
    await page.setViewportSize({ width: 1536, height: 1024 });
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Menu ruang kerja", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: /^Selamat (pagi|siang|sore|malam)/ })).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-shell-desktop.png" });
});
