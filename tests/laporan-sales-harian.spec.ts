/*
 * Tujuan: Laporan Sales › Monitoring Harian (/laporan-sales#harian) — desktop 1366 px: tabel per (pelanggan, salesman) dengan MTD + D1…Dn
 *   (sel 0 = "–", gulir menyamping HANYA di dalam tabel, kolom Pelanggan menempel), paginasi klien 50 baris, cari, saringan cabang -> query,
 *   strip "faktur belum lengkap"; kosong (belum ada faktur ≠ tidak cocok), galat bisa diulang, galat dengan data lama, tanpa izin (403);
 *   ponsel 390 px: daftar pelanggan/salesman/MTD tanpa gulir menyamping halaman.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/laporan-sales-harian.spec.ts --config playwright.lap-harian.config.ts` (config sementara, tidak di-commit).
 * Dependensi: GET /api/laporan-sales/harian di-mock page.route (tanpa DB, tanpa Accurate). Data contoh generik.
 * Side Effects: Tangkapan bukti di test-results/laporan-sales-harian-*.png.
 */
import { expect, test, type Page } from "@playwright/test";
import type { BarisHarian, JawabanHarian } from "../lib/laporan-sales/kontrak";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 90_000 } as const;
const pad = (n: number) => String(n + 1).padStart(3, "0");

/** n pelanggan, MTD turun: baris ke-i = (n − i) juta, dipecah di tanggal 3 (60%) dan 17 (40%); salesman berselang-seling. */
const baris = (n: number, hari: number, cabang = "CABANG A"): BarisHarian[] => Array.from({ length: n }, (_, i) => {
    const perHari = new Array<number>(hari).fill(0);
    perHari[2] = (n - i) * 600_000;
    perHari[16] = (n - i) * 400_000;
    return { custNo: `C-${pad(i)}`, custNama: `TOKO ${pad(i)}`, salesCode: i % 2 ? "S-02" : "S-01", salesNama: i % 2 ? "SALES B" : "SALES A", cabang, mtd: (n - i) * 1_000_000, perHari };
});
/** Jawaban mengikuti ?bulan yang diminta (jumlah hari bulan itu), jadi spec tidak bergantung pada tanggal hari ini. */
const jawaban = (u: URL, n: number, o: Partial<JawabanHarian> = {}): JawabanHarian => {
    const bulan = u.searchParams.get("bulan")!;
    const [t, b] = bulan.split("-").map(Number);
    const hari = new Date(Date.UTC(t, b, 0)).getUTCDate();
    return { bulan, hari, pilihanCabang: ["CABANG A", "CABANG B"], baris: baris(n, hari, u.searchParams.get("cabang") ?? "CABANG A"), fakturTanpaDpp: 0, ...o };
};

/** Mock GET /api/laporan-sales/harian; `jawab(n, url)` = jawaban ke-n (bawaan 120 baris). Log = query tiap permintaan. */
async function pasang(page: Page, jawab?: (n: number, url: URL) => ReturnType<typeof json>) {
    const log: string[] = [];
    await page.route((u) => u.pathname === "/api/laporan-sales/harian", (r) => {
        const u = new URL(r.request().url());
        log.push(u.search);
        return r.fulfill(jawab ? jawab(log.length, u) : json(jawaban(u, 120, { fakturTanpaDpp: 3 })));
    });
    return log;
}
const buka = async (page: Page) => { await page.goto("/laporan-sales#harian", NAV); };
const tabel = (page: Page) => page.getByRole("table", { name: "Monitoring harian" });
async function tanpaGulirHalaman(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}

test.setTimeout(120_000); // mode dev: kompilasi pertama lambat; expect NAV (90 dtk) tidak boleh dipotong batas uji 30 dtk

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("siap: kolom Pelanggan/Salesman/Cabang/MTD/D1…D31, sel 0 = –, rupiah id-ID, urut MTD turun, strip faktur belum lengkap", async ({ page }) => {
    const log = await pasang(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await buka(page);
    const t = tabel(page);
    await expect(t).toBeVisible(NAV);
    expect(log[0]).toMatch(/^\?bulan=\d{4}-\d{2}$/);
    const kepala = t.locator("thead th");
    await expect(kepala.nth(0)).toHaveText("Pelanggan");
    await expect(kepala.nth(1)).toHaveText("Salesman");
    await expect(kepala.nth(2)).toHaveText("Cabang");
    await expect(kepala.nth(3)).toHaveText("MTD");
    await expect(kepala.nth(4)).toHaveText("D1");
    await expect(kepala.last()).toHaveText(/^D(28|29|30|31)$/);
    const pertama = t.locator("tbody tr").first();
    await expect(pertama).toContainText("TOKO 001");
    await expect(pertama).toContainText("C-001");
    await expect(pertama).toContainText("SALES A");
    await expect(pertama).toContainText("CABANG A");
    await expect(pertama.locator("td").nth(3)).toHaveText("Rp 120.000.000");
    await expect(pertama.locator("td").nth(4)).toHaveText("–"); // D1 = 0
    await expect(pertama.locator("td").nth(6)).toHaveText("72.000.000"); // D3
    await expect(pertama.locator("td").nth(20)).toHaveText("48.000.000"); // D17
    await expect(t.locator("tbody tr").nth(1)).toContainText("TOKO 002");
    await expect(page.getByRole("status").filter({ hasText: "Faktur belum lengkap." })).toContainText("3 faktur belum terbaca rinciannya");
    await expect(page.locator("h2", { hasText: "Monitoring harian" })).toContainText("(120)");
    await tanpaGulirHalaman(page);
    await page.screenshot({ path: "test-results/laporan-sales-harian-desktop.png" });
});

test("gulir menyamping hanya di dalam tabel; kolom Pelanggan menempel di kiri", async ({ page }) => {
    await pasang(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await buka(page);
    await expect(tabel(page)).toBeVisible(NAV);
    const kotak = page.locator(".lap-harian .fi-tablescroll");
    expect(await kotak.evaluate((el) => el.scrollWidth > el.clientWidth + 100)).toBe(true); // tabel lebih lebar dari wadahnya
    await tanpaGulirHalaman(page);
    await kotak.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await tanpaGulirHalaman(page);
    const sel = tabel(page).locator("tbody tr").first().locator("td").first();
    const wadah = await kotak.boundingBox();
    const posisi = await sel.boundingBox();
    expect(Math.abs(posisi!.x - wadah!.x)).toBeLessThan(2); // masih di tepi kiri walau digulir ke ujung kanan
    await expect(sel).toBeVisible();
    await page.screenshot({ path: "test-results/laporan-sales-harian-gulir.png" });
});

test("paginasi 50 baris, cari pelanggan/salesman, saringan cabang -> query", async ({ page }) => {
    const log = await pasang(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await buka(page);
    const t = tabel(page);
    await expect(t).toBeVisible(NAV);
    await expect(t.locator("tbody tr")).toHaveCount(50);
    await expect(page.getByText("Baris 1–50 dari 120")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sebelumnya" })).toBeDisabled();
    await page.getByRole("button", { name: "Berikutnya" }).click();
    await expect(page.getByText("Baris 51–100 dari 120")).toBeVisible();
    await expect(t.locator("tbody tr").first()).toContainText("TOKO 051");
    await page.getByRole("button", { name: "Berikutnya" }).click();
    await expect(t.locator("tbody tr")).toHaveCount(20);
    await expect(page.getByRole("button", { name: "Berikutnya" })).toBeDisabled();

    await page.getByLabel("Cari pelanggan atau salesman").fill("toko 007");
    await expect(t.locator("tbody tr")).toHaveCount(1);
    await expect(t.locator("tbody tr").first()).toContainText("TOKO 007");
    await expect(page.getByRole("navigation", { name: "Halaman tabel" })).toHaveCount(0);
    await page.getByLabel("Cari pelanggan atau salesman").fill("sales b");
    await expect(page.getByText("Baris 1–50 dari 60")).toBeVisible(); // pencarian kembali ke halaman 1
    await page.getByLabel("Cari pelanggan atau salesman").fill("tidak ada");
    await expect(page.getByRole("heading", { name: "Tidak ada yang cocok" })).toBeVisible();
    await page.getByLabel("Cari pelanggan atau salesman").fill("");

    await page.getByLabel("Cabang").selectOption("CABANG B");
    await expect.poll(() => log.at(-1)).toMatch(/cabang=CABANG\+B/);
    await expect(t.locator("tbody tr").first().locator("td").nth(2)).toHaveText("CABANG B");
});

test("kosong: belum ada faktur ≠ tidak cocok dengan cabang", async ({ page }) => {
    await pasang(page, (_, u) => json(jawaban(u, 0)));
    await page.setViewportSize({ width: 1366, height: 900 });
    await buka(page);
    await expect(page.getByRole("heading", { name: "Belum ada faktur bulan ini" })).toBeVisible(NAV);
    await expect(page.getByText("Tidak ada faktur penjualan (INV) pada bulan ini dalam cakupan Anda.")).toBeVisible();
    await page.getByLabel("Cabang").selectOption("CABANG B");
    await expect(page.getByRole("heading", { name: "Tidak ada yang cocok" })).toBeVisible();
    await page.screenshot({ path: "test-results/laporan-sales-harian-kosong.png" });
});

test("galat: 500 tampil berpesan (bukan kosong), Coba lagi memuat ulang", async ({ page }) => {
    let gagal = true; // sakelar, bukan hitungan panggilan: React StrictMode (dev) memuat dua kali saat dipasang
    await pasang(page, (_, u) => (gagal ? json({ error: "Internal server error: detail rahasia" }, 500) : json(jawaban(u, 3))));
    await page.setViewportSize({ width: 1366, height: 900 });
    await buka(page);
    const galat = page.getByRole("alert").filter({ hasText: "Monitoring Harian belum berhasil dimuat." });
    await expect(galat).toBeVisible(NAV);
    await expect(galat).not.toContainText("rahasia");
    await expect(page.getByRole("heading", { name: "Belum ada faktur bulan ini" })).toHaveCount(0);
    await page.screenshot({ path: "test-results/laporan-sales-harian-galat.png" });
    gagal = false;
    await page.getByRole("button", { name: "Coba lagi" }).click();
    await expect(tabel(page).locator("tbody tr")).toHaveCount(3, NAV);
    await expect(galat).toHaveCount(0);
});

test("galat memuat ulang: data lama tetap tampil + strip 'hasil sebelumnya'", async ({ page }) => {
    let gagal = false;
    await pasang(page, (_, u) => (gagal ? json({ error: "x" }, 500) : json(jawaban(u, 3))));
    await page.setViewportSize({ width: 1366, height: 900 });
    await buka(page);
    await expect(tabel(page).locator("tbody tr")).toHaveCount(3, NAV);
    gagal = true;
    await page.getByLabel("Cabang").selectOption("CABANG B");
    const strip = page.getByRole("alert").filter({ hasText: "Gagal memuat ulang." });
    await expect(strip).toContainText("hasil sebelumnya");
    await expect(tabel(page).locator("tbody tr")).toHaveCount(3);
    await page.screenshot({ path: "test-results/laporan-sales-harian-galat-ulang.png" });
});

test("tanpa izin: 403 tampil sebagai pesan izin, bukan tabel kosong", async ({ page }) => {
    await pasang(page, () => json({ error: "Forbidden" }, 403));
    await page.setViewportSize({ width: 1366, height: 900 });
    await buka(page);
    await expect(page.getByRole("alert").filter({ hasText: "Akun Anda tidak punya izin untuk ini." })).toBeVisible(NAV);
});

test("ponsel 390 px: daftar pelanggan · salesman · MTD, tanpa gulir menyamping halaman", async ({ page }) => {
    await pasang(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await buka(page);
    const daftar = page.getByRole("list", { name: "Monitoring harian" });
    await expect(daftar).toBeVisible(NAV);
    const satu = daftar.locator("li").first();
    await expect(satu).toContainText("TOKO 001");
    await expect(satu).toContainText("SALES A (S-01)");
    await expect(satu).toContainText("Rp 120.000.000");
    await expect(tabel(page)).toBeHidden();
    await tanpaGulirHalaman(page);
    await page.screenshot({ path: "test-results/laporan-sales-harian-ponsel.png", fullPage: true });
});
