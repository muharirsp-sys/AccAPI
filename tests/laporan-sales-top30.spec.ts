/*
 * Tujuan: Laporan Sales › Top 30 — siap (dua tabel berdampingan, rupiah id-ID, qty satuan tunggal vs campur), urut/principal dikirim ke API,
 *   kosong (semua vs per principal), galat ≠ kosong (+ Coba lagi), galat dengan data lama, tanpa izin (403), ponsel 390 px tanpa gulir
 *   menyamping halaman. Tanpa dialog native.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/laporan-sales-top30.spec.ts --config playwright.lap-top30.config.ts` (config sementara, tidak di-commit).
 * Dependensi: /api/laporan-sales/top30 di-mock dengan page.route (tidak menyentuh DB). Data contoh generik.
 * Side Effects: Tidak ada.
 */
import { expect, test, type Page } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const API = (url: URL) => url.pathname === "/api/laporan-sales/top30";

const b = (peringkat: number, kode: string, nama: string, nilai: number, qty: number, faktur: number, satuan: string[]) => ({ peringkat, kode, nama, nilai, qty, faktur, satuan });
const PRODUK = [
    b(1, "P-A1", "PRODUK A1", 1_568_088_288, 145_851, 1850, ["KRT", "SCH"]),
    b(2, "P-A2", "PRODUK A2", 711_501_203, 87_397, 1310, ["KRT"]),
    b(3, "P-A3", "PRODUK A3", 399_364_317, 1_234.5, 998, ["PCS"]),
];
const PELANGGAN = [
    b(1, "C-A01", "TOKO A1", 250_000_000, 9_000, 40, ["BTL", "KRT", "PCS"]),
    b(2, "C-A02", "TOKO A2", 90_000_000, 120, 12, ["KRT"]),
];
const jawaban = (over: Record<string, unknown> = {}) => ({
    bulan: "2026-10", principle: null, urut: "nilai", pilihanPrincipal: ["PRINCIPLE A", "PRINCIPLE B"], produk: PRODUK, pelanggan: PELANGGAN, ...over,
});

async function tanpaGulirMenyamping(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
/** Mock API; `isi` memutuskan jawaban per permintaan. Mengembalikan daftar query string yang diminta. */
async function mock(page: Page, isi: (u: URL, n: number) => ReturnType<typeof json> = () => json(jawaban())) {
    const diminta: URL[] = [];
    await page.route(API, (r) => { const u = new URL(r.request().url()); diminta.push(u); return r.fulfill(isi(u, diminta.length)); });
    return diminta;
}

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("siap: dua tabel berdampingan, rupiah id-ID, qty satuan tunggal vs campur, tanpa gulir menyamping", async ({ page }) => {
    const diminta = await mock(page);
    await page.setViewportSize({ width: 1700, height: 900 });
    await page.goto("/laporan-sales", NAV);
    await expect(page.getByRole("tab", { name: "Top 30" })).toHaveAttribute("aria-selected", "true", NAV);
    const produk = page.getByRole("table", { name: "Top 30 produk" });
    const pelanggan = page.getByRole("table", { name: "Top 30 pelanggan" });
    await expect(produk.locator("tbody tr")).toHaveCount(3, NAV);
    await expect(pelanggan.locator("tbody tr")).toHaveCount(2);

    await expect(produk.locator("tbody tr").filter({ hasText: "PRODUK A1" })).toContainText("Rp 1.568.088.288");
    await expect(produk.locator("tbody tr").filter({ hasText: "PRODUK A2" })).toContainText("87.397 KRT");
    await expect(produk.locator("tbody tr").filter({ hasText: "PRODUK A3" })).toContainText("1.234,5 PCS");
    await expect(produk.locator("tbody tr").filter({ hasText: "PRODUK A1" })).toContainText("campur (KRT, SCH)");
    await expect(produk.locator("tbody tr").filter({ hasText: "PRODUK A1" })).not.toContainText("145.851");
    await expect(pelanggan.locator("tbody tr").filter({ hasText: "TOKO A1" })).toContainText("campur (BTL, KRT, PCS)");
    await expect(page.getByText("Qty tidak dijumlah lintas satuan")).toBeVisible();
    await expect(page.getByRole("heading", { name: /Top 30 produk/ })).toContainText("(3)");

    // berdampingan: tinggi atas sama, pelanggan di kanan produk
    const kotakProduk = await page.getByRole("heading", { name: /Top 30 produk/ }).boundingBox();
    const kotakPelanggan = await page.getByRole("heading", { name: /Top 30 pelanggan/ }).boundingBox();
    expect(kotakProduk && kotakPelanggan && Math.abs(kotakProduk.y - kotakPelanggan.y) < 4 && kotakPelanggan.x > kotakProduk.x + 300).toBe(true);

    const bulan = await page.getByLabel("Bulan").inputValue();
    expect(diminta[0].searchParams.get("bulan")).toBe(bulan);
    expect(diminta[0].searchParams.get("urut")).toBe("nilai");
    expect(diminta[0].searchParams.has("principle")).toBe(false);
    await tanpaGulirMenyamping(page);
    await page.screenshot({ path: "test-results/laporan-sales-top30.png", fullPage: true });
});

test("urut Qty dan principal dikirim ke API; urutan jawaban server dipakai apa adanya", async ({ page }) => {
    const diminta = await mock(page, (u) => u.searchParams.get("urut") === "qty"
        ? json(jawaban({ urut: "qty", principle: u.searchParams.get("principle"), produk: [{ ...PRODUK[2], peringkat: 1 }, { ...PRODUK[1], peringkat: 2 }] }))
        : json(jawaban({ principle: u.searchParams.get("principle") })));
    await page.setViewportSize({ width: 1700, height: 900 });
    await page.goto("/laporan-sales", NAV);
    const produk = page.getByRole("table", { name: "Top 30 produk" });
    await expect(produk.locator("tbody tr")).toHaveCount(3, NAV);
    await expect(produk.locator("tbody tr").first()).toContainText("PRODUK A1");

    await page.getByLabel("Urut menurut").selectOption("qty");
    await expect(produk.locator("tbody tr")).toHaveCount(2, NAV);
    await expect(produk.locator("tbody tr").first()).toContainText("PRODUK A3");
    expect(diminta.at(-1)?.searchParams.get("urut")).toBe("qty");

    await page.getByLabel("Principal").selectOption("PRINCIPLE B");
    await expect.poll(() => diminta.at(-1)?.searchParams.get("principle")).toBe("PRINCIPLE B");
    expect(diminta.at(-1)?.searchParams.get("urut")).toBe("qty");
});

test("kosong: pesan berbeda untuk 'belum ada penjualan' dan 'principal ini tidak ada penjualan'", async ({ page }) => {
    await mock(page, (u) => json(jawaban({ principle: u.searchParams.get("principle"), produk: [], pelanggan: [] })));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/laporan-sales", NAV);
    await expect(page.getByRole("status").filter({ hasText: "Belum ada penjualan" })).toBeVisible(NAV);
    await expect(page.getByRole("table")).toHaveCount(0);
    await page.getByLabel("Principal").selectOption("PRINCIPLE B");
    await expect(page.getByRole("status").filter({ hasText: "Tidak ada penjualan PRINCIPLE B" })).toBeVisible(NAV);
});

test("galat: tampil sebagai galat (bukan kosong) dengan Coba lagi; berhasil setelah diulang", async ({ page }) => {
    let rusak = true; // bendera, bukan hitungan permintaan: StrictMode dev memanggil efek dua kali
    await mock(page, () => rusak ? json({ error: "Laporan Top 30 gagal dimuat." }, 500) : json(jawaban()));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/laporan-sales", NAV);
    // role=alert juga dipakai pengumum rute Next (kosong): saring menurut isi.
    const alert = page.getByRole("alert").filter({ hasText: "Laporan Top 30 belum berhasil dimuat." });
    await expect(alert).toBeVisible(NAV);
    await expect(page.getByText("Belum ada penjualan")).toHaveCount(0);
    rusak = false;
    await alert.getByRole("button", { name: "Coba lagi" }).click();
    await expect(page.getByRole("table", { name: "Top 30 produk" }).locator("tbody tr")).toHaveCount(3, NAV);
    await expect(alert).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Data gagal dimuat" })).toHaveCount(0);
});

test("galat dengan data lama: strip 'hasil sebelumnya' di atas tabel yang tetap terlihat", async ({ page }) => {
    await mock(page, (u) => u.searchParams.has("principle") ? json({ error: "x" }, 500) : json(jawaban()));
    await page.setViewportSize({ width: 1700, height: 900 });
    await page.goto("/laporan-sales", NAV);
    const produk = page.getByRole("table", { name: "Top 30 produk" });
    await expect(produk.locator("tbody tr")).toHaveCount(3, NAV);
    await page.getByLabel("Principal").selectOption("PRINCIPLE A");
    await expect(page.getByText("Gagal memuat ulang.")).toBeVisible(NAV);
    await expect(page.getByText("Yang tampil adalah hasil sebelumnya.")).toBeVisible();
    await expect(produk.locator("tbody tr")).toHaveCount(3);
    await expect(page.getByRole("heading", { name: "Data gagal dimuat" })).toHaveCount(0); // ErrorState penuh hanya bila tanpa data lama
    await tanpaGulirMenyamping(page);
});

test("tanpa izin: 403 dari API menjadi kalimat izin, bukan tabel kosong", async ({ page }) => {
    await mock(page, () => json({ error: "Forbidden" }, 403));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/laporan-sales", NAV);
    await expect(page.getByRole("alert").filter({ hasText: "tidak punya izin" })).toBeVisible(NAV);
    await expect(page.getByRole("table")).toHaveCount(0);
});

test("ponsel 390 px: tabel menjadi daftar bertumpuk, tanpa gulir menyamping halaman", async ({ page }) => {
    await mock(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/laporan-sales", NAV);
    const daftarProduk = page.getByRole("list", { name: "Top 30 produk" });
    await expect(daftarProduk.getByRole("listitem")).toHaveCount(3, NAV);
    await expect(daftarProduk).toContainText("#1 · P-A1");
    await expect(daftarProduk).toContainText("Rp 1.568.088.288");
    await expect(daftarProduk).toContainText("campur (KRT, SCH)");
    await expect(page.getByRole("list", { name: "Top 30 pelanggan" }).getByRole("listitem")).toHaveCount(2);
    const y1 = (await daftarProduk.boundingBox())?.y ?? 0;
    const y2 = (await page.getByRole("list", { name: "Top 30 pelanggan" }).boundingBox())?.y ?? 0;
    expect(y2).toBeGreaterThan(y1); // bertumpuk
    await tanpaGulirMenyamping(page);
    await page.screenshot({ path: "test-results/laporan-sales-top30-ponsel.png", fullPage: true });
});
