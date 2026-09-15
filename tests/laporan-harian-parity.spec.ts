/*
 * Tujuan: Simulasi upload file nyata lewat menu web sampai review dan unduhan Pak Fahdhar.
 * Caller: Playwright dengan LAPORAN_PARITY_FILES=1 dan PostgreSQL/backend lokal terisolasi.
 * Dependensi: server Next.js lokal, ekspor pengguna dari LAPORAN_PARITY_SOURCE_DIR.
 * Main Functions: browser upload -> response -> penerima -> XLSX/HTML; tidak menekan Kirim.
 * Side Effects: Data run dan progress hanya pada DB simulasi; screenshot/report JSON lokal.
 */
import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

test("file asli menghasilkan 21 laporan dan rekap Pak Fahdhar melalui menu web", async ({ page }) => {
    test.skip(process.env.LAPORAN_PARITY_FILES !== "1", "Memerlukan ekspor privat dan lingkungan simulasi.");
    test.setTimeout(360_000);
    const root = process.env.LAPORAN_PARITY_SOURCE_DIR!;
    const errors: string[] = [];
    const sends: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", r => { if (r.url().endsWith("/send")) sends.push(r.url()); });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/laporan-harian");
    await page.locator("#laporan-penjualan").setInputFiles(path.join(root, "rincian_faktur_penjualan_cvsuryaperkasa_260914104850.xlsx"));
    await page.locator("#laporan-retur").setInputFiles(path.join(root, "rincian_faktur_penjualan_cvsuryaperkasa_260914105019.xlsx"));
    await page.locator("#laporan-stock").setInputFiles(path.join(root, "kuantitas_barang_per_gudang_cvsuryaperkasa_260914105049.xlsx"));
    const responsePromise = page.waitForResponse(r => r.url().endsWith("/api/laporan-harian/upload"), { timeout: 300_000 });
    await page.getByRole("button", { name: "Proses dan perbarui dashboard" }).click();
    const response = await responsePromise;
    const result = await response.json();
    await fs.mkdir("outputs/parity", { recursive: true });
    await fs.writeFile("outputs/parity/web-response.json", JSON.stringify(result, null, 2));
    expect(response.status(), JSON.stringify(result)).toBe(200);
    expect(result.generatedFiles).toHaveLength(21);
    expect(result.unmatchedReportKeywords).toEqual([]);
    expect(result.reportDate).toBe("2026-09-11");
    expect(result.recipientsPreview).toHaveLength(20);
    expect(result.recipientsPreview.some((r: {keyword:string}) => r.keyword === "MSM")).toBe(false);
    expect(result.manager.rows).toBe(26);
    expect(result.manager.unmappedGroups).toBe(0);
    await expect(page.getByRole("heading", { name: "Pengolahan selesai" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Laporan Pak Fahdhar" })).toBeVisible();
    await page.screenshot({ path: "outputs/parity/menu-web-result.png", fullPage: true });
    const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.getByRole("link", { name: "Buka tampilan screenshot" }).click(),
    ]);
    await popup.waitForLoadState();
    await expect(popup.getByRole("heading", { name: "Laporan Penjualan" })).toBeVisible();
    await expect(popup.locator("tbody tr")).toHaveCount(26);
    await popup.locator("main").screenshot({ path: "outputs/parity/Laporan-Pak-Fahdhar-2026-09-11.png" });
    const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("link", { name: "Unduh Excel Pak Fahdhar" }).click(),
    ]);
    await download.saveAs("outputs/parity/web-Pak-Fahdhar.xlsx");
    expect(sends).toEqual([]);
    expect(errors).toEqual([]);
});
