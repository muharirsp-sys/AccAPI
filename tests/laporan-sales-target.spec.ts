/*
 * Tujuan: Laporan Sales › Target vs Realisasi (tab #target): siap (baris per cabang × principal + Total, lencana capaian per nada, strip info
 *   "N kombinasi belum punya target — realisasi Rp X tidak dihitung" = padanan dashboard), kosong (strip "belum diunggah" + pilih bulan lain
 *   lewat pemilih Bulan halaman), semua target 0 (strip peringatan), galat (≠ kosong, Coba lagi),
 *   tanpa izin (403), ponsel 390 px (daftar, tanpa gulir menyamping halaman). Tanpa dialog native.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/laporan-sales-target.spec.ts --config playwright.lap-target.config.ts` (config sementara, tidak di-commit).
 * Dependensi: GET /api/laporan-sales/target di-mock dengan page.route (tidak menyentuh DB). Data contoh generik.
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const API = (url: URL) => url.pathname === "/api/laporan-sales/target";

const baris = (cabang: string, principle: string, salesman: number, target: number, realisasi: number, persen: number | null) => ({ cabang, principle, salesman, target, realisasi, persen });
const BARIS = [
    baris("CABANG A", "PRINCIPLE A", 2, 150_000_000, 160_000_000, 106.7),
    baris("CABANG A", "PRINCIPLE B", 1, 40_000_000, 10_000_000, 25),
    baris("CABANG B", "PRINCIPLE A", 3, 80_000_000, 68_000_000, 85),
    baris("Tanpa cabang", "PRINCIPLE C", 0, 0, 3_000_000, null),
];
const jawaban = (
    bulan: string, rows: ReturnType<typeof baris>[],
    total = { target: 270_000_000, realisasi: 241_000_000, persen: 89.3 as number | null },
    tanpaTarget = { kombinasi: 0, realisasi: 0 },
) => ({ bulan, baris: rows, total, tanpaTarget });

/** Mock endpoint; `isi` memilih jawaban per bulan yang diminta. Mengembalikan daftar bulan yang diminta klien. */
async function mock(page: Page, isi: (bulan: string) => ReturnType<typeof json>) {
    const diminta: string[] = [];
    await page.route(API, (r) => {
        const bulan = new URL(r.request().url()).searchParams.get("bulan") ?? "";
        diminta.push(bulan);
        return r.fulfill(isi(bulan));
    });
    return diminta;
}

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("siap: baris per cabang × principal, lencana capaian per nada, baris Total di bawah", async ({ page }) => {
    const diminta = await mock(page, (b) => json(jawaban(b, BARIS, undefined, { kombinasi: 2, realisasi: 36_000_000 })));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/laporan-sales#target", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("tab", { name: "Target vs Realisasi" })).toHaveAttribute("aria-selected", "true", NAV);
    await expect(main.getByRole("status").filter({ hasText: "2 kombinasi salesman × principal belum punya target — realisasi Rp 36.000.000 tidak dihitung (sama dengan dashboard Insentif)." })).toBeVisible(NAV);
    const tabel = main.getByRole("table", { name: "Target vs Realisasi per cabang" });
    await expect(tabel).toBeVisible(NAV);
    expect(diminta[0]).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);

    const rows = tabel.locator("tbody tr");
    await expect(rows).toHaveCount(5); // 4 baris + Total
    const a1 = rows.nth(0);
    await expect(a1).toContainText("CABANG A");
    await expect(a1).toContainText("PRINCIPLE A");
    await expect(a1).toContainText("Rp 150.000.000");
    await expect(a1).toContainText("Rp 160.000.000");
    await expect(a1.locator(".fi-badge")).toHaveAttribute("data-tone", "pos");
    await expect(a1.locator(".fi-badge")).toContainText("106,7%");
    await expect(rows.nth(1).locator(".fi-badge")).toHaveAttribute("data-tone", "neg");
    await expect(rows.nth(2).locator(".fi-badge")).toHaveAttribute("data-tone", "warn");
    await expect(rows.nth(3).locator(".fi-badge")).toHaveAttribute("data-tone", "neu");
    await expect(rows.nth(3)).toContainText("Tanpa target");
    await expect(rows.nth(3)).toContainText("Tanpa cabang");
    const total = rows.nth(4);
    await expect(total).toContainText("Total");
    await expect(total).toContainText("Rp 270.000.000");
    await expect(total).toContainText("Rp 241.000.000");
    await expect(total).toContainText("89,3%");
    await expect(main.getByRole("status").filter({ hasText: "belum diunggah" })).toHaveCount(0);
    await expect(main.getByText("Semua target bulan ini bernilai 0.")).toHaveCount(0);
    await page.screenshot({ path: "test-results/laporan-sales-target.png", fullPage: true });
});

test("kosong: strip 'belum diunggah' + keadaan kosong; pilih bulan lain lewat pemilih Bulan memuat data bulan itu", async ({ page }) => {
    const diminta = await mock(page, (b) => json(b === "2026-09" ? jawaban(b, BARIS) : jawaban(b, [], { target: 0, realisasi: 0, persen: null })));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/laporan-sales#target", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("status").filter({ hasText: "Target/progres bulan ini belum diunggah." })).toBeVisible(NAV);
    await expect(main.getByRole("heading", { name: "Belum ada data bulan ini" })).toBeVisible();
    await expect(main.getByRole("table")).toHaveCount(0);
    await page.screenshot({ path: "test-results/laporan-sales-target-kosong.png" });

    await main.getByLabel("Bulan").fill("2026-09");
    await expect(main.getByRole("table", { name: "Target vs Realisasi per cabang" }).locator("tbody tr")).toHaveCount(5, NAV);
    await expect(main.getByText("Target/progres bulan ini belum diunggah.")).toHaveCount(0);
    await expect(main.getByText("belum punya target")).toHaveCount(0); // tanpaTarget.kombinasi = 0 → tanpa strip
    expect(diminta).toContain("2026-09");
});

test("semua target 0 → strip peringatan + lencana 'Tanpa target', bukan 0%", async ({ page }) => {
    await mock(page, (b) => json(jawaban(b, [baris("CABANG A", "PRINCIPLE A", 0, 0, 5_000_000, null)], { target: 0, realisasi: 5_000_000, persen: null })));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/laporan-sales#target", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("status").filter({ hasText: "Semua target bulan ini bernilai 0." })).toBeVisible(NAV);
    const rows = main.getByRole("table", { name: "Target vs Realisasi per cabang" }).locator("tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Tanpa target");
    await expect(rows.nth(1)).toContainText("Tanpa target"); // Total
    await expect(main.getByText("0%")).toHaveCount(0);
});

test("galat server tampil sebagai galat (bukan kosong) dan Coba lagi memuat ulang", async ({ page }) => {
    let gagal = true;
    await mock(page, (b) => (gagal ? json({ error: "Gagal memuat Target vs Realisasi." }, 500) : json(jawaban(b, BARIS))));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/laporan-sales#target", NAV);
    const main = page.locator("main");
    const galat = main.getByRole("alert").filter({ hasText: "Target vs Realisasi gagal dimuat." });
    await expect(galat).toBeVisible(NAV);
    await expect(main.getByText("belum diunggah")).toHaveCount(0);
    await expect(main.getByRole("table")).toHaveCount(0);
    gagal = false;
    await galat.getByRole("button", { name: "Coba lagi" }).click();
    await expect(main.getByRole("table", { name: "Target vs Realisasi per cabang" })).toBeVisible(NAV);
    await expect(main.getByRole("alert").filter({ hasText: "gagal dimuat" })).toHaveCount(0);
});

test("tanpa izin (403) tampil sebagai galat berkalimat izin, bukan kosong", async ({ page }) => {
    await mock(page, () => json({ error: "Forbidden" }, 403));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/laporan-sales#target", NAV);
    await expect(page.locator("main").getByRole("alert").filter({ hasText: "tidak punya izin" })).toBeVisible(NAV);
    await expect(page.locator("main").getByRole("table")).toHaveCount(0);
});

test("ponsel 390 px: daftar ListItem, Total di bawah, tanpa gulir menyamping halaman", async ({ page }) => {
    await mock(page, (b) => json(jawaban(b, BARIS)));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/laporan-sales#target", NAV);
    const main = page.locator("main");
    const daftar = main.getByRole("list", { name: "Target vs Realisasi per cabang" });
    await expect(daftar).toBeVisible(NAV);
    await expect(main.getByRole("table")).toBeHidden();
    await expect(daftar.getByRole("listitem")).toHaveCount(5);
    await expect(daftar.getByRole("listitem").nth(0)).toContainText("PRINCIPLE A");
    await expect(daftar.getByRole("listitem").nth(0)).toContainText("Rp 160.000.000");
    await expect(daftar.getByRole("listitem").nth(0)).toContainText("106,7%");
    await expect(daftar.getByRole("listitem").nth(4)).toContainText("Total");
    await expect(daftar.getByRole("listitem").nth(4)).toContainText("Target Rp 270.000.000");
    await noOverflow(page);
    await page.screenshot({ path: "test-results/laporan-sales-target-ponsel.png", fullPage: true });
});
