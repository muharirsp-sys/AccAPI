/*
 * Tujuan: Regresi keterbacaan menu berkelompok lintas tema dan ruang chat mobile.
 * Caller: Playwright lokal.
 * Dependensi: SidebarLayout, ThemeSwitcher, ChatWidget.
 * Main Functions: contrast/navigation labels dan overlap mobile.
 * Side Effects: Preferensi browser uji saja.
 */
import { expect, test } from "@playwright/test";

test("grouped navigation remains readable and accessible in every theme", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Menu ruang kerja", exact: true });
    const group = nav.getByRole("button", { name: "Keuangan", exact: true });
    await expect(group).toBeEnabled();
    await group.click();
    const link = nav.getByRole("link", { name: "Format SPPD", exact: true });
    await expect(link).toBeVisible();
    for (const theme of ["surya", "office-calm", "neon", "ios"]) {
        await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
        const ratio = await link.evaluate(element => {
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d")!;
            const parse = (color: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
            const layers: number[][] = [];
            for (let node: Element | null = element; node; node = node.parentElement) layers.push(parse(getComputedStyle(node).backgroundColor));
            let background = [255, 255, 255];
            for (const layer of layers.reverse()) background = background.map((v, i) => layer[i] * layer[3] / 255 + v * (1 - layer[3] / 255));
            const lum = (rgb: number[]) => rgb.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
            const a = lum(parse(getComputedStyle(element).color)), b = lum(background);
            return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        });
        expect(ratio, `Menu contrast in ${theme}`).toBeGreaterThanOrEqual(4.5);
    }
});

test("mobile chat controls stay clear of the bottom navigation", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Buka menu navigasi" })).toBeEnabled();
    const bottomNav = page.getByRole("navigation", { name: "Navigasi utama" });
    const chatButton = page.getByRole("button", { name: /chat/ });
    const overlaps = async (first: typeof bottomNav, second: typeof bottomNav) => {
        const [a, b] = await Promise.all([first.boundingBox(), second.boundingBox()]);
        if (!a || !b) throw new Error("Elemen yang diuji tidak terlihat");
        return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    };
    await expect.poll(() => overlaps(bottomNav, chatButton)).toBe(false);
    await chatButton.click();
    const chatDialog = page.getByRole("dialog", { name: "AI Assistant" });
    await expect(chatDialog).toBeVisible();
    await expect.poll(() => overlaps(bottomNav, chatDialog)).toBe(false);
    await expect.poll(() => overlaps(chatButton, chatDialog)).toBe(false);
});
