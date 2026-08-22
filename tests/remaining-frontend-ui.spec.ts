import { expect, type Locator, test } from "@playwright/test";
import sharp from "sharp";

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

async function renderedContrastRatio(locator: Locator, samplePositions = [0.15, 0.35, 0.5, 0.65, 0.85]) {
    await locator.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" }));
    const foreground = await locator.evaluate((element) => {
        const match = getComputedStyle(element).color.match(/[\d.]+/g)?.map(Number);
        if (!match || match.length < 3) throw new Error("Warna teks tidak dapat dibaca");
        return { r: match[0], g: match[1], b: match[2], a: match[3] ?? 1 };
    });
    const previousColor = await locator.evaluate((element) => {
        const htmlElement = element as HTMLElement;
        const value = htmlElement.style.getPropertyValue("color");
        const priority = htmlElement.style.getPropertyPriority("color");
        htmlElement.style.setProperty("color", "transparent", "important");
        return { value, priority };
    });

    let screenshot: Buffer;
    try {
        screenshot = await locator.screenshot({ animations: "disabled" });
    } finally {
        await locator.evaluate((element, previous) => {
            const htmlElement = element as HTMLElement;
            if (previous.value) htmlElement.style.setProperty("color", previous.value, previous.priority);
            else htmlElement.style.removeProperty("color");
        }, previousColor);
    }

    const { data, info } = await sharp(screenshot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => [r, g, b]
        .map((value) => value / 255)
        .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    return samplePositions.flatMap((x) => [0.25, 0.5, 0.75].map((y) => {
        const pixelX = Math.min(info.width - 1, Math.max(0, Math.round((info.width - 1) * x)));
        const pixelY = Math.min(info.height - 1, Math.max(0, Math.round((info.height - 1) * y)));
        const offset = (pixelY * info.width + pixelX) * info.channels;
        const alpha = data[offset + 3] / 255;
        const background = {
            r: data[offset] * alpha + 255 * (1 - alpha),
            g: data[offset + 1] * alpha + 255 * (1 - alpha),
            b: data[offset + 2] * alpha + 255 * (1 - alpha),
        };
        const renderedForeground = {
            r: foreground.r * foreground.a + background.r * (1 - foreground.a),
            g: foreground.g * foreground.a + background.g * (1 - foreground.a),
            b: foreground.b * foreground.a + background.b * (1 - foreground.a),
        };
        const foregroundLuminance = luminance(renderedForeground);
        const backgroundLuminance = luminance(background);
        return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
            / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
    })).reduce((minimum, ratio) => Math.min(minimum, ratio), Number.POSITIVE_INFINITY);
}

async function expectAaContrast(locator: Locator, label = "element", samplePositions?: number[]) {
    await expect(locator).toBeVisible();
    expect(await renderedContrastRatio(locator, samplePositions), `${label} harus memenuhi WCAG AA`).toBeGreaterThanOrEqual(4.5);
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

test("Office Calm remaining labels and controls meet AA contrast", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("off-theme", "office-calm"));

    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);

        await page.goto("/validator");
        await expectAaContrast(page.getByText(/Proses sinkronisasi dan komputasi Validasi Excel/));

        await page.goto("/finance");
        await expectAaContrast(page.getByRole("button", { name: "Export Excel" }));
        const financeHeaders = page.locator("table thead th");
        await expect(financeHeaders).toHaveCount(10);
        for (let index = 0; index < 10; index += 1) {
            await expectAaContrast(financeHeaders.nth(index));
        }

        await page.goto("/payments");
        await expectAaContrast(page.getByRole("button", { name: "Simpan Entry" }));
        await expectAaContrast(page.getByText("Filter", { exact: true }).first());

        await page.goto("/payments/sppd");
        for (const text of [
            "Nomor Surat Terakhir",
            "Tanggal Jaminan",
            "Format Nomor",
            "Jatuh Tempo Bank",
            "Transfer per Halaman",
            "Tanggal Makassar",
            "Ganti nama principle yang salah/tidak sesuai data rekening. Semua record di payments yang cocok akan diupdate.",
            "Nama Lama (di Web)",
            "Nama Baru (sesuai Rekening)",
        ]) {
            await expectAaContrast(page.getByText(text, { exact: true }), `${text} (${viewport.width}px)`);
        }
        await expectAaContrast(page.getByText(/Otomatis cocokkan semua nama principle di web/));

        await page.goto("/claim-workflow");
        await expectAaContrast(page.getByText("After OFF Program Control", { exact: true }));

        await page.goto("/sales-history");
        await expectAaContrast(page.getByRole("button", { name: /^Freeze/ }));

        await page.goto("/admin/groups");
        await expectAaContrast(page.getByText("Pilih group di kiri untuk mengelola.", { exact: true }));
    }
});

test("approval flow toggle follows each theme primary treatment", async ({ browser }) => {
    const expected = {
        "office-calm": { text: "rgb(0, 109, 101)", gradient: "linear-gradient(to right", icon: "rgb(0, 135, 123)" },
        neon: { text: "rgb(2, 16, 36)", gradient: "rgb(62, 208, 255)", icon: "rgb(46, 229, 107)" },
        ios: { text: "rgb(255, 255, 255)", gradient: "rgb(82, 107, 207)", icon: "rgb(67, 94, 190)" },
    } as const;

    for (const theme of Object.keys(expected) as Array<keyof typeof expected>) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.addInitScript((selectedTheme) => localStorage.setItem("off-theme", selectedTheme), theme);
        await page.route("**/api/auth/get-session", (route) => route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                user: { id: "theme-test-admin", name: "Admin", email: "admin@local.test", role: "admin" },
                session: { id: "theme-test-session", userId: "theme-test-admin", token: "test", expiresAt: "2099-01-01T00:00:00.000Z" },
            }),
        }));
        await page.route("**/api/off-program-control/batches", (route) => route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true, batches: [] }),
        }));

        await page.goto("/off-program-control");
        const action = page.getByText("Tampilkan Alur", { exact: true });
        const toggle = page.getByRole("button", { name: /Alur Persetujuan/ });
        await expect(action).toBeVisible();
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        const styles = await action.evaluate((element) => {
            const actionStyle = getComputedStyle(element);
            const icon = element.closest("button")?.querySelector("svg");
            if (!icon?.parentElement) throw new Error("Ikon alur persetujuan tidak ditemukan");
            return {
                text: actionStyle.color,
                gradient: actionStyle.backgroundImage,
                icon: getComputedStyle(icon).color,
                iconBackground: getComputedStyle(icon.parentElement).backgroundColor,
            };
        });

        expect(styles.text, `${theme}: warna teks`).toBe(expected[theme].text);
        expect(styles.gradient, `${theme}: gradient tombol`).toContain(expected[theme].gradient);
        expect(styles.icon, `${theme}: warna ikon`).toBe(expected[theme].icon);
        if (theme === "ios") {
            expect(styles.iconBackground).toBe("rgb(235, 243, 255)");
            await expectAaContrast(action, "Tombol Tampilkan Alur iOS", [0.03, 0.1, 0.25, 0.5, 0.75, 0.9, 0.97]);
            await action.hover();
            expect(await action.evaluate((element) => getComputedStyle(element).boxShadow)).toContain("rgba(67, 94, 190, 0.32)");
            for (const label of ["Tampilkan Detail", "Tampilkan Kontrol"]) {
                const relatedToggle = page.getByText(label, { exact: true });
                await expect(relatedToggle).toHaveCSS("color", "rgb(255, 255, 255)");
                expect(await relatedToggle.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain("rgb(82, 107, 207)");
            }
        }
        await toggle.focus();
        await toggle.press("Enter");
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await expect(page.getByText("Sembunyikan", { exact: true })).toBeVisible();
        await page.close();
    }
});

test("iOS Claim Workflow neutral button hover uses a blue tint", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("off-theme", "ios"));
    await page.route("**/api/claim-workflow/wf-theme-test/audit", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, audit: [] }),
    }));
    await page.route("**/api/claim-workflow/wf-theme-test", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
            ok: true,
            workflow: {
                id: "wf-theme-test",
                claimWorkflowNo: "CW-THEME-001",
                offBatchId: "batch-theme-test",
                principleCode: "KINO",
                principleName: "Kino",
                status: "Draft",
                totalDpp: 0,
                totalPpn: 0,
                totalPph: 0,
                totalClaim: 0,
                totalPaid: 0,
                remainingAmount: 0,
                createdAt: "2026-01-01T00:00:00.000Z",
            },
            items: [],
            payments: [],
            submissions: [],
            canEditItems: false,
            isReadOnly: true,
            closeBlockers: [],
        }),
    }));

    await page.goto("/claim-workflow/wf-theme-test");
    const button = page.getByRole("button", { name: "Dengan Berkas Claim" });
    await expect(button).toBeVisible();

    await button.hover();
    await expect(button).toHaveCSS("background-color", "rgba(67, 94, 190, 0.06)");
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

test("mobile navigation fits five primary links and keeps secondary links in the drawer", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    const bottomNav = page.getByRole("navigation", { name: "Navigasi utama" });
    const primaryLinks = bottomNav.getByRole("link");
    await expect(primaryLinks).toHaveCount(5);
    for (const name of ["Dashboard", "AOL Form Engine", "Validator Diskon", "Summary Promo", "Finance"]) {
        await expect(bottomNav.getByRole("link", { name })).toBeVisible();
    }
    expect(await bottomNav.locator("div").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    await page.getByRole("button", { name: "Buka menu navigasi" }).click();
    const drawer = page.getByRole("dialog", { name: "Menu navigasi" });
    await expect(drawer.getByRole("link", { name: "OFF Program Control" })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Claim Workflow" })).toBeVisible();
});
