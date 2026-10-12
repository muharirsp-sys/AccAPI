/*
 * Tujuan: Beranda Admin Incaso (S6e-2b, BL-41): tile Pelunasan tidak pasti + Gagal boleh diulang dari GET /api/idempotency/summary?rows=1,
 *   kartu Pantauan (database aktif dari sesi Accurate, angka perDatabase, baris terbaru), pintasan Unggah, "Cek incaso" tanpa angka;
 *   galat ringkasan (HTTP 500 atau jawaban tanpa angka/daftar) ≠ 0 dan bisa dicoba lagi; sesi gagal ≠ "belum membuka database";
 *   ponsel tanpa gulir menyamping.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin; profil lewat ?peran=incaso, hanya development):
 *   `npx playwright test tests/fiori-pelunasan-beranda.spec.ts --config playwright.fiori-local.config.ts --workers=1`.
 * Dependensi: /api/idempotency/summary dan /api/auth/accurate-session di-mock page.route (kontrak docs/handover/S6e2-KONTRAK-API.md §6).
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const SUMMARY = {
    ok: true, uncertain: { unknown: 2, sendingStale: 1, total: 3 }, retryable: 4, processingStale: 0, staleMinutes: 15, asOf: "2026-10-10T08:00:00.000Z",
    perDatabase: [
        { databaseId: "77", label: "77", uncertain: { unknown: 2, sendingStale: 0, total: 2 }, retryable: 1, processingStale: 0 },
        { databaseId: null, label: "tidak tercatat", uncertain: { unknown: 0, sendingStale: 1, total: 1 }, retryable: 3, processingStale: 0 },
    ],
    rows: [
        { key: "PAY_A", status: "UNKNOWN", customerNo: "PELANGGAN-A", transDate: "09/10/2026", invoiceNo: "INV/A/001", amount: 120000, databaseId: "77", updatedAt: "2026-10-10T01:00:00.000Z", category: "uncertain" },
        { key: "PAY_B", status: "FAILED", customerNo: "PELANGGAN-B", transDate: "09/10/2026", invoiceNo: "INV/A/002", amount: 2500000, databaseId: null, updatedAt: "2026-10-09T23:00:00.000Z", category: "retryable" },
    ],
    rowsTruncated: false,
};
const SESI = { ok: true, connected: true, databaseConnected: true, sessionHost: "https://contoh.accurate.id", databaseId: "77", databaseAlias: "PT CONTOH" };

test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

async function pasang(page: Page, summary: () => ReturnType<typeof json>, sesi: () => ReturnType<typeof json> = () => json(SESI)) {
    const urls: string[] = [];
    await page.route((u) => u.pathname === "/api/idempotency/summary", (r) => { urls.push(r.request().url()); return r.fulfill(summary()); });
    await page.route((u) => u.pathname === "/api/auth/accurate-session", (r) => r.fulfill(sesi()));
    return urls;
}

test("Admin Incaso: tile dari ringkasan, kartu database aktif + per database + baris terbaru, pintasan Unggah, Cek incaso tanpa angka", async ({ page }) => {
    const urls = await pasang(page, () => json(SUMMARY));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/?peran=incaso", { timeout: 90_000 });
    const tugas = page.getByRole("region", { name: /Perlu tindakan/ });
    const ragu = tugas.getByRole("link", { name: /Pelunasan tidak pasti/ });
    await expect(ragu).toContainText("3");
    await expect(ragu).toContainText("2 tidak pasti · 1 mengirim macet");
    await expect(tugas.getByRole("link", { name: /Gagal, boleh diulang/ })).toContainText("4");
    await expect(tugas.getByRole("link", { name: /Unggah pelunasan/ })).toHaveAttribute("href", "/pelunasan");
    const cek = tugas.getByRole("group", { name: "Cek incaso" });
    await expect(cek).toContainText("Aplikasi desktop");
    await expect(cek.locator(".fi-tile-v")).toHaveCount(0);
    // Tile dan kartu berbagi satu sumber (?rows=1); dev StrictMode bisa memanggil effect dua kali, jadi jumlahnya tidak diuji.
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.endsWith("/api/idempotency/summary?rows=1"))).toBe(true);

    const kartu = page.getByRole("region", { name: /Pantauan/ });
    await expect(kartu).toContainText("Pelunasan perlu tindakan");
    await expect(kartu).toContainText("Database aktif Anda: PT CONTOH (id 77).");
    await expect(kartu).toContainText("PT CONTOH (aktif): 2 tidak pasti · 1 gagal");
    await expect(kartu).toContainText("tidak tercatat: 1 tidak pasti · 3 gagal");
    await expect(kartu).toContainText("INV/A/001 · PELANGGAN-A");
    await expect(kartu).toContainText("Gagal · boleh diulang");
    await expect(kartu.getByRole("link", { name: "Buka Pelunasan" })).toHaveAttribute("href", "/pelunasan");
    await page.screenshot({ path: "test-results/fiori-pelunasan-beranda.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("Ringkasan gagal (500) atau tanpa angka/daftar = 'Tidak bisa dimuat', bukan 0; Coba lagi memuat ulang; sesi gagal ≠ belum membuka database", async ({ page }) => {
    let jawab = json({ ok: false, error: "Koneksi basis data terputus." }, 500);
    let sesi = json({ error: "Internal" }, 500);
    await pasang(page, () => jawab, () => sesi);
    await page.goto("/?peran=incaso", { timeout: 90_000 });
    const tugas = page.getByRole("region", { name: /Perlu tindakan/ });
    const ragu = tugas.getByRole("button", { name: /Pelunasan tidak pasti/ });
    await expect(ragu).toContainText("Tidak bisa dimuat");
    await expect(page.getByRole("alert").filter({ hasText: "Ringkasan pelunasan, Sesi Accurate gagal dimuat." })).toBeVisible();
    await expect(tugas).not.toContainText("semua beres");
    const kartu = page.getByRole("region", { name: /Pantauan/ });
    await expect(kartu).toContainText("Ringkasan pelunasan gagal dimuat.");
    await expect(kartu).not.toContainText("Tidak ada yang menunggu");

    // Angka ada tetapi daftar ?rows=1 hilang = bentuk tak dikenal = galat (bukan nol, bukan daftar kosong).
    jawab = json({ ...SUMMARY, rows: undefined });
    await ragu.click();
    await expect(tugas.getByRole("button", { name: /Pelunasan tidak pasti/ })).toContainText("Tidak bisa dimuat");
    jawab = json({ ok: true });
    await tugas.getByRole("button", { name: /Pelunasan tidak pasti/ }).click();
    await expect(tugas.getByRole("button", { name: /Pelunasan tidak pasti/ })).toContainText("Tidak bisa dimuat");

    jawab = json(SUMMARY);
    await tugas.getByRole("button", { name: /Pelunasan tidak pasti/ }).click();
    await expect(tugas.getByRole("link", { name: /Pelunasan tidak pasti/ })).toContainText("3");
    // Sesi masih gagal: kartu tetap tampil, database aktif "tidak terbaca" (bukan "belum membuka"), label per database = id.
    await expect(kartu).toContainText("Database aktif tidak terbaca");
    await expect(kartu).toContainText("database id 77: 2 tidak pasti · 1 gagal");
    sesi = json(SESI);
    await page.getByRole("alert").getByRole("button", { name: "Coba lagi" }).click();
    await expect(kartu).toContainText("Database aktif Anda: PT CONTOH (id 77).");
    await page.screenshot({ path: "test-results/fiori-pelunasan-beranda-pulih.png", fullPage: true });
});
