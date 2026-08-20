import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("off-theme", "office-calm"));
});

test("Office Calm dashboard uses its warm palette consistently", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: /Portal Internal/ })).toHaveCSS("color", "rgb(46, 38, 29)");
    const activeLink = page.locator('aside a[aria-current="page"]');
    await expect(activeLink).toHaveCSS("background-color", "rgba(242, 210, 138, 0.22)");
    await expect.poll(() => activeLink.evaluate((element) => getComputedStyle(element, "::before").backgroundColor)).toBe("rgb(200, 148, 50)");
    await expect(page.locator("svg.lucide-cpu")).toHaveCSS("color", "rgb(200, 148, 50)");

    await page.getByRole("button", { name: "Ganti tema" }).click();
    const officeOption = page.getByRole("button", { name: /Office Calm/ });
    await expect(officeOption).toContainText("Cream hangat dan emas");
    await expect(officeOption.locator("span").first()).toHaveCSS("background-color", "rgb(200, 148, 50)");
});

test("Office Calm finance error remains readable", async ({ page }) => {
    await page.route("http://localhost:8000/**", (route) => route.abort());
    await page.goto("/finance");

    const message = page.getByText("Koneksi ke backend Python gagal. Pastikan localhost:8000 aktif.");
    await expect(message).toBeVisible();
    const contrast = await message.evaluate((element) => {
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

    expect(contrast).toBeGreaterThanOrEqual(4.5);
});

test("Office Calm SPPD file button uses the theme primary treatment", async ({ page }) => {
    await page.goto("/payments/sppd");

    const fileInput = page.locator('input[type="file"]').first();
    const style = await fileInput.evaluate((element) => {
        const pseudo = getComputedStyle(element, "::file-selector-button");
        return { backgroundImage: pseudo.backgroundImage, color: pseudo.color };
    });

    expect(style.backgroundImage).toContain("linear-gradient");
    expect(style.color).toBe("rgb(61, 40, 20)");
});
