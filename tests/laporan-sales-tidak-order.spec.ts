/*
 * Tujuan: Laporan Sales › tab Tidak Order — siap (ringkasan "X dari Y kunjungan tidak order (Z%)", tabel Alasan + Per salesman), saringan cabang
 *   meminta ulang dengan ?cabang=, kosong ("Belum ada kunjungan tercatat bulan ini"), kunjungan tanpa tidak-order, galat + Coba lagi, galat dengan
 *   data lama, tanpa izin (403), hierarki belum tertaut (403 berkode), ponsel 390 px tanpa gulir menyamping.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/laporan-sales-tidak-order.spec.ts --config playwright.lap-tidak-order.config.ts`.
 * Dependensi: /api/laporan-sales/tidak-order di-mock dengan page.route (tidak menyentuh DB). Data contoh generik.
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const URL_TAB = "/laporan-sales#tidak-order";

const ALASAN = [
    { kode: "R15", label: "Toko tutup", kategori: "kunjungan", jumlah: 4 },
    { kode: "R01", label: "Stok masih cukup", kategori: "stok", jumlah: 2 },
    { kode: "RX9", label: "RX9", kategori: "", jumlah: 1 }, // kode tanpa padanan di master
    { kode: "", label: "Tanpa alasan", kategori: "", jumlah: 1 },
];
const SALES = [{ salesCode: "S1", salesNama: "SALES A", jumlah: 5 }, { salesCode: "S2", salesNama: "SALES B", jumlah: 3 }];
const PENUH = { kunjungan: 24, tidakOrder: 8, alasan: ALASAN, perSalesman: SALES };
const jawab = (isi: Record<string, unknown> = PENUH) => ({ bulan: "2026-10", pilihanCabang: ["CABANG A", "CABANG B"], kunjungan: 0, tidakOrder: 0, alasan: [], perSalesman: [], ...isi });

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
/** Mock endpoint; `isi` menerima URL permintaan. Mengembalikan daftar query string yang diminta. */
async function mock(page: Page, isi: (u: URL) => ReturnType<typeof json>) {
    const diminta: string[] = [];
    await page.route((u) => u.pathname === "/api/laporan-sales/tidak-order", (r) => {
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

test("siap: ringkasan 8 dari 24 (33,3%), tabel Alasan urut jumlah dengan % dari tidak order, tabel Per salesman", async ({ page }) => {
    const diminta = await mock(page, () => json(jawab()));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(URL_TAB, NAV);
    const main = page.locator("main");
    await expect(main.getByRole("tab", { name: "Tidak Order" })).toHaveAttribute("aria-selected", "true", NAV);
    await expect(main.getByText("8 dari 24 kunjungan tidak order (33,3%)")).toBeVisible(NAV);
    const alasan = main.getByRole("table", { name: "Alasan tidak order" });
    const baris = alasan.locator("tbody tr");
    await expect(baris).toHaveCount(4);
    await expect(baris.nth(0)).toContainText("Toko tutup");
    await expect(baris.nth(0)).toContainText("Kunjungan"); // kategori dikapitalkan
    await expect(baris.nth(0)).toContainText("50%"); // 4 dari 8 tidak order
    await expect(baris.nth(1)).toContainText("25%");
    await expect(baris.nth(2)).toContainText("RX9");
    await expect(baris.nth(2)).toContainText("12,5%");
    await expect(baris.nth(3)).toContainText("Tanpa alasan");
    const sales = main.getByRole("table", { name: "Tidak order per salesman" }).locator("tbody tr");
    await expect(sales).toHaveCount(2);
    await expect(sales.nth(0)).toContainText("SALES A");
    await expect(sales.nth(0)).toContainText("5");
    await expect(sales.nth(1)).toContainText("SALES B");
    expect(diminta[0]).toMatch(/^\?bulan=\d{4}-\d{2}$/);
    await page.screenshot({ path: "test-results/laporan-sales-tidak-order-desktop.png" });
});

test("saringan cabang: meminta ulang dengan ?cabang= dan menampilkan hasilnya; pilihan cabang tidak menyusut", async ({ page }) => {
    const diminta = await mock(page, (u) => json(u.searchParams.get("cabang") === "CABANG A"
        ? jawab({ kunjungan: 10, tidakOrder: 5, alasan: [ALASAN[0], ALASAN[1]], perSalesman: [SALES[0]] }) : jawab()));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(URL_TAB, NAV);
    const main = page.locator("main");
    await expect(main.getByText("8 dari 24 kunjungan tidak order (33,3%)")).toBeVisible(NAV);
    await main.getByLabel("Cabang").selectOption("CABANG A");
    await expect(main.getByText("5 dari 10 kunjungan tidak order (50%)")).toBeVisible(NAV);
    await expect(main.getByRole("table", { name: "Tidak order per salesman" }).locator("tbody tr")).toHaveCount(1);
    expect(diminta.at(-1)).toMatch(/&cabang=CABANG(%20|\+)A$/);
    await expect(main.getByLabel("Cabang").locator("option")).toHaveText(["Semua cabang", "CABANG A", "CABANG B"]);
});

test("kosong: bulan tanpa kunjungan tercatat -> EmptyState jujur, tanpa tabel", async ({ page }) => {
    await mock(page, () => json(jawab({ pilihanCabang: [] })));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(URL_TAB, NAV);
    const main = page.locator("main");
    await expect(main.getByText("Belum ada kunjungan tercatat bulan ini")).toBeVisible(NAV);
    await expect(main.getByText("Data terisi saat salesman check-in di Form Kontrol.")).toBeVisible();
    await expect(main.getByRole("table")).toHaveCount(0);
    await expect(main.getByText("kunjungan tidak order")).toHaveCount(0);
});

test("ada kunjungan tapi tidak ada tidak-order: ringkasan 0 dari N (0%), tabel menjelaskan kosongnya", async ({ page }) => {
    await mock(page, () => json(jawab({ kunjungan: 6 })));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(URL_TAB, NAV);
    const main = page.locator("main");
    await expect(main.getByText("0 dari 6 kunjungan tidak order (0%)")).toBeVisible(NAV);
    await expect(main.getByText("Tidak ada kunjungan tanpa order")).toHaveCount(2);
    await expect(main.getByText("Belum ada kunjungan tercatat bulan ini")).toHaveCount(0);
});

test("galat 500: ErrorState dengan Coba lagi, bukan kosong; berhasil setelah dicoba ulang", async ({ page }) => {
    let gagal = true;
    await mock(page, () => (gagal ? json({ error: "Gagal memuat Tidak Order." }, 500) : json(jawab())));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(URL_TAB, NAV);
    const main = page.locator("main");
    await expect(main.getByRole("alert")).toContainText("Laporan Tidak Order gagal dimuat.", NAV);
    await expect(main.getByText("Belum ada kunjungan tercatat")).toHaveCount(0);
    gagal = false;
    await main.getByRole("button", { name: "Coba lagi" }).click();
    await expect(main.getByText("8 dari 24 kunjungan tidak order (33,3%)")).toBeVisible(NAV);
});

test("galat dengan data lama: ganti bulan gagal -> SATU strip 'Gagal memuat ulang' + isi sebelumnya tetap", async ({ page }) => {
    await mock(page, (u) => (u.searchParams.get("bulan") === "2020-01" ? json({ error: "x" }, 500) : json(jawab())));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(URL_TAB, NAV);
    const main = page.locator("main");
    await expect(main.getByText("8 dari 24 kunjungan tidak order (33,3%)")).toBeVisible(NAV);
    await main.getByLabel("Bulan").fill("2020-01");
    await expect(main.getByText("Gagal memuat ulang.")).toHaveCount(1, NAV);
    await expect(main.getByText("Yang tampil adalah hasil sebelumnya.")).toBeVisible();
    await expect(main.getByText("8 dari 24 kunjungan tidak order (33,3%)")).toBeVisible();
    await expect(main.getByRole("table", { name: "Alasan tidak order" }).locator("tbody tr")).toHaveCount(4);
});

test("tanpa izin: 403 tampil sebagai galat berkalimat izin, bukan kosong", async ({ page }) => {
    await mock(page, () => json({ error: "Forbidden" }, 403));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(URL_TAB, NAV);
    await expect(page.locator("main").getByRole("alert")).toContainText("Akun Anda tidak punya izin untuk ini.", NAV);
});

test("hierarki belum tertaut: 403 berkode membawa kalimat server, bukan laporan kosong", async ({ page }) => {
    await mock(page, () => json({ kode: "HIERARKI_BELUM_TERTAUT", error: "Akun belum tertaut ke hierarki — hubungi Admin." }, 403));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(URL_TAB, NAV);
    const main = page.locator("main");
    await expect(main.getByRole("alert")).toContainText("Akun belum tertaut ke hierarki — hubungi Admin.", NAV);
    await expect(main.getByText("Belum ada kunjungan tercatat")).toHaveCount(0);
});

test("ponsel 390 px: daftar ListItem (bukan tabel lebar), tanpa gulir menyamping halaman", async ({ page }) => {
    await mock(page, () => json(jawab()));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(URL_TAB, NAV);
    const main = page.locator("main");
    const alasan = main.getByRole("list", { name: "Alasan tidak order" });
    await expect(alasan).toBeVisible(NAV);
    await expect(alasan.getByRole("listitem")).toHaveCount(4);
    await expect(alasan.getByRole("listitem").nth(0)).toContainText("Toko tutup");
    await expect(alasan.getByRole("listitem").nth(0)).toContainText("50%");
    const sales = main.getByRole("list", { name: "Tidak order per salesman" });
    await expect(sales.getByRole("listitem")).toHaveCount(2);
    await expect(sales.getByRole("listitem").nth(0)).toContainText("SALES A");
    await expect(main.getByRole("table")).toBeHidden(); // tabel ada di DOM tapi disembunyikan container query
    await noOverflow(page);
    await page.screenshot({ path: "test-results/laporan-sales-tidak-order-ponsel.png", fullPage: true });
});
