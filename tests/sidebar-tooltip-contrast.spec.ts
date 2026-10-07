/*
 * Tujuan: Regresi keterbacaan navigasi samping Fiori di mode terang dan gelap.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true).
 * Dependensi: SidebarLayout (shell Fiori), token app/fiori.css.
 * Main Functions: kontras tautan navigasi, termasuk tautan aktif, di dua mode.
 * Side Effects: Preferensi browser uji saja.
 */
import { expect, test, type Locator } from "@playwright/test";

const contrast = (link: Locator) => link.evaluate(element => {
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

for (const scheme of ["light", "dark"] as const) {
    test(`side navigation stays readable in ${scheme} mode`, async ({ page }) => {
        await page.addInitScript(value => localStorage.setItem("fiori-scheme", value), scheme);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/");
        await expect(page.locator("html")).toHaveAttribute("data-scheme", scheme);
        const nav = page.getByRole("navigation", { name: "Menu ruang kerja", exact: true });
        for (const name of ["Beranda", "Format SPPD", "Antrean Faktur"]) {
            expect(await contrast(nav.getByRole("link", { name, exact: true })), `${name} (${scheme})`).toBeGreaterThanOrEqual(4.5);
        }
        expect(await contrast(nav.getByText("Keuangan", { exact: true })), `judul kelompok (${scheme})`).toBeGreaterThanOrEqual(4.5);
    });
}
