/*
 * Tujuan: S7-1b butir 3 — Konsol (/api-wrapper) membaca penolakan /api/proxy SEBELUM diteruskan (4xx + sent:false: tanpa
 *   api_wrapper.execute / endpoint di luar katalog) sebagai "ditolak, tidak terkirim": berhenti di tahap itu, pesan server tampil apa
 *   adanya, tanpa status TIDAK DIKETAHUI, tanpa pembacaan riwayat Accurate dan tanpa kiriman ulang.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true):
 *   `npx playwright test tests/fiori-konsol-proxy.spec.ts --config playwright.fiori-local.config.ts --workers=1`.
 * Dependensi: /api/auth/accurate-session, /api/auth/db-list, /api/proxy di-mock dengan page.route (tanpa Accurate, tanpa DB).
 * Side Effects: tidak ada.
 */
import { expect, test, type Page } from "@playwright/test";

const NAV = { timeout: 90_000 } as const;
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const IZIN = "Tulis ke Accurate lewat Konsol butuh izin Konsol · Eksekusi (api_wrapper.execute). Tidak ada yang dikirim.";
const KATALOG = "Endpoint ini tidak ada di katalog tulis Konsol (hanya save.do/bulk-save.do katalog; hapus dan endpoint lain ditolak). Tidak ada yang dikirim.";

async function mockKonsol(page: Page, jawab: () => { status: number; body: unknown }) {
    const proxy: Array<{ endpointPath: string; method: string }> = [];
    await page.route((u) => u.pathname === "/api/auth/accurate-session", (r) => r.fulfill(json({
        ok: true, connected: true, databaseConnected: true, sessionHost: "https://public.accurate.id", databaseId: "DB-1", databaseAlias: "PT A",
    })));
    await page.route((u) => u.pathname === "/api/auth/db-list", (r) => r.fulfill(json({ d: [{ id: "DB-1", alias: "PT A" }] })));
    await page.route((u) => u.pathname === "/api/proxy", (r) => {
        const b = r.request().postDataJSON() as { endpointPath: string; method: string };
        proxy.push({ endpointPath: b.endpointPath, method: b.method });
        const j = jawab();
        return r.fulfill(json(j.body, j.status));
    });
    return proxy;
}

async function eksekusi(page: Page, route: string, payload: unknown) {
    await page.goto("/api-wrapper", NAV);
    const eks = page.getByRole("button", { name: "Eksekusi Endpoint" });
    await expect(eks).toBeEnabled(NAV);
    await page.locator("select").first().selectOption(route);
    await page.locator("textarea").first().fill(JSON.stringify(payload));
    await eks.click();
}

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} tidak diharapkan: ${d.message()}`); });
});

test("bulk-save tanpa api_wrapper.execute: 403 berkode sent:false -> berhenti di tahap 1, pesan server apa adanya, bukan TIDAK DIKETAHUI", async ({ page }) => {
    const proxy = await mockKonsol(page, () => ({ status: 403, body: { error: IZIN, code: "PERMISSION_REQUIRED", permission: "api_wrapper.execute", sent: false } }));
    // 150 baris = 2 tahap (100 + 50): tahap 2 TIDAK boleh dikirim, dan tidak ada pembacaan riwayat (GET list.do).
    const baris = Array.from({ length: 150 }, (_, i) => ({ customerNo: `C-${i}`, transDate: "01/10/2026", detailItem: [{ itemNo: "I1", quantity: 1 }] }));
    await eksekusi(page, "salesReturnBulkSave", baris);
    const log = page.getByText("Error Eksekusi:").locator("xpath=..").locator("xpath=..");
    await expect(log).toContainText(IZIN, NAV);
    await expect(page.getByText(/TIDAK DIKETAHUI|TIDAK PASTI/)).toHaveCount(0);
    expect(proxy).toEqual([{ endpointPath: "/api/sales-return/bulk-save.do", method: "POST" }]);
});

test("save.do di luar katalog / sesi belum lengkap: penolakan proxy sebelum diteruskan tampil apa adanya; tidak dikirim ulang", async ({ page }) => {
    let jawaban = { status: 403, body: { error: KATALOG, code: "ENDPOINT_TIDAK_DIIZINKAN", sent: false } as Record<string, unknown> };
    const proxy = await mockKonsol(page, () => jawaban);
    await eksekusi(page, "purchaseOrder", { vendorNo: "V-01" });
    await expect(page.getByText(KATALOG).first()).toBeVisible(NAV);
    expect(proxy).toEqual([{ endpointPath: "/api/purchase-order/save.do", method: "POST" }]);

    jawaban = { status: 400, body: { error: "Sesi Accurate belum lengkap. Login dan pilih database terlebih dahulu.", code: "ACCURATE_SESSION_INCOMPLETE", sent: false } };
    await page.getByRole("button", { name: "Eksekusi Endpoint" }).click();
    await expect(page.getByText("Sesi Accurate belum lengkap. Login dan pilih database terlebih dahulu.").first()).toBeVisible(NAV);
    expect(proxy).toHaveLength(2);
});
