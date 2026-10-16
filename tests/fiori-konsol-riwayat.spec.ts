/*
 * Tujuan: Konsol /api-wrapper — kiriman massal TULIS non-sales-receipt yang dijawab 504 (tanpa jawaban Accurate) TIDAK boleh
 *   "dipastikan" lewat riwayat SALES-RECEIPT (review S7-1b, 12 Okt 2026): tidak ada panggilan sales-receipt/*, tidak ada
 *   "TERKONFIRMASI HISTORI", setiap baris = TIDAK DIKETAHUI di Excel log. Umpan: riwayat sales-receipt tiruan yang fakturnya
 *   cocok dengan baris (dulu = dikira sudah tersimpan).
 * Caller: Playwright lokal, server `LOCAL_AUTH_BYPASS=true` (izin admin, tanpa DB):
 *   `PLAYWRIGHT_BASE_URL=http://localhost:<port> npx playwright test tests/fiori-konsol-riwayat.spec.ts --workers=1`.
 * Dependensi: /api/auth/accurate-session dan /api/proxy di-mock page.route (tidak menyentuh Accurate).
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page } from "@playwright/test";
import * as XLSX from "xlsx";

test.setTimeout(150_000); // kompilasi dev pertama /api-wrapper bisa > 30 dtk

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const AKTIF = { ok: true, connected: true, databaseConnected: true, sessionHost: "https://contoh.accurate.id", databaseId: "77", databaseAlias: "PT CONTOH" };
const TANGGAL = "12/10/2026";
const faktur = (i: number) => [{ invoiceNo: `INV/A/00${i}`, paymentAmount: 1000 * i }];

async function kirim504(page: Page, routeKey: string, tulis: string, rows: Array<Record<string, unknown>>) {
    const proxy: string[] = [];
    await page.route((u) => u.pathname === "/api/auth/accurate-session", (r) => r.fulfill(json(AKTIF)));
    await page.route((u) => u.pathname === "/api/proxy", (r) => {
        const { endpointPath, payload } = r.request().postDataJSON() as { endpointPath: string; payload: Record<string, unknown> };
        proxy.push(endpointPath);
        if (endpointPath === tulis) return r.fulfill(json({ error: "Gateway Timeout" }, 504));
        // Umpan: pelunasan Accurate bertanggal sama yang faktur+nominalnya sama dengan baris — BUKAN jenis dokumen yang dikirim
        // (baris tanpa customerNo = filter pelanggan kosong = semua pelunasan tanggal itu).
        if (endpointPath === "/api/sales-receipt/list.do") return r.fulfill(json({ s: true, d: [{ id: 1 }, { id: 2 }], sp: { pageCount: 1 } }));
        if (endpointPath === "/api/sales-receipt/detail.do") {
            return r.fulfill(json({ s: true, d: { number: `SR-UMPAN-${payload.id}`, transDate: TANGGAL, detailInvoice: faktur(Number(payload.id)) } }));
        }
        return r.fulfill(json({ s: false, d: [`tak terduga: ${endpointPath}`] }));
    });
    await page.goto("/api-wrapper", { timeout: 90_000 });
    await page.locator("select").first().selectOption(routeKey);
    await page.locator("textarea").fill(JSON.stringify(rows));
    const unduh = page.waitForEvent("download", { timeout: 20_000 }).catch(() => null);
    await page.getByRole("button", { name: "Eksekusi Endpoint" }).click();
    await expect(page.getByText(/Selesai dengan|Digabung dari beberapa request otomatis/).first()).toBeVisible({ timeout: 30_000 });
    const d = await unduh; // Excel log hanya diunduh bila ada tahap gagal; tanpa unduhan = semua baris dianggap berhasil.
    const log = d ? XLSX.utils.sheet_to_json<Record<string, string>>(XLSX.readFile(await d.path()).Sheets["Error Log"]) : [];
    const status = d ? log.map((x) => x.Status) : ["(tanpa Excel log: semua baris dihitung terposting)"];
    // Konfirmasi riwayat tampil di log respons (`_confirmedFromHistory`) atau Excel ("BERHASIL (TERKONFIRMASI HISTORI ACCURATE)").
    const terkonfirmasi = /_confirmedFromHistory|TERKONFIRMASI/.test(await page.locator("body").innerText()) || status.some((x) => x.includes("TERKONFIRMASI"));
    return { proxy, status, terkonfirmasi };
}

test("retur 504: tidak memanggil riwayat sales-receipt, baris tetap TIDAK DIKETAHUI", async ({ page }) => {
    const rows = [1, 2].map((i) => ({ customerNo: `PELANGGAN-${i}`, transDate: TANGGAL, returnType: "INVOICE", detailItem: [{ itemNo: "BARANG-A", quantity: 1 }] }));
    const r = await kirim504(page, "salesReturnBulkSave", "/api/sales-return/bulk-save.do", rows);
    expect.soft(r.proxy.filter((p) => p.includes("sales-receipt"))).toEqual([]);
    expect.soft(r.terkonfirmasi).toBe(false);
    expect(r.status).toEqual(["TIDAK DIKETAHUI (cek Accurate sebelum kirim ulang)", "TIDAK DIKETAHUI (cek Accurate sebelum kirim ulang)"]);
});

test("pembayaran pembelian 504 + riwayat sales-receipt yang fakturnya cocok: TIDAK boleh TERKONFIRMASI", async ({ page }) => {
    const rows = [1, 2].map((i) => ({ vendorNo: `PEMASOK-${i}`, transDate: TANGGAL, bankNo: "KAS-A", chequeAmount: 1000 * i, detailInvoice: faktur(i) }));
    const r = await kirim504(page, "purchasePaymentBulkSave", "/api/purchase-payment/bulk-save.do", rows);
    expect.soft(r.proxy.filter((p) => p.includes("sales-receipt"))).toEqual([]);
    expect.soft(r.terkonfirmasi, "baris dipastikan dari riwayat sales-receipt").toBe(false);
    expect(r.status).toEqual(["TIDAK DIKETAHUI (cek Accurate sebelum kirim ulang)", "TIDAK DIKETAHUI (cek Accurate sebelum kirim ulang)"]);
});
