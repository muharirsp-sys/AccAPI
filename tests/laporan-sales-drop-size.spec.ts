/*
 * Tujuan: Laporan Sales › tab Drop Size — siap (tabel per tipe + baris Total tertimbang), saringan cabang meminta ulang dengan ?cabang=,
 *   strip faktur belum terbaca, kosong, galat + Coba lagi, galat dengan data lama (bulan berganti), tanpa izin (403), ponsel 390 px tanpa gulir menyamping.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/laporan-sales-drop-size.spec.ts --config playwright.lap-drop-size.config.ts`.
 * Dependensi: /api/laporan-sales/drop-size di-mock dengan page.route (tidak menyentuh DB). Data contoh generik.
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const URL_TAB = "/laporan-sales#drop-size";

type Baris = { tipe: string; toko: number; faktur: number; nilai: number; dropSize: number; nilaiPerToko: number };
const b = (tipe: string, toko: number, faktur: number, nilai: number): Baris => ({ tipe, toko, faktur, nilai, dropSize: nilai / faktur, nilaiPerToko: nilai / toko });
const SEMUA = [b("TT", 30, 60, 90_000_000), b("MT", 5, 25, 75_000_000), b("Tanpa tipe", 2, 4, 1_000_000)];
const CABANG_A = [b("MT", 5, 25, 75_000_000), b("TT", 20, 40, 60_000_000)];
const jawab = (baris: Baris[], over: Record<string, unknown> = {}) => ({ bulan: "2026-10", pilihanCabang: ["CABANG A", "CABANG B"], baris, fakturTanpaDpp: 0, ...over });

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
/** Mock endpoint; `isi` menerima URL permintaan. Mengembalikan daftar query string yang diminta. */
async function mock(page: Page, isi: (u: URL) => ReturnType<typeof json>) {
    const diminta: string[] = [];
    await page.route((u) => u.pathname === "/api/laporan-sales/drop-size", (r) => {
        const u = new URL(r.request().url());
        diminta.push(u.search);
        return r.fulfill(isi(u));
    });
    return diminta;
}

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("siap: tabel per tipe urut nilai, baris Total tertimbang, permintaan memuat ?bulan=YYYY-MM", async ({ page }) => {
    const diminta = await mock(page, () => json(jawab(SEMUA)));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(URL_TAB, NAV);
    const main = page.locator("main");
    await expect(main.getByRole("tab", { name: "Drop Size" })).toHaveAttribute("aria-selected", "true", NAV);
    const tabel = main.getByRole("table", { name: "Drop Size per tipe outlet" });
    await expect(tabel).toBeVisible(NAV);
    const baris = tabel.locator("tbody tr");
    await expect(baris).toHaveCount(4);
    await expect(baris.nth(0)).toContainText("TT");
    await expect(baris.nth(0)).toContainText("Rp 90.000.000");
    await expect(baris.nth(0)).toContainText("Rp 1.500.000"); // drop size 90 jt / 60 faktur
    await expect(baris.nth(0)).toContainText("Rp 3.000.000"); // nilai per toko 90 jt / 30
    await expect(baris.nth(2)).toContainText("Tanpa tipe");
    // Total: 166 jt / 89 faktur = Rp 1.865.169 (tertimbang), BUKAN rata-rata drop size baris (Rp 1.583.333)
    await expect(baris.nth(3)).toContainText("Total");
    await expect(baris.nth(3)).toContainText("37"); // toko
    await expect(baris.nth(3)).toContainText("89"); // faktur
    await expect(baris.nth(3)).toContainText("Rp 166.000.000");
    await expect(baris.nth(3)).toContainText("Rp 1.865.169");
    await expect(baris.nth(3)).not.toContainText("Rp 1.583.333");
    expect(diminta[0]).toMatch(/^\?bulan=\d{4}-\d{2}$/);
    await page.screenshot({ path: "test-results/laporan-sales-drop-size-desktop.png" });
});

test("saringan cabang: meminta ulang dengan ?cabang= dan menampilkan hasilnya; strip faktur belum terbaca", async ({ page }) => {
    const diminta = await mock(page, (u) => (u.searchParams.get("cabang") === "CABANG A" ? json(jawab(CABANG_A, { fakturTanpaDpp: 3 })) : json(jawab(SEMUA))));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(URL_TAB, NAV);
    const main = page.locator("main");
    const tabel = main.getByRole("table", { name: "Drop Size per tipe outlet" });
    await expect(tabel.locator("tbody tr")).toHaveCount(4, NAV);
    await expect(main.getByText("belum terbaca DPP-nya")).toHaveCount(0);
    await main.getByLabel("Cabang").selectOption("CABANG A");
    await expect(tabel.locator("tbody tr")).toHaveCount(3, NAV); // 2 tipe + Total
    await expect(tabel.locator("tbody tr").nth(2)).toContainText("Rp 135.000.000");
    await expect(main.getByText("3 faktur belum terbaca DPP-nya sehingga tidak dihitung")).toBeVisible();
    expect(diminta.at(-1)).toMatch(/&cabang=CABANG(%20|\+)A$/);
    await expect(main.getByLabel("Cabang").locator("option")).toHaveText(["Semua cabang", "CABANG A", "CABANG B"]); // pilihan tidak menyusut saat disaring
});

test("kosong: bulan tanpa faktur ber-DPP", async ({ page }) => {
    await mock(page, () => json(jawab([], { pilihanCabang: [] })));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(URL_TAB, NAV);
    await expect(page.locator("main").getByText("Belum ada faktur ber-DPP pada bulan ini.")).toBeVisible(NAV);
    await expect(page.locator("main").getByRole("table")).toHaveCount(0);
});

test("galat 500: ErrorState dengan Coba lagi, bukan kosong; berhasil setelah dicoba ulang", async ({ page }) => {
    let gagal = true;
    await mock(page, () => (gagal ? json({ error: "Gagal memuat Drop Size." }, 500) : json(jawab(SEMUA))));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(URL_TAB, NAV);
    const main = page.locator("main");
    await expect(main.getByRole("alert")).toContainText("Drop Size gagal dimuat.", NAV);
    await expect(main.getByText("Belum ada faktur")).toHaveCount(0);
    gagal = false;
    await main.getByRole("button", { name: "Coba lagi" }).click();
    await expect(main.getByRole("table", { name: "Drop Size per tipe outlet" })).toBeVisible(NAV);
});

test("galat dengan data lama: ganti bulan gagal -> strip 'Gagal memuat ulang' + tabel sebelumnya tetap", async ({ page }) => {
    await mock(page, (u) => (u.searchParams.get("bulan") === "2020-01" ? json({ error: "x" }, 500) : json(jawab(SEMUA))));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(URL_TAB, NAV);
    const main = page.locator("main");
    await expect(main.getByRole("table", { name: "Drop Size per tipe outlet" })).toBeVisible(NAV);
    await main.getByLabel("Bulan").fill("2020-01");
    await expect(main.getByText("Gagal memuat ulang.")).toBeVisible(NAV);
    await expect(main.getByText("Yang tampil adalah hasil sebelumnya.")).toBeVisible();
    await expect(main.getByRole("table", { name: "Drop Size per tipe outlet" }).locator("tbody tr")).toHaveCount(4);
});

test("tanpa izin: 403 tampil sebagai galat berkalimat izin, bukan kosong", async ({ page }) => {
    await mock(page, () => json({ error: "Forbidden" }, 403));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(URL_TAB, NAV);
    await expect(page.locator("main").getByRole("alert")).toContainText("Akun Anda tidak punya izin untuk ini.", NAV);
});

test("ponsel 390 px: daftar ListItem (bukan tabel lebar), baris Total, tanpa gulir menyamping halaman", async ({ page }) => {
    await mock(page, () => json(jawab(SEMUA, { fakturTanpaDpp: 2 })));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(URL_TAB, NAV);
    const main = page.locator("main");
    const daftar = main.getByRole("list", { name: "Drop Size per tipe outlet" });
    await expect(daftar).toBeVisible(NAV);
    await expect(daftar.getByRole("listitem")).toHaveCount(4);
    await expect(daftar.getByRole("listitem").nth(0)).toContainText("TT");
    await expect(daftar.getByRole("listitem").nth(0)).toContainText("30 toko · 60 faktur");
    await expect(daftar.getByRole("listitem").nth(3)).toContainText("Total");
    await expect(main.getByRole("table")).toBeHidden();
    await noOverflow(page);
    await page.screenshot({ path: "test-results/laporan-sales-drop-size-ponsel.png", fullPage: true });
});
