import { expect, type Locator, test } from "@playwright/test";

async function contrastRatio(locator: Locator) {
    return locator.evaluate((element) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Canvas tidak tersedia");
        const parse = (value: string) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = value;
            context.fillRect(0, 0, 1, 1);
            const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
            return { r, g, b, a: alpha / 255 };
        };
        const blend = (front: ReturnType<typeof parse>, back: ReturnType<typeof parse>) => ({
            r: front.r * front.a + back.r * (1 - front.a),
            g: front.g * front.a + back.g * (1 - front.a),
            b: front.b * front.a + back.b * (1 - front.a),
            a: 1,
        });
        let background = { r: 255, g: 255, b: 255, a: 1 };
        const layers = [];
        for (let node: Element | null = element; node; node = node.parentElement) {
            const layer = parse(getComputedStyle(node).backgroundColor);
            if (layer.a > 0) layers.push(layer);
        }
        for (const layer of layers.reverse()) background = blend(layer, background);
        const luminance = ({ r, g, b }: typeof background) => [r, g, b]
            .map((value) => value / 255)
            .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
            .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
        const foreground = luminance(parse(getComputedStyle(element).color));
        const backdrop = luminance(background);
        return (Math.max(foreground, backdrop) + 0.05) / (Math.min(foreground, backdrop) + 0.05);
    });
}

test("Neon sales history table stays dark and readable", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("off-theme", "neon"));
    await page.goto("/sales-history");

    const table = page.locator("table").first();
    const header = table.getByText("No Faktur", { exact: true });
    const empty = table.getByText("Ketik nama atau kode produk untuk menampilkan history penjualan.");
    const headerLightness = await table.locator("thead").evaluate((element) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        context.fillStyle = getComputedStyle(element).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
        return (r + g + b) / (255 * 3);
    });

    expect(headerLightness).toBeLessThan(0.35);
    expect(await contrastRatio(header)).toBeGreaterThanOrEqual(4.5);
    expect(await contrastRatio(empty)).toBeGreaterThanOrEqual(4.5);
});

test("iOS preview and teal controls meet readable contrast", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("off-theme", "ios"));

    await page.goto("/payments/sppd");
    expect(await contrastRatio(page.getByRole("button", { name: "Preview", exact: true }))).toBeGreaterThanOrEqual(4.5);

    await page.goto("/finance");
    expect(await contrastRatio(page.getByRole("button", { name: "Export Excel" }))).toBeGreaterThanOrEqual(4.5);

    await page.goto("/reconciliation");
    expect(await contrastRatio(page.locator("span").filter({ hasText: /^KINO$/ }).first())).toBeGreaterThanOrEqual(4.5);

    await page.goto("/claim-workflow");
    const reports = page.getByRole("link", { name: "Reports / Export →" });
    await expect(reports).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect.poll(() => reports.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain("linear-gradient");
});

test("Reconciliation file buttons follow light theme primary treatments", async ({ page }) => {
    for (const theme of ["office-calm", "ios"] as const) {
        await page.addInitScript((selected) => localStorage.setItem("off-theme", selected), theme);
        await page.goto("/reconciliation");
        const fileInputs = page.locator('input[type="file"]');
        const count = await fileInputs.count();
        expect(count).toBeGreaterThan(0);
        for (let index = 0; index < count; index += 1) {
            const style = await fileInputs.nth(index).evaluate((element) => {
                const pseudo = getComputedStyle(element, "::file-selector-button");
                return { backgroundImage: pseudo.backgroundImage, color: pseudo.color };
            });
            expect(style.backgroundImage).toContain("linear-gradient");
            expect(style.color).toBe(theme === "ios" ? "rgb(255, 255, 255)" : "rgb(61, 40, 20)");
        }
    }
});

test("Office Calm module actions meet text contrast", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("off-theme", "office-calm"));
    await page.goto("/");

    const actions = page.getByText("Akses Modul", { exact: true });
    for (let index = 0; index < await actions.count(); index += 1) {
        expect(await contrastRatio(actions.nth(index))).toBeGreaterThanOrEqual(4.5);
    }
});

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
