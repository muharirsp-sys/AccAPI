/*
 * Tujuan: Catatan "Perilaku hari ini · usulan BL-…" (VariantNote, `.fi-varbox`) hanya tampil untuk Admin — pemegang users.manage, definisi
 *   yang sama dengan penjaga "minimal satu admin" (lib/rbac/otorisasi). Atribut `data-admin` dipasang SSR pada <main> oleh SidebarLayout;
 *   CSS menyembunyikan kotaknya secara bawaan. Satu layar contoh (Order Sales, dua catatan BL-32 dan BL-18).
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/fiori-varbox-admin.spec.ts --config <config lokal> --workers=1`.
 * Dependensi: tests/helpers/order-cabang-mock.ts (mock Order Sales). Non-admin = kunci users.manage diganti nama di payload RSC halaman
 *   (hanya di tes, teknik yang sama dengan tests/fiori-admin-user-grup.spec.ts). Tidak menyentuh DB.
 */
import { expect, test, type Page } from "@playwright/test";
import { mockOrderCabang, mockWebsales } from "./helpers/order-cabang-mock";

const NAV = { timeout: 60_000 } as const;
// Dokumen yang dijawab page.route (non-admin) tidak punya ruang alamat lokal; tanpa ini Edge memblokir skrip localhost.
test.use({ launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] } });

/** Jadikan akun non-Admin untuk halaman `path`: kunci users.manage diganti nama di dokumen (HTML ber-escape dan aliran RSC). */
async function bukanAdmin(page: Page, path: string) {
    await page.route((u) => u.pathname === path, async (route) => {
        const res = await route.fetch();
        const headers = { ...res.headers() };
        delete headers["content-length"];
        delete headers["content-encoding"];
        const body = (await res.text()).replaceAll('\\"users.manage\\"', '\\"users.manage_tes\\"').replaceAll('"users.manage"', '"users.manage_tes"');
        return route.fulfill({ status: res.status(), headers, body });
    });
}

test("Catatan varian (usulan BL) hanya untuk Admin: Admin melihat, non-Admin tidak (Order Sales)", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page, { peran: "sales" });
    await mockWebsales(page, { cabang: opsi });
    await page.setViewportSize({ width: 1366, height: 900 });
    const main = page.locator("main#workspace-content");

    // Admin (LOCAL_AUTH_BYPASS = semua izin, termasuk users.manage): kedua catatan terlihat.
    await page.goto("/sales", NAV);
    await expect(main.getByLabel("Cari pelanggan")).toBeVisible(NAV); // bagian Pelanggan (BL-32) tampil sesudah cakupan cabang terbaca
    await expect(main).toHaveAttribute("data-admin", "true");
    await expect(main.getByRole("complementary", { name: "Usulan BL-32" })).toBeVisible();
    await expect(main.getByRole("complementary", { name: "Usulan BL-18" })).toBeVisible();
    await expect(main.getByRole("complementary", { name: "Usulan BL-18" })).toContainText("Perilaku hari ini");
    await expect(main.locator("aside.fi-varbox").first()).toBeVisible();
    const nAdmin = await main.locator("aside.fi-varbox").count();
    expect(nAdmin).toBe(2);

    // Non-Admin (tanpa users.manage): kotak ada di DOM tetapi tersembunyi — tidak terlihat dan tidak terbaca pembaca layar.
    await bukanAdmin(page, "/sales");
    await page.goto("/sales", NAV);
    await expect(main.getByLabel("Cari pelanggan")).toBeVisible(NAV);
    await expect(main).not.toHaveAttribute("data-admin", "true");
    await expect(main.locator("aside.fi-varbox")).toHaveCount(nAdmin);
    await expect(main.locator("aside.fi-varbox").first()).toBeHidden();
    await expect(main.getByRole("complementary", { name: /Usulan BL-/ })).toHaveCount(0);
    await expect(main.locator("aside.fi-varbox:visible")).toHaveCount(0); // satu pun tak terlihat
});
