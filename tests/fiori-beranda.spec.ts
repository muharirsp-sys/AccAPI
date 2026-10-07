/*
 * Tujuan: Beranda per peran (S1b): tile dari endpoint yang ada, galat per sumber, semua beres, memuat, ponsel.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin); peran lain lewat ?peran= (hanya development).
 * Dependensi: halaman /, respons endpoint di-mock dengan page.route (tidak menyentuh DB/Accurate).
 * Main Functions: fakturist (tile, pantauan, galat per sumber, coba lagi), gudang (tanggal WITA), semua beres, memuat, ponsel.
 * Side Effects: Tangkapan di test-results.
 */
import { expect, test, type Page } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const OUTBOX = { ok: true, escalateAfterMinutes: 120, summary: { queued: 7, sending: 0, unknown: 1, rejected: 2 }, overdue: 3, overdueQueue: 3, overdueBatches: 0, pendingBatches: [{ reviewCount: 6 }, { reviewCount: 2 }], rows: [] };
const VERIFY = { ok: true, checked: 100, summary: { cocok: 98, selisih: 1, dijelaskan: 1, "tak-terperiksa": 0 }, rows: [] };

async function mockFakturist(page: Page, verify: () => ReturnType<typeof json>) {
    await page.route("**/api/invoice-outbox", (route) => route.fulfill(json(OUTBOX)));
    await page.route("**/api/invoice-verify", (route) => route.fulfill(verify()));
}

test("fakturist: tiles count from the queue, verification error stays local and can be retried", async ({ page }) => {
    let verifyOk = false;
    await mockFakturist(page, () => (verifyOk ? json(VERIFY) : json({ ok: false, error: "x" }, 500)));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/?peran=fakturist");
    await expect(page.getByRole("heading", { level: 1, name: /^Selamat (pagi|siang|sore|malam), / })).toBeVisible();
    const tugas = page.getByRole("region", { name: /Perlu tindakan/ });
    const antrean = tugas.getByRole("link", { name: /Antrean belum terkirim/ });
    await expect(antrean).toContainText("10"); // 7 antre + 1 tidak pasti + 2 ditolak
    await expect(antrean).toContainText("3 lewat 2 jam · 2 ditolak · 1 tidak pasti");
    await expect(antrean).toHaveAttribute("href", "/antrean-faktur");
    await expect(tugas.getByRole("link", { name: /Batch perlu tinjau/ })).toContainText("8 baris perlu tinjau");
    // Galat satu sumber: tile itu menyatakan gagal, tile lain tetap berangka; strip menyebut sumbernya.
    const selisih = tugas.getByRole("button", { name: /Selisih verifikasi/ });
    await expect(selisih).toContainText("Tidak bisa dimuat");
    await expect(page.getByRole("alert").filter({ hasText: "Verifikasi balik faktur gagal dimuat." })).toBeVisible();
    await expect(page.getByRole("region", { name: "Pantauan" })).toContainText("Ditolak Accurate");
    await page.screenshot({ path: "test-results/fiori-beranda-fakturist-galat.png", fullPage: true });
    verifyOk = true;
    await selisih.click();
    await expect(tugas.getByRole("link", { name: /Selisih verifikasi/ })).toContainText("Dari 100 faktur terbaru");
    await expect(page.locator("main").getByRole("alert")).toHaveCount(0); // di luar main ada pengumum rute Next (role=alert)
    await page.screenshot({ path: "test-results/fiori-beranda-fakturist.png", fullPage: true });
});

test("gudang: wave and kanvas are requested for today in WITA", async ({ page }) => {
    const urls: string[] = [];
    await page.route((url) => url.pathname === "/api/rekapan-nota/wave", (route) => { urls.push(route.request().url()); return route.fulfill(json({ wave: [
        { id: 316, nama: "Pagi 1", status: "dikonfirmasi", jumlah_nota: 131, exception_open: 0 },
        { id: 317, nama: "Pagi 2", status: "rilis", jumlah_nota: 93, exception_open: 4 },
    ] })); });
    await page.route((url) => url.pathname === "/api/rekapan-nota/kanvas", (route) => { urls.push(route.request().url()); return route.fulfill(json({ jumlahNota: 218, ditandai: 6, nihil: 0 })); });
    await page.goto("/?peran=gudang");
    const tugas = page.getByRole("region", { name: /Perlu tindakan/ });
    await expect(tugas.getByRole("link", { name: /Exception terbuka/ })).toContainText("4");
    await expect(tugas.getByRole("link", { name: /Nota kanvas/ })).toContainText("Dari 218 nota hari ini");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());
    expect(urls.length).toBeGreaterThanOrEqual(2);
    for (const url of urls) expect(new URL(url).searchParams.get("tanggal")).toBe(today);
    await expect(page.getByRole("region", { name: "Pantauan" })).toContainText("Pagi 2");
});

test("all clear when every count is zero, and tiles show skeletons while loading", async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/invoice-outbox", async (route) => { await gate; return route.fulfill(json({ ...OUTBOX, summary: {}, overdueQueue: 0, pendingBatches: [] })); });
    await page.route("**/api/invoice-verify", async (route) => { await gate; return route.fulfill(json({ ...VERIFY, summary: { selisih: 0 } })); });
    await page.goto("/?peran=fakturist");
    const tugas = page.getByRole("region", { name: /Perlu tindakan/ });
    await expect(tugas.getByText("memuat…")).toBeVisible();
    await expect(tugas.locator('[aria-busy="true"]')).toHaveCount(3);
    release();
    await expect(tugas.getByText("Tidak ada yang perlu Anda tindak lanjuti")).toBeVisible();
    await expect(tugas.getByText("semua beres")).toBeVisible();
});

test("mobile: two-column tiles, shortcuts and no horizontal scroll", async ({ page }) => {
    await mockFakturist(page, () => json(VERIFY));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?peran=fakturist");
    await expect(page.getByRole("region", { name: /Perlu tindakan/ }).getByRole("link", { name: /Antrean belum terkirim/ })).toContainText("10");
    await expect(page.getByRole("region", { name: "Pintasan" }).getByRole("link")).toHaveCount(4);
    expect(await page.evaluate(() => { const main = document.querySelector("main")!; return document.documentElement.scrollWidth <= innerWidth && main.scrollWidth <= main.clientWidth + 1; })).toBe(true);
    await page.screenshot({ path: "test-results/fiori-beranda-fakturist-390.png", fullPage: true });
});
