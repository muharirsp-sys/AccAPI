/*
 * Tujuan: Bingkai Fiori di pratinjau cetak Rekapan Nota (lembar picking `/cetak` & TTF `/ttf`): bilah atas tampil di LAYAR (judul +
 *   nomor wave, Kembali ke wave, Cetak = window.print) di 1366 & 390 px, dan HILANG di media print (kertas tidak berubah).
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin). Halaman cetak membaca Postgres langsung (tanpa API untuk di-mock),
 *   jadi uji hanya jalan bila DATABASE_URL menunjuk DB berisi wave dan PLAYWRIGHT_CETAK_WAVE = id wave itu; selain itu dilewati:
 *   `PLAYWRIGHT_CETAK_WAVE=1 npx playwright test tests/fiori-cetak-bingkai.spec.ts --config playwright.fiori-local.config.ts --workers=1`.
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test } from "@playwright/test";

const NAV = { timeout: 120_000 } as const;
const WAVE = process.env.PLAYWRIGHT_CETAK_WAVE;

for (const [rute, judul] of [["cetak", "Lembar picking"], ["ttf", "Tanda Terima Faktur"]] as const) {
    test(`Cetak ${rute}: bingkai Fiori tampil di layar (1366 & 390), hilang di print`, async ({ page }) => {
        test.skip(!WAVE, "butuh DB berisi wave: set PLAYWRIGHT_CETAK_WAVE");
        await page.addInitScript(() => { (window as unknown as { dicetak: number }).dicetak = 0; window.print = () => { (window as unknown as { dicetak: number }).dicetak += 1; }; });
        await page.setViewportSize({ width: 1366, height: 900 });
        await page.goto(`/rekapan-nota/wave/${WAVE}/${rute}`, NAV);
        await expect(page.locator(".halaman").first()).toBeVisible(NAV);
        const bar = page.locator("header.bingkai-cetak");
        await expect(bar).toBeVisible();
        await expect(bar.getByRole("heading", { level: 1 })).toHaveText(`${judul} · Wave #${WAVE}`);
        await expect(bar.getByRole("link", { name: "Kembali ke wave" })).toHaveAttribute("href", `/rekapan-nota/wave/${WAVE}`);
        await bar.getByRole("button", { name: "Cetak" }).click();
        expect(await page.evaluate(() => (window as unknown as { dicetak: number }).dicetak)).toBe(1);
        await page.screenshot({ path: `test-results/cetak-bingkai-${rute}-desktop.png` });

        // Bilah tetap di atas saat lembar digulir (sticky).
        await page.mouse.wheel(0, 1500);
        await expect.poll(() => bar.boundingBox().then((b) => b?.y ?? -1)).toBe(0);

        // Ponsel: judul, Kembali, dan Cetak semuanya di dalam lebar layar (lembar kertas sendiri memang lebih lebar dari 390).
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => window.scrollTo(0, 0));
        for (const el of [bar.getByRole("link", { name: "Kembali ke wave" }), bar.getByRole("heading", { level: 1 }), bar.getByRole("button", { name: "Cetak" })]) {
            await expect(el).toBeVisible();
            const b = await el.boundingBox();
            expect(b && b.x >= 0 && b.x + b.width <= 390, "elemen bilah muat di 390").toBe(true);
        }
        await page.screenshot({ path: `test-results/cetak-bingkai-${rute}-ponsel.png` });

        // Print: bingkai hilang dan tidak memakan ruang — kontainer lembar mulai tepat di tepi atas kertas, seperti sebelum ada bingkai.
        await page.setViewportSize({ width: 1366, height: 900 });
        await page.emulateMedia({ media: "print" });
        await expect(bar).toBeHidden();
        expect(await bar.evaluate((e) => getComputedStyle(e.closest(".layar-saja") as Element).display)).toBe("none");
        expect((await page.locator(".cetak-akar").boundingBox())?.y).toBe(0);
    });
}
