/*
 * Tujuan: Baseline visual + perilaku design system Fiori di halaman kit internal (/dev/ui-kit), slice S0.
 * Caller: Playwright (`npx playwright test tests/fiori-ui-kit.spec.ts`); server `npm run dev` lokal dengan LOCAL_AUTH_BYPASS=true.
 * Dependensi: Playwright, halaman app/(dashboard)/dev/ui-kit; tidak ada HTTP ke backend/Accurate.
 * Main Functions: enam keadaan (tangkapan baseline), ponsel 390 px, dialog konfirmasi, mode gelap/density.
 * Side Effects: localStorage peramban uji; tangkapan pembanding di tests/fiori-ui-kit.spec.ts-snapshots.
 */
import { expect, test, type Page } from "@playwright/test";

const KEADAAN = [["default", "Default"], ["memuat", "Memuat"], ["kosong", "Kosong"], ["galat", "Galat"], ["sukses", "Sukses"], ["draf", "Draf"]] as const;

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        if (sessionStorage.getItem("fiori-test-init")) return; // biarkan pilihan bertahan saat reload di dalam satu uji
        sessionStorage.setItem("fiori-test-init", "1");
        localStorage.setItem("off-theme", "surya");
        localStorage.removeItem("fiori-scheme");
        localStorage.removeItem("fiori-density");
    });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
});

async function openKit(page: Page, width: number) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/dev/ui-kit");
    await expect(page.getByRole("heading", { name: "UI kit Fiori", level: 1 })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
}

/** Shell lama menggulir di <main>; tinggikan viewport supaya seluruh .fiori terlihat untuk tangkapan elemen. */
async function shotKit(page: Page, name: string) {
    const height = await page.locator(".fiori").evaluate((el) => Math.ceil(el.getBoundingClientRect().top + el.scrollHeight + 40));
    await page.setViewportSize({ width: page.viewportSize()!.width, height });
    await expect(page.locator(".fiori")).toHaveScreenshot(name, { animations: "disabled", caret: "hide", maxDiffPixelRatio: 0.002 });
}

async function noHorizontalOverflow(page: Page) {
    return page.evaluate(() => {
        const main = document.querySelector("main");
        return document.documentElement.scrollWidth <= innerWidth && (!main || main.scrollWidth <= main.clientWidth + 1);
    });
}

test("enam keadaan: semantik + baseline 1440 px", async ({ page }) => {
    await openKit(page, 1440);
    const keadaan = page.getByRole("group", { name: "Keadaan" });
    for (const [value, label] of KEADAAN) {
        await keadaan.getByRole("button", { name: label, exact: true }).click();
        await expect(keadaan.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
        const daftar = page.locator("#daftar");
        if (value === "memuat") await expect(daftar.getByRole("status").filter({ hasText: "Memuat data" })).toBeVisible();
        if (value === "kosong") await expect(daftar.getByText("Belum ada faktur di antrean")).toBeVisible();
        if (value === "galat") {
            // Galat tidak pernah tampil sebagai kosong.
            await expect(page.locator("#tile").getByRole("alert")).toContainText("Data gagal dimuat");
            await expect(daftar.getByRole("alert")).toContainText("Yang tampil adalah hasil sebelumnya");
            await expect(daftar.getByText("Belum ada faktur")).toHaveCount(0);
        }
        if (value === "sukses") await expect(page.locator("#pesan").getByRole("status").filter({ hasText: "Berhasil." })).toBeVisible();
        if (value === "draf") {
            await expect(page.getByText("Draf belum disimpan")).toBeVisible();
            await expect(page.locator("#objek").getByRole("button", { name: "Simpan" })).toBeEnabled();
        }
        await shotKit(page, `kit-${value}-1440.png`);
        await page.setViewportSize({ width: 1440, height: 900 });
    }
});

test("ponsel 390 px: tanpa gulir menyamping, tabel jadi daftar, saringan di bottom sheet", async ({ page }) => {
    await openKit(page, 390);
    expect(await noHorizontalOverflow(page)).toBe(true);
    const daftar = page.locator("#daftar");
    await expect(daftar.locator(".fi-tablescroll")).toBeHidden();
    await expect(daftar.getByRole("list", { name: "Faktur" }).getByText("INV/2610/KN01412")).toBeVisible();
    await daftar.getByRole("button", { name: /Saringan/ }).click();
    const sheet = page.getByRole("dialog", { name: "Saringan" });
    await expect(sheet).toBeVisible();
    await sheet.getByLabel("Status").selectOption("Gagal kirim");
    await sheet.getByRole("button", { name: "Tampilkan hasil" }).click();
    await expect(sheet).toBeHidden();
    await expect(daftar.getByRole("button", { name: /Saringan\s*1/ })).toBeVisible();
    await expect(daftar.getByRole("list", { name: "Faktur" }).getByRole("listitem")).toHaveCount(1);
    await daftar.getByRole("button", { name: "Hapus semua" }).click();
    // FCL satu kolom: detail terbuka, Kembali menampilkan daftar.
    await page.locator("#fcl").getByRole("button", { name: "Kembali ke daftar" }).click();
    await expect(page.locator("#fcl").getByRole("button", { name: /007\/KINO\/10\/2026/ })).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);
    await shotKit(page, "kit-default-390.png");
});

test("dialog konfirmasi: fakta, alasan wajib, tutup dengan Escape", async ({ page }) => {
    await openKit(page, 1440);
    const daftar = page.locator("#daftar");
    const kirim = daftar.getByRole("button", { name: "Kirim ke Accurate" });
    await expect(kirim).toBeDisabled();
    await expect(daftar.getByText("Pilih faktur yang akan dikirim.")).toBeVisible();
    await daftar.getByRole("checkbox", { name: "Pilih INV/2610/KN01412" }).check();
    await daftar.getByRole("checkbox", { name: "Pilih INV/2610/KN01413" }).check();
    await kirim.click();
    const dialog = page.getByRole("dialog", { name: "Kirim 2 faktur ke Accurate?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Rp\s6\.187\.500/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(kirim).toBeFocused();

    await daftar.getByRole("button", { name: "Tolak" }).click();
    const tolak = page.getByRole("dialog", { name: "Tolak 2 faktur?" });
    const konfirmasi = tolak.getByRole("button", { name: "Tolak faktur" });
    await expect(konfirmasi).toBeDisabled();
    await tolak.getByLabel("Alasan penolakan").fill("Harga belum disetujui principal");
    await expect(konfirmasi).toBeEnabled();
    await tolak.getByRole("button", { name: "Batal" }).click();

    // Baris yang tersembunyi saringan tidak ikut aksi massal; pilih-semua hanya menyentuh baris terlihat.
    await daftar.getByRole("checkbox", { name: "Pilih INV/2610/KN01412" }).uncheck();
    await daftar.getByRole("checkbox", { name: "Pilih INV/2610/KN01415" }).check();
    await daftar.getByLabel("Status").selectOption("Siap kirim");
    await expect(daftar.getByText("1 faktur dipilih")).toBeVisible();
    await daftar.getByRole("checkbox", { name: "Pilih semua baris" }).check();
    await expect(daftar.getByText("2 faktur dipilih")).toBeVisible();
    await daftar.getByRole("button", { name: "Hapus semua" }).click();
    await expect(daftar.getByText("3 faktur dipilih")).toBeVisible();
    await daftar.getByRole("checkbox", { name: "Pilih INV/2610/KN01415" }).uncheck();

    await kirim.click();
    await dialog.getByRole("button", { name: "Kirim 2 faktur" }).click();
    // Selama mengirim, Escape (juga dua kali) tidak menutup dialog.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(daftar.getByRole("row", { name: /INV\/2610\/KN01412/ }).getByText("Terposting")).toBeVisible();
});

test("mode gelap dan density bertahan setelah muat ulang", async ({ page }) => {
    await openKit(page, 1440);
    const fiori = page.locator(".fiori");
    await page.getByRole("group", { name: "Mode" }).getByRole("button", { name: "Gelap" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
    await expect(fiori).toHaveCSS("background-color", "rgb(14, 20, 28)");
    await page.getByRole("group", { name: "Density" }).getByRole("button", { name: "Cozy" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-density", "cozy");
    await expect(page.locator("#tombol").getByRole("button", { name: "Ekspor" })).toHaveCSS("height", "44px");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
    await expect(page.getByRole("group", { name: "Mode" }).getByRole("button", { name: "Gelap" })).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() => document.fonts.ready);
    await shotKit(page, "kit-default-1440-dark-cozy.png");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("group", { name: "Mode" }).getByRole("button", { name: "Sistem" }).click();
    await page.getByRole("group", { name: "Density" }).getByRole("button", { name: "Otomatis" }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-scheme", /.+/);
    await expect(page.locator("html")).not.toHaveAttribute("data-density", /.+/);
    await expect(fiori).toHaveCSS("background-color", "rgb(244, 246, 249)");
});
