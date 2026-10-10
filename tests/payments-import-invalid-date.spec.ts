/*
 * Tujuan: Unggah LPB dengan tanggal tidak valid ditolak SEBELUM menulis (Fiori S6a): pratinjau server (`?dry_run=1`) menampilkan
 *   galatnya di dialog Unggah, tombol Simpan nonaktif, dan tidak ada unggahan tanpa pratinjau yang terkirim.
 *   Diperbarui dari versi lama (login QA nyata + backend nyata + payments.json lokal) ke layar Fiori dengan FastAPI di-mock:
 *   UI lama (form unggah + toast) sudah diganti dialog pratinjau → simpan.
 * Caller: `npm run test:payments-import` / Playwright lokal dengan LOCAL_AUTH_BYPASS=true (PLAYWRIGHT_BASE_URL = server dev).
 * Dependensi: FastAPI (dev: http://localhost:8000) di-mock dengan page.route; header CORS memantulkan Origin halaman.
 * Side Effects: Tidak ada (tidak menyentuh python_backend/data).
 */
import { expect, test, type Route } from "@playwright/test";

const cors = (r: Route) => ({
    "access-control-allow-origin": r.request().headers()["origin"] ?? "*", "access-control-allow-credentials": "true",
    "access-control-allow-headers": "content-type, x-csrf-token", "access-control-allow-methods": "GET, POST, OPTIONS",
});
const json = (r: Route, body: unknown, status = 200) => r.fulfill({ status, headers: { ...cors(r), "content-type": "application/json" }, body: JSON.stringify(body) });
const GALAT = "Tanggal tidak valid: baris 2 TGL. SETOR '31/02/2026'. Upload dibatalkan.";

test("Unggah LPB: tanggal tidak valid tampil di pratinjau, Simpan nonaktif, tidak ada tulis", async ({ page }) => {
    const unggah: string[] = [];
    await page.route((u) => u.host === "localhost:8000", (r) => {
        if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: cors(r) });
        const url = new URL(r.request().url());
        if (url.pathname === "/api/me") return json(r, { ok: true, csrf_token: "t" });
        if (url.pathname === "/payments/data") return json(r, { ok: true, data: [] });
        if (url.pathname === "/payments/upload") {
            unggah.push(url.search);
            return json(r, { ok: true, dry_run: true, can_apply: false, rows: 1, total_nilai_win: 1_250_000, total_nilai_invoice: 1_250_000, duplicates: [], duplicates_in_file: [], invalid: ["baris 2: TGL. SETOR '31/02/2026'"], error: GALAT });
        }
        return json(r, { ok: true });
    });
    await page.goto("/payments", { timeout: 60_000 });
    const main = page.locator("main");
    await expect(main.getByText("Belum ada rekaman pembayaran")).toBeVisible({ timeout: 60_000 });
    await main.getByRole("button", { name: "Unggah LPB" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Berkas LPB (.xlsx/.xls)").setInputFiles({ name: "lpb-invalid-date.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("x") });
    await expect(dlg.getByText(GALAT)).toBeVisible();
    await expect(dlg.getByText("baris 2: TGL. SETOR '31/02/2026'")).toBeVisible();
    await expect(dlg.getByRole("button", { name: "Simpan 1 LPB" })).toBeDisabled();
    expect(unggah).toEqual(["?dry_run=1"]);
});
