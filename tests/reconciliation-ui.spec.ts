import { expect, test } from "@playwright/test";

const QA_EMAIL = "qa.admin@local.test";
const QA_PASSWORD = "Admin123!";
const xlsx = (name: string) => ({
  name,
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  buffer: Buffer.from("PK\u0003\u0004"),
});

const summary = {
  MATCH: 1, QTY_MISMATCH: 0, VALUE_MISMATCH: 0, QTY_AND_VALUE_MISMATCH: 1,
  MISSING_INTERNAL: 0, MISSING_PRINCIPAL: 0, UNMAPPED_SKU: 0,
  UNIT_CONVERSION_ERROR: 0, INVALID_DATA: 0,
};
const result = {
  accurateLines: [], kinoLines: [], summary,
  results: [
    { orderNumber: "1671-SOP-260000001", internalProductCode: "KINO-OK", transactionClass: "NORMAL", accurateQuantity: 5, principalQuantity: 5, quantityDifference: 0, accurateNet: 100000, principalNet: 100000, valueDifference: 0, status: "MATCH", warnings: [], accurateSourceRows: [2], principalSourceRows: [5] },
    { orderNumber: "1671-SOP-260000002", internalProductCode: "KINO-DIFF", transactionClass: "NORMAL", accurateQuantity: 3, principalQuantity: 6, quantityDifference: -3, accurateNet: 60000, principalNet: 120000, valueDifference: -60000, status: "QTY_AND_VALUE_MISMATCH", warnings: ["Periksa jumlah dan nilai"], accurateSourceRows: [3], principalSourceRows: [6] },
  ],
};

test("shows the progressive KINO reconciliation workflow", async ({ page, baseURL }) => {
  const login = await page.request.post("/api/auth/sign-in/email", {
    headers: { Origin: baseURL || "http://localhost:3001" },
    data: { email: QA_EMAIL, password: QA_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();

  await page.goto("/reconciliation");
  await expect(page.getByLabel("Rincian Faktur Penjualan (Accurate)")).toBeVisible();
  await expect(page.getByLabel("Sales Detail KINO")).toBeVisible();
  await expect(page.getByRole("button", { name: "Jalankan rekonsiliasi" })).toBeDisabled();
  await expect(page.getByLabel("Ringkasan hasil")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Hasil rekonsiliasi" })).toHaveCount(0);

  await page.route("**/api/reconciliation/kino/sales", route => route.fulfill({ json: result }));
  await page.getByLabel("Rincian Faktur Penjualan (Accurate)").setInputFiles(xlsx("accurate.xlsx"));
  await page.getByLabel("Sales Detail KINO").setInputFiles(xlsx("kino.xlsx"));
  await page.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();

  await expect(page.getByLabel("Ringkasan hasil")).toContainText("Total");
  await expect(page.getByLabel("Ringkasan hasil")).toContainText("Bermasalah");
  await expect(page.locator("tbody").getByText("Selisih jumlah dan nilai", { exact: true })).toBeVisible();
  await expect(page.getByText("QTY_AND_VALUE_MISMATCH", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Kelas transaksi" })).toHaveCount(0);
  await expect(page.getByText(/baris dipilih/)).toHaveCount(0);
  await page.getByLabel("Filter status").selectOption("INVALID_DATA");
  await expect(page.getByText("Tidak ada hasil untuk filter ini.")).toBeVisible();
  await expect(page.getByText("Halaman 1 dari 0")).toHaveCount(0);

  await page.unroute("**/api/reconciliation/kino/sales");
  await page.reload();
  await page.route("**/api/reconciliation/kino/sales", route => route.fulfill({ status: 422, json: { error: "Header wajib tidak ditemukan." } }));
  await page.getByLabel("Rincian Faktur Penjualan (Accurate)").setInputFiles(xlsx("accurate.xlsx"));
  await page.getByLabel("Sales Detail KINO").setInputFiles(xlsx("kino.xlsx"));
  await page.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Header wajib tidak ditemukan." })).toHaveText("Header wajib tidak ditemukan.");
});
