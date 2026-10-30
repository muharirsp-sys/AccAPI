/*
 * Tujuan: Tab "Coverage Ganda" /laporan-sales (slice coverage): siap (ringkasan, tabel, saringan principal), kosong (belum ada toko JKS vs tidak ada
 *   toko ganda), galat + coba lagi, galat dengan data lama, tanpa izin / belum tertaut hierarki (tanpa "Coba lagi"), bulan tidak ikut dikirim,
 *   ponsel 390 px tanpa gulir menyamping halaman. Tanpa dialog native.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/laporan-sales-coverage.spec.ts --config playwright.lap-coverage.config.ts`.
 * Dependensi: /api/laporan-sales/coverage di-mock dengan page.route (tidak menyentuh DB). Data contoh generik.
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const API = (url: URL) => url.pathname === "/api/laporan-sales/coverage";

const TOKO_A = { custCode: "C-A1", custName: "TOKO A", principle: "PRINCIPLE A", salesman: [
    { salesCode: "SALES A", salesNama: "SALES A", hari: "Senin", minggu: "all" },
    { salesCode: "SALES B", salesNama: "Nama SALES B", hari: "Kamis", minggu: "1,3" },
] };
// Toko yang sama ganda di DUA principal: ringkasan menghitung toko (2), judul tabel menghitung toko × principal (3).
const TOKO_A_B = { custCode: "C-A1", custName: "TOKO A", principle: "PRINCIPLE B", salesman: [
    { salesCode: "SALES C", salesNama: "SALES C", hari: "Jumat", minggu: "genap" },
    { salesCode: "SALES E", salesNama: "SALES E", hari: "Sabtu", minggu: "all" },
] };
const TOKO_B = { custCode: "C-B1", custName: "TOKO B", principle: "PRINCIPLE B", salesman: [
    { salesCode: "SALES A", salesNama: "SALES A", hari: "", minggu: "ganjil" },
    { salesCode: "SALES C", salesNama: "SALES C", hari: "Selasa", minggu: "genap" },
    { salesCode: "SALES D", salesNama: "SALES D", hari: "Rabu", minggu: "all, genap" },
] };
const DATA = { pilihanPrincipal: ["PRINCIPLE A", "PRINCIPLE B"], totalToko: 40, baris: [TOKO_A, TOKO_A_B, TOKO_B] };
const NAMA_TABEL = "Toko × principal dilayani lebih dari satu salesman";

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}

test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(180_000);
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("siap: ringkasan, tabel Toko/Principal/Salesman, saringan principal memuat ulang, bulan tidak ikut dikirim", async ({ page }) => {
    const diminta: { principle: string | null; bulan: string | null }[] = [];
    await page.route(API, (r) => {
        const u = new URL(r.request().url());
        diminta.push({ principle: u.searchParams.get("principle"), bulan: u.searchParams.get("bulan") });
        return r.fulfill(json(u.searchParams.get("principle") === "PRINCIPLE A" ? { ...DATA, totalToko: 12, baris: [TOKO_A] } : DATA));
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/laporan-sales#coverage", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("navigation", { name: "Jenis laporan" }).getByRole("link", { name: "Coverage Ganda" })).toHaveAttribute("aria-current", "page", NAV);
    const tabel = main.getByRole("table", { name: NAMA_TABEL });
    await expect(tabel).toBeVisible(NAV);
    await expect(main.locator("p[aria-live=polite]")).toHaveText("2 toko dilayani lebih dari satu salesman dari 40 toko JKS.");
    await expect(tabel.locator("thead th")).toHaveText(["Toko", "Principal", "Salesman"]);
    await expect(tabel.locator("tbody tr")).toHaveCount(3);
    const barisA = tabel.locator("tbody tr").nth(0);
    await expect(barisA).toContainText("TOKO A");
    await expect(barisA).toContainText("PRINCIPLE A");
    await expect(barisA).toContainText("SALES A · Senin · setiap minggu");
    await expect(barisA).toContainText("Nama SALES B (SALES B) · Kamis · minggu 1,3");
    await expect(tabel.locator("tbody tr").nth(1)).toContainText("SALES E · Sabtu · setiap minggu");
    const barisB = tabel.locator("tbody tr").nth(2);
    await expect(barisB).toContainText("C-B1");
    await expect(barisB).toContainText("SALES A · hari belum diisi · minggu ganjil");
    await expect(barisB).toContainText("SALES D · Rabu · setiap minggu, minggu genap");
    await expect(main.getByRole("heading", { level: 2, name: /Toko × principal dilayani lebih dari satu salesman \(3\)/ })).toBeVisible();
    await page.screenshot({ path: "test-results/laporan-sales-coverage-siap.png", fullPage: true });

    const pilih = main.getByLabel("Principal", { exact: true });
    await expect(pilih.locator("option")).toHaveText(["Semua principal", "PRINCIPLE A", "PRINCIPLE B"]);
    await pilih.selectOption("PRINCIPLE A");
    await expect(tabel.locator("tbody tr")).toHaveCount(1, NAV);
    await expect(main.locator("p[aria-live=polite]")).toHaveText("1 toko dilayani lebih dari satu salesman dari 12 toko JKS PRINCIPLE A.");
    await expect(pilih.locator("option")).toHaveCount(3);
    // (mode dev React Strict Mode bisa memuat awal dua kali; yang dijamin: hanya satu permintaan berprincipal)
    expect(diminta.filter((d) => d.principle !== null).map((d) => d.principle)).toEqual(["PRINCIPLE A"]);

    // Tab ini tak berperiode: mengganti bulan tidak memicu permintaan baru dan tidak pernah mengirim `bulan`.
    const sebelum = diminta.length;
    await main.getByLabel("Bulan").fill("2026-09");
    await page.waitForTimeout(400);
    expect(diminta).toHaveLength(sebelum);
    expect(diminta.every((d) => d.bulan === null)).toBe(true);
});

test("ringkasan aria-live: label principal ikut DATA, bukan pilihan baru (selagi memuat dan saat muat ulang gagal)", async ({ page }) => {
    let lepas = () => {};
    const tahan = new Promise<void>((r) => { lepas = r; });
    await page.route(API, async (r) => {
        if (new URL(r.request().url()).searchParams.get("principle") !== "PRINCIPLE B") return r.fulfill(json(DATA));
        await tahan;
        return r.fulfill(json({ error: "boom" }, 500));
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/laporan-sales#coverage", NAV);
    const main = page.locator("main");
    const ringkasan = main.locator("p[aria-live=polite]");
    const SEMUA = "2 toko dilayani lebih dari satu salesman dari 40 toko JKS.";
    await expect(ringkasan).toHaveText(SEMUA, NAV);
    const dikirim = page.waitForRequest((q) => q.url().includes("principle=PRINCIPLE"));
    await main.getByLabel("Principal", { exact: true }).selectOption("PRINCIPLE B");
    await dikirim;
    await expect(ringkasan).toHaveText(SEMUA);          // permintaan PRINCIPLE B masih tertahan: angka lama, tanpa label baru
    lepas();
    await expect(main.getByRole("alert")).toContainText("Yang tampil adalah hasil sebelumnya", NAV);
    await expect(ringkasan).toHaveText(SEMUA);          // gagal: data lama dipertahankan, label tetap milik data itu
});

test("kosong: 'tidak ada toko ganda' (ada toko JKS) berbeda dari 'belum ada toko JKS' (cakupan tanpa toko)", async ({ page }) => {
    let jawaban: unknown = { pilihanPrincipal: ["PRINCIPLE A"], totalToko: 12, baris: [] };
    await page.route(API, (r) => r.fulfill(json(jawaban)));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/laporan-sales#coverage", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { name: "Tidak ada toko ganda" })).toBeVisible(NAV);
    await expect(main.locator("p[aria-live=polite]")).toHaveText("0 toko dilayani lebih dari satu salesman dari 12 toko JKS.");
    await expect(main.getByRole("table")).toHaveCount(0);
    jawaban = { pilihanPrincipal: [], totalToko: 0, baris: [] };
    await main.getByRole("button", { name: "Muat ulang" }).click();
    await expect(main.getByRole("heading", { name: "Belum ada toko JKS" })).toBeVisible(NAV);
    await page.screenshot({ path: "test-results/laporan-sales-coverage-kosong.png" });
});

test("galat: 500 tampil sebagai galat (bukan kosong), tanpa detail server; Coba lagi memuat ulang", async ({ page }) => {
    let gagal = true;
    await page.route(API, (r) => r.fulfill(gagal ? json({ error: "relation jks_master does not exist" }, 500) : json(DATA)));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/laporan-sales#coverage", NAV);
    const main = page.locator("main");
    const galat = main.getByRole("alert");
    await expect(galat).toContainText("Coverage Ganda belum berhasil dimuat.", NAV);
    await expect(galat).not.toContainText("jks_master");
    await expect(main.getByRole("heading", { name: "Tidak ada toko ganda" })).toHaveCount(0);
    await page.screenshot({ path: "test-results/laporan-sales-coverage-galat.png" });
    gagal = false;
    await galat.getByRole("button", { name: "Coba lagi" }).click();
    await expect(main.getByRole("table", { name: NAMA_TABEL }).locator("tbody tr")).toHaveCount(3, NAV);
    await expect(main.getByRole("alert")).toHaveCount(0);
});

test("galat dengan data lama: muat ulang gagal → tabel lama tetap tampil + strip 'hasil sebelumnya'", async ({ page }) => {
    let gagal = false;
    await page.route(API, (r) => r.fulfill(gagal ? json({ error: "boom" }, 500) : json(DATA)));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/laporan-sales#coverage", NAV);
    const main = page.locator("main");
    const tabel = main.getByRole("table", { name: NAMA_TABEL });
    await expect(tabel.locator("tbody tr")).toHaveCount(3, NAV);
    gagal = true;
    await main.getByRole("button", { name: "Muat ulang" }).click();
    await expect(main.getByRole("alert")).toContainText("Yang tampil adalah hasil sebelumnya", NAV);
    await expect(tabel.locator("tbody tr")).toHaveCount(3);
    await page.screenshot({ path: "test-results/laporan-sales-coverage-galat-data-lama.png", fullPage: true });
});

test("tanpa izin / belum tertaut hierarki: penolakan 403 berpesan jelas, tanpa 'Coba lagi'", async ({ page }) => {
    let tolak: ReturnType<typeof json> = json({ error: "Forbidden" }, 403);
    await page.route(API, (r) => r.fulfill(tolak));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/laporan-sales#coverage", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { name: "Coverage Ganda tidak bisa dibuka" })).toBeVisible(NAV);
    await expect(main.getByText("Akun Anda tidak punya izin untuk ini.")).toBeVisible();
    await expect(main.getByRole("button", { name: "Coba lagi" })).toHaveCount(0);
    tolak = json({ kode: "HIERARKI_BELUM_TERTAUT", error: "Akun belum tertaut ke hierarki. Hubungi Admin." }, 403);
    await main.getByRole("button", { name: "Muat ulang" }).click();
    await expect(main.getByText("Akun belum tertaut ke hierarki. Hubungi Admin.")).toBeVisible(NAV);
    await expect(main.getByRole("button", { name: "Coba lagi" })).toHaveCount(0);
});

test("ponsel 390 px: daftar ListItem per toko (salesman terbaca utuh), tanpa gulir menyamping halaman", async ({ page }) => {
    await page.route(API, (r) => r.fulfill(json(DATA)));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/laporan-sales#coverage", NAV);
    const main = page.locator("main");
    const daftar = main.getByRole("list", { name: NAMA_TABEL });
    await expect(daftar).toBeVisible(NAV);
    await expect(daftar.locator("li")).toHaveCount(3);
    await expect(main.getByRole("table")).toBeHidden();
    const itemA = daftar.locator("li").filter({ hasText: "C-A1 · PRINCIPLE A" });
    await expect(itemA).toContainText("TOKO A");
    await expect(itemA).toContainText("2 salesman");
    await expect(itemA).toContainText("C-A1 · PRINCIPLE A");
    await expect(itemA).toContainText("Nama SALES B (SALES B) · Kamis · minggu 1,3");
    await expect(main.locator("p[aria-live=polite]")).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: "test-results/laporan-sales-coverage-ponsel.png", fullPage: true });
});
