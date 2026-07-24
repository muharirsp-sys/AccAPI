import { expect, test } from "@playwright/test";
import * as XLSX from "xlsx";

const requiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} wajib diatur untuk tes UI rekonsiliasi.`);
  return value;
};
const QA_EMAIL = requiredEnv("PLAYWRIGHT_AUTH_EMAIL");
const QA_PASSWORD = requiredEnv("PLAYWRIGHT_AUTH_PASSWORD");
const xlsx = (name: string) => ({
  name,
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  buffer: Buffer.from("PK\u0003\u0004"),
});

const csv = (name: string) => ({
  name,
  mimeType: "text/csv",
  buffer: Buffer.from("Invoice Number,Product Code\nTI125941,8710908712345"),
});
const summary = {
  MATCH: 1,
  QTY_MISMATCH: 0,
  VALUE_MISMATCH: 0,
  QTY_AND_VALUE_MISMATCH: 1,
  MISSING_INTERNAL: 0,
  MISSING_PRINCIPAL: 0,
  UNMAPPED_SKU: 0,
  UNIT_CONVERSION_ERROR: 0,
  INVALID_DATA: 0,
};
const result = {
  accurateLines: [],
  kinoLines: [],
  summary,
  results: [
    {
      orderNumber: "1671-SOP-260000001",
      internalProductCode: "KINO-OK",
      transactionClass: "NORMAL",
      accurateQuantity: 5,
      principalQuantity: 5,
      quantityDifference: 0,
      accurateNet: 100000,
      principalNet: 100000,
      valueDifference: 0,
      status: "MATCH",
      warnings: [],
      accurateSourceRows: [2],
      principalSourceRows: [5],
      amountDifferences: [],
    },
    {
      orderNumber: "1671-SOP-260000002",
      internalProductCode: "KINO-DIFF",
      transactionClass: "NORMAL",
      accurateQuantity: 3,
      principalQuantity: 6,
      quantityDifference: -3,
      accurateNet: 60000,
      principalNet: 120000,
      valueDifference: -60000,
      status: "QTY_AND_VALUE_MISMATCH",
      warnings: ["Periksa jumlah dan nilai"],
      accurateSourceRows: [3],
      principalSourceRows: [6],
      amountDifferences: [
        { component: "net", accurate: 60000, kino: 120000, difference: -60000 },
      ],
    },
  ],
};

const returnSummary = { MATCH: 1, QTY_MISMATCH: 1, VALUE_MISMATCH: 1, QTY_AND_VALUE_MISMATCH: 0, MISSING_ACCURATE: 0, MISSING_PRINCIPAL: 0, UNMAPPED: 0, INVALID_DATA: 0 };
const returnResult = {
  accurateLines: [], principalLines: [], summary: returnSummary,
  results: [
    { invoiceNumber: "INVGTS2505-0098-00876", customerCode: "CUST-01", accurateProductCode: "ACC-01", principalProductCode: "SHZ-01", accurateQuantity: 2, principalQuantity: 2, quantityDifference: 0, accurateDpp: 50000, principalDpp: 50000, dppDifference: 0, accurateTax: 5500, principalTax: 5500, accurateTotal: 55500, principalTotal: 55500, status: "MATCH", warnings: [], accurateSourceRows: [2], principalSourceRows: [4] },
    { invoiceNumber: "INVGTS2505-0098-00877", customerCode: "CUST-02", accurateProductCode: "ACC-02", principalProductCode: "SHZ-02", accurateQuantity: 3, principalQuantity: 5, quantityDifference: -2, accurateDpp: 60000, principalDpp: 60000.5, dppDifference: -0.5, accurateTax: 6600, principalTax: 6600.05, accurateTotal: 66600, principalTotal: 66600.55, status: "QTY_MISMATCH", warnings: ["QTY MISMATCH"], accurateSourceRows: [3], principalSourceRows: [5] },
    { invoiceNumber: "INVGTS2505-0098-00878", customerCode: "CUST-03", accurateProductCode: "ACC-03", principalProductCode: "SHZ-03", accurateQuantity: 1, principalQuantity: 1, quantityDifference: 0, accurateDpp: 60000, principalDpp: 90000, dppDifference: -30000, accurateTax: 6600, principalTax: 9900, accurateTotal: 66600, principalTotal: 99900, status: "VALUE_MISMATCH", warnings: ["VALUE MISMATCH"], accurateSourceRows: [6], principalSourceRows: [8] },
  ],
};
test("shows the available reconciliation types while Pembelian stays inactive", async ({
  page,
  baseURL,
}) => {
  const login = await page.request.post("/api/auth/sign-in/email", {
    headers: { Origin: baseURL || "http://localhost:3000" },
    data: { email: QA_EMAIL, password: QA_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();

  await page.goto("/reconciliation");
  const types = page.getByRole("region", { name: "Jenis Rekonsiliasi" });
  const current = types.locator('[aria-current="page"]');

  await expect(types).toBeVisible();
  await expect(current.getByText("Faktur", { exact: true })).toBeVisible();
  await expect(types.getByText("Pembelian", { exact: true })).toBeVisible();
  await expect(types.getByText("Return", { exact: true })).toBeVisible();
  await expect(types.getByText("Belum aktif", { exact: true })).toHaveCount(1);
  await expect(types.getByRole("button", { name: "Faktur" })).toBeVisible();
  await expect(types.getByRole("button", { name: "Return" })).toBeVisible();
  await expect(types.getByRole("button", { name: "Faktur" })).toHaveAttribute("aria-pressed", "true");
  await expect(types.getByRole("button", { name: "Return" })).toHaveAttribute("aria-pressed", "false");
  await expect(types.getByRole("button")).toHaveCount(2);
  await expect(types.getByRole("link")).toHaveCount(0);
  expect(
    await types
      .getByText("Pembelian", { exact: true })
      .locator("..")
      .evaluate((element) => (element as HTMLElement).tabIndex),
  ).toBe(-1);
  const themes = [
    ["Office Calm", "office-calm"],
    ["Neon HUD", "neon"],
    ["iOS Liquid Glass", "ios"],
  ] as const;

  const themeToggle = page.getByRole("button", { name: "Ganti tema" });
  for (const [label, key] of themes) {
    await expect(async () => {
      await themeToggle.click();
      expect(await themeToggle.getAttribute("aria-expanded")).toBe("true");
    }).toPass({ timeout: 10_000 });
    await page.getByRole("button", { name: new RegExp(label) }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", key);
    await expect(types).toBeVisible();
  }

  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await types.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});

test("runs SHINZUI Return reconciliation with focused issues and export", async ({ page, baseURL }) => {
  const login = await page.request.post("/api/auth/sign-in/email", { headers: { Origin: baseURL || "http://localhost:3000" }, data: { email: QA_EMAIL, password: QA_PASSWORD } });
  expect(login.ok()).toBeTruthy();
  await page.goto("/reconciliation");
  await page.route("**/api/reconciliation/kino/sales", (route) => route.fulfill({ status: 422, json: { error: "Kesalahan Faktur lama." } }));
  await page.getByLabel("Rincian Faktur Penjualan (Accurate)").setInputFiles(xlsx("accurate-old.xlsx"));
  await page.getByLabel("Sales Detail KINO").setInputFiles(xlsx("kino-old.xlsx"));
  await page.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();
  await expect(page.locator('p[role="alert"]')).toHaveText("Kesalahan Faktur lama.");
  await page.getByRole("button", { name: "Return" }).click();
  await expect(page.locator('p[role="alert"]')).toHaveCount(0);
  await expect(page.getByText("Belum ada file dipilih")).toHaveCount(2);
  await expect(page.getByLabel("Ringkasan hasil")).toHaveCount(0);
  await expect(page.getByLabel("Prinsipal")).toHaveValue("SHINZUI");
  await expect(page.getByLabel("Prinsipal")).toBeEnabled();
  await expect(page.getByLabel("Retur Penjualan (Accurate)")).toBeVisible();
  await expect(page.getByLabel("PenjualanInvoice SHINZUI")).toBeVisible();
  let returnCalled = false;
  await page.route("**/api/reconciliation/shinzui/returns", async (route) => {
    returnCalled = true;
    expect(route.request().method()).toBe("POST");
    const body = await route.request().postDataBuffer();
    expect(body?.toString()).toContain('name="accurateFile"');
    expect(body?.toString()).toContain('name="principalFile"');
    await route.fulfill({ json: returnResult });
  });
  await page.getByLabel("Retur Penjualan (Accurate)").setInputFiles(xlsx("accurate-return.xlsx"));
  await page.getByLabel("PenjualanInvoice SHINZUI").setInputFiles(xlsx("penjualan-invoice.xlsx"));
  await page.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();
  expect(returnCalled).toBe(true);
  await expect(page.getByLabel("Filter status")).toHaveValue("ISSUES_ONLY");
  await expect(page.getByText("INVGTS2505-0098-00877", { exact: true })).toBeVisible();
  await expect(page.getByText("CUST-02", { exact: true })).toBeVisible();
  await expect(page.getByText("ACC-02 / SHZ-02", { exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Pajak Accurate" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Pajak SHINZUI" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Total Accurate" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Total SHINZUI" })).toBeVisible();
  await expect(page.getByText("Qty: Accurate 3, SHINZUI 5 — Accurate kurang 2", { exact: true })).toBeVisible();
  await expect(page.getByText("DPP: Accurate Rp60.000, SHINZUI Rp60.000,5 — Accurate kurang Rp0,5", { exact: true })).toHaveCount(0);
  await expect(page.getByText("DPP: Accurate Rp60.000, SHINZUI Rp90.000 — Accurate kurang Rp30.000", { exact: true })).toBeVisible();
  const search = page.getByLabel("Cari tabel");
  await search.fill("SHZ-02");
  await expect(page.getByText("INVGTS2505-0098-00877", { exact: true })).toBeVisible();
  await search.fill("ACC-02");
  await expect(page.getByText("INVGTS2505-0098-00877", { exact: true })).toBeVisible();
  await search.fill("");
  await page.getByRole("button", { name: "Return" }).click();
  await expect(page.getByText("accurate-return.xlsx", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Ringkasan hasil")).toBeVisible();
  await expect(page.getByRole("button", { name: "Return" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("INVGTS2505-0098-00876", { exact: true })).toHaveCount(0);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Ekspor XLSX" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^hasil-rekonsiliasi-return-shinzui-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const returnWorkbook = XLSX.readFile(downloadPath!);
  const returnDetail = XLSX.utils.sheet_to_json<Record<string, number>>(returnWorkbook.Sheets.Detail);
  expect(returnDetail[1]).toMatchObject({
    "Pajak Accurate": 6600,
    "Pajak SHINZUI": 6600.05,
    "Total Accurate": 66600,
    "Total SHINZUI": 66600.55,
  });
  await page.getByRole("button", { name: "Faktur" }).click();
  await expect(page.getByLabel("Prinsipal")).toHaveValue("KINO");
  await expect(page.getByLabel("Prinsipal")).toBeEnabled();
  await expect(page.getByText("Belum ada file dipilih")).toHaveCount(2);
  await expect(page.getByLabel("Ringkasan hasil")).toHaveCount(0);
  await expect(page.getByText("Pembelian", { exact: true }).locator("..")).toContainText("Belum aktif");
});
test("runs KINO Return reconciliation and resets when switching principal", async ({ page, baseURL }) => {
  const login = await page.request.post("/api/auth/sign-in/email", { headers: { Origin: baseURL || "http://localhost:3000" }, data: { email: QA_EMAIL, password: QA_PASSWORD } });
  expect(login.ok()).toBeTruthy();
  await page.goto("/reconciliation");
  await page.getByRole("button", { name: "Return" }).click();

  await expect(page.getByLabel("Prinsipal").locator('option[value="SHINZUI"]')).toHaveText("SHINZUI");
  await page.getByLabel("Prinsipal").selectOption("KINO");
  await expect(page.getByLabel("Sales Detail KINO")).toBeVisible();

  const kinoReturnResult = {
    ...returnResult,
    summary: { ...returnSummary, UNMAPPED: 2, INVALID_DATA: 1 },
    results: [
      ...returnResult.results,
      {
        ...returnResult.results[1],
        invoiceNumber: "BAD-REM",
        accurateProductCode: "ACC-BAD",
        principalProductCode: null,
        accurateQuantity: 9,
        principalQuantity: 0,
        quantityDifference: 9,
        accurateDpp: 90000,
        principalDpp: 0,
        dppDifference: 90000,
        status: "INVALID_DATA",
        invalidReason: "REM tidak memuat nomor invoice KINO 1671-SRI.",
      },
      {
        ...returnResult.results[1],
        invoiceNumber: "UNMAPPED-KINO",
        accurateProductCode: null,
        principalProductCode: "KINO-RAW",
        status: "UNMAPPED",
        invalidReason: null,
      },
      {
        ...returnResult.results[1],
        invoiceNumber: "UNMAPPED-ACCURATE",
        accurateProductCode: "ACC-RAW",
        principalProductCode: null,
        status: "UNMAPPED",
        invalidReason: null,
      },
    ],
  };
  let returnCalled = false;
  await page.route("**/api/reconciliation/kino/returns", async (route) => {
    returnCalled = true;
    expect(route.request().method()).toBe("POST");
    await route.fulfill({ json: kinoReturnResult });
  });
  await page.getByLabel("Retur Penjualan (Accurate)").setInputFiles(xlsx("accurate-kino-return.xlsx"));
  await page.getByLabel("Sales Detail KINO").setInputFiles(xlsx("kino-return.xlsx"));
  await page.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();

  expect(returnCalled).toBe(true);
  await expect(page.getByLabel("Filter status")).toHaveValue("ISSUES_ONLY");
  await expect(page.getByText("INVGTS2505-0098-00877", { exact: true })).toBeVisible();
  await expect(page.getByText("INVGTS2505-0098-00876", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Pajak KINO" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Total KINO" })).toBeVisible();
  await expect(page.getByText("REM tidak memuat nomor invoice KINO 1671-SRI.", { exact: true })).toBeVisible();
  await expect(page.getByText("Produk KINO-RAW belum memiliki mapping Accurate.", { exact: true })).toBeVisible();
  await expect(page.getByText("Produk ACC-RAW belum memiliki mapping KINO.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Qty: Accurate 9, KINO 0/)).toHaveCount(0);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Ekspor XLSX" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^rekonsiliasi-return-kino-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const workbook = XLSX.readFile(downloadPath!);
  const detail = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets.Detail);
  expect(detail[1]).toMatchObject({
    "Produk KINO": "SHZ-02",
    "Pajak KINO": 6600.05,
    "Total KINO": 66600.55,
    "Penyebab selisih": "Qty: Accurate 3, KINO 5 — Accurate kurang 2",
    "Baris KINO": "5",
  });
  expect(detail.find((row) => row.Invoice === "BAD-REM")).toMatchObject({
    "Penyebab selisih": "REM tidak memuat nomor invoice KINO 1671-SRI.",
  });
  expect(detail.find((row) => row.Invoice === "UNMAPPED-KINO")).toMatchObject({
    "Penyebab selisih": "Produk KINO-RAW belum memiliki mapping Accurate.",
  });
  expect(detail.find((row) => row.Invoice === "UNMAPPED-ACCURATE")).toMatchObject({
    "Penyebab selisih": "Produk ACC-RAW belum memiliki mapping KINO.",
  });

  await expect(page.getByLabel("Ringkasan hasil")).toBeVisible();
  await page.getByLabel("Prinsipal").selectOption("SHINZUI");
  await expect(page.getByLabel("PenjualanInvoice SHINZUI")).toBeVisible();
  await expect(page.getByText("Belum ada file dipilih")).toHaveCount(2);
  await expect(page.getByLabel("Ringkasan hasil")).toHaveCount(0);
  await expect(page.getByText("INVGTS2505-0098-00877", { exact: true })).toHaveCount(0);

  await page.getByLabel("Prinsipal").selectOption("KINO");
  await page.unroute("**/api/reconciliation/kino/returns");
  await page.route("**/api/reconciliation/kino/returns", (route) => route.fulfill({ status: 422, json: { error: "Kesalahan Return KINO lama." } }));
  await page.getByLabel("Retur Penjualan (Accurate)").setInputFiles(xlsx("accurate-kino-error.xlsx"));
  await page.getByLabel("Sales Detail KINO").setInputFiles(xlsx("kino-error.xlsx"));
  await page.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();
  await expect(page.locator('p[role="alert"]')).toHaveText("Kesalahan Return KINO lama.");
  await page.getByLabel("Prinsipal").selectOption("SHINZUI");
  await expect(page.getByLabel("PenjualanInvoice SHINZUI")).toBeVisible();
  await expect(page.getByText("Belum ada file dipilih")).toHaveCount(2);
  await expect(page.locator('p[role="alert"]')).toHaveCount(0);
});
test("shows the progressive reconciliation workflow", async ({
  page,
  baseURL,
}) => {
  const login = await page.request.post("/api/auth/sign-in/email", {
    headers: { Origin: baseURL || "http://localhost:3001" },
    data: { email: QA_EMAIL, password: QA_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();

  await page.goto("/reconciliation");
  await expect(
    page.getByLabel("Rincian Faktur Penjualan (Accurate)"),
  ).toBeVisible();
  await expect(page.getByLabel("Sales Detail KINO")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Jalankan rekonsiliasi" }),
  ).toBeDisabled();
  await expect(page.getByLabel("Ringkasan hasil")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Hasil rekonsiliasi" }),
  ).toHaveCount(0);

  await page.route("**/api/reconciliation/kino/sales", (route) =>
    route.fulfill({ json: result }),
  );
  await page
    .getByLabel("Rincian Faktur Penjualan (Accurate)")
    .setInputFiles(xlsx("accurate.xlsx"));
  await page.getByLabel("Sales Detail KINO").setInputFiles(xlsx("kino.xlsx"));
  await page.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();

  await expect(page.getByLabel("Ringkasan hasil")).toContainText("Total");
  await expect(page.getByLabel("Ringkasan hasil")).toContainText("Bermasalah");
  await expect(
    page
      .locator("tbody")
      .getByText("Selisih jumlah dan nilai", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("QTY_AND_VALUE_MISMATCH", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("columnheader", { name: "Kelas transaksi" }),
  ).toHaveCount(0);
  await expect(page.getByText(/baris dipilih/)).toHaveCount(0);
  await expect(page.getByLabel("Filter status")).toHaveValue("ISSUES_ONLY");
  await expect(
    page.getByRole("heading", { name: "Temuan yang perlu diperiksa" }),
  ).toBeVisible();
  await expect(
    page.getByText("Menampilkan 1 bermasalah dari 2 hasil."),
  ).toBeVisible();
  await expect(page.getByText("KINO-OK", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Jumlah: Accurate 3, KINO 6 — Accurate kurang 3", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Nilai bersih: Accurate Rp60.000, KINO Rp120.000 — Accurate kurang Rp60.000",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Accurate: 3 · KINO: 6", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Filter status").selectOption("ALL");
  await expect(page.getByText("KINO-OK", { exact: true })).toBeVisible();
  await page.getByLabel("Filter status").selectOption("INVALID_DATA");
  await expect(
    page.getByText("Tidak ada hasil untuk filter ini."),
  ).toBeVisible();
  await expect(page.getByText("Halaman 1 dari 0")).toHaveCount(0);

  await page.getByRole("button", { name: "Tema" }).click();
  await page.getByRole("button", { name: /Office Calm/ }).click();
  const tableSearch = page.getByLabel("Cari tabel");
  const searchWrapper = tableSearch.locator("xpath=..");
  const baselineOutline = await searchWrapper.evaluate(
    (element) => window.getComputedStyle(element).outlineStyle,
  );
  await tableSearch.focus();
  const focusedOutline = await searchWrapper.evaluate(
    (element) => window.getComputedStyle(element).outlineStyle,
  );
  expect(focusedOutline).not.toBe(baselineOutline);
  expect(focusedOutline).not.toBe("none");

  await page.unroute("**/api/reconciliation/kino/sales");
  await page.reload();
  await page.route("**/api/reconciliation/kino/sales", (route) =>
    route.fulfill({
      json: {
        ...result,
        summary: { ...summary, MATCH: 1, QTY_AND_VALUE_MISMATCH: 0 },
        results: [result.results[0]],
      },
    }),
  );
  await page
    .getByLabel("Rincian Faktur Penjualan (Accurate)")
    .setInputFiles(xlsx("accurate.xlsx"));
  await page.getByLabel("Sales Detail KINO").setInputFiles(xlsx("kino.xlsx"));
  await page.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();
  await expect(page.getByLabel("Filter status")).toHaveValue("ALL");
  await expect(
    page.getByRole("heading", { name: "Semua data cocok" }),
  ).toBeVisible();
  await expect(page.getByText("Seluruh 1 data cocok.")).toBeVisible();

  await page.unroute("**/api/reconciliation/kino/sales");
  await page.reload();
  await page.route("**/api/reconciliation/kino/sales", (route) =>
    route.fulfill({
      status: 422,
      json: { error: "Header wajib tidak ditemukan." },
    }),
  );
  await page
    .getByLabel("Rincian Faktur Penjualan (Accurate)")
    .setInputFiles(xlsx("accurate.xlsx"));
  await page.getByLabel("Sales Detail KINO").setInputFiles(xlsx("kino.xlsx"));
  await page.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Header wajib tidak ditemukan." }),
  ).toHaveText("Header wajib tidak ditemukan.");

  await page.reload();
  await page.getByLabel("Prinsipal").selectOption("GODREJ");
  await expect(
    page.getByText(
      "Bandingkan faktur Accurate dengan data penjualan prinsipal GODREJ.",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Sales Detail GODREJ")).toBeVisible();
  await expect(page.getByLabel("Sales Detail KINO")).toHaveCount(0);
  await page.route("**/api/reconciliation/godrej/sales", (route) =>
    route.fulfill({ json: result }),
  );
  await page
    .getByLabel("Rincian Faktur Penjualan (Accurate)")
    .setInputFiles(xlsx("accurate.xlsx"));
  await page.getByLabel("Sales Detail GODREJ").setInputFiles(xlsx("gdi.xlsx"));
  await page.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();
  await expect(
    page.getByText("Accurate: 3 · GODREJ: 6", { exact: true }),
  ).toBeVisible();

  await page.reload();
  await page.getByLabel("Prinsipal").selectOption("SHINZUI");
  await expect(
    page.getByText(
      "Bandingkan faktur Accurate dengan data penjualan prinsipal SHINZUI.",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Sales Detail SHINZUI")).toBeVisible();
  await expect(page.getByLabel("Sales Detail KINO")).toHaveCount(0);
  await page.route("**/api/reconciliation/shinzui/sales", (route) =>
    route.fulfill({ json: result }),
  );
  await page
    .getByLabel("Rincian Faktur Penjualan (Accurate)")
    .setInputFiles(xlsx("accurate.xlsx"));
  await page
    .getByLabel("Sales Detail SHINZUI")
    .setInputFiles(xlsx("shinzui.xlsx"));
  await page.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();
  await expect(
    page.getByText("Accurate: 3 · SHINZUI: 6", { exact: true }),
  ).toBeVisible();

  await page.reload();
  await page.getByLabel("Prinsipal").selectOption("MOTASA");
  await expect(
    page.getByText(
      "Bandingkan faktur Accurate dengan data penjualan prinsipal MOTASA.",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Sales Detail MOTASA")).toBeVisible();
  await expect(page.getByLabel("Sales Detail SHINZUI")).toHaveCount(0);
  await page.route("**/api/reconciliation/motasa/sales", (route) =>
    route.fulfill({ json: result }),
  );
  await page
    .getByLabel("Rincian Faktur Penjualan (Accurate)")
    .setInputFiles(xlsx("accurate.xlsx"));
  await page
    .getByLabel("Sales Detail MOTASA")
    .setInputFiles(xlsx("motasa.xlsx"));
  await page.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();
  await expect(
    page.getByText("Accurate: 3 · MOTASA: 6", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Filter status")).toHaveValue("ISSUES_ONLY");
  await expect(
    page.getByText("Jumlah: Accurate 3, MOTASA 6 — Accurate kurang 3", {
      exact: true,
    }),
  ).toBeVisible();

  await page.reload();
  await expect(
    page.getByLabel("Prinsipal").locator('option[value="CUSSONS"]'),
  ).toHaveText("CUSSONS");
  await page.getByLabel("Prinsipal").selectOption("CUSSONS");
  const cussonsFile = page.getByLabel("Detail CUSSONS");
  await expect(cussonsFile).toHaveAttribute("accept", /\.csv/);
  await expect(page.getByText("Format .csv, maksimal 10 MB")).toBeVisible();
  await expect(
    page.getByLabel("Rincian Faktur Penjualan (Accurate)"),
  ).toHaveAttribute(
    "accept",
    ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  await expect(
    page.getByRole("button", { name: "Jalankan rekonsiliasi" }),
  ).toBeDisabled();
  await page
    .getByLabel("Rincian Faktur Penjualan (Accurate)")
    .setInputFiles(xlsx("accurate.xlsx"));
  await expect(
    page.getByRole("button", { name: "Jalankan rekonsiliasi" }),
  ).toBeDisabled();
  await cussonsFile.setInputFiles(csv("detail.csv"));
  await expect(
    page.getByRole("button", { name: "Jalankan rekonsiliasi" }),
  ).toBeEnabled();
  await page.getByLabel("Prinsipal").selectOption("GODREJ");
  await expect(page.getByText("Belum ada file dipilih")).toHaveCount(2);
  await page
    .getByLabel("Sales Detail GODREJ")
    .setInputFiles(xlsx("gdi.xlsx"));
  await expect(
    page.getByRole("button", { name: "Jalankan rekonsiliasi" }),
  ).toBeDisabled();
  await page.getByLabel("Prinsipal").selectOption("CUSSONS");
  await page
    .getByLabel("Rincian Faktur Penjualan (Accurate)")
    .setInputFiles(xlsx("accurate.xlsx"));
  await page.getByLabel("Detail CUSSONS").setInputFiles(csv("detail.csv"));
  const cussonsResult = {
    ...result,
    summary: { ...summary, QTY_AND_VALUE_MISMATCH: 0, MISSING_PRINCIPAL: 1 },
    results: [
      result.results[0],
      {
        ...result.results[1],
        orderNumber: "TI125941",
        internalProductCode: "CUSSONS-DIFF",
        principalQuantity: 0,
        principalNet: 0,
        status: "MISSING_PRINCIPAL",
        warnings: [],
        amountDifferences: [],
      },
    ],
  };
  await page.route("**/api/reconciliation/cussons/sales", (route) =>
    route.fulfill({ json: cussonsResult }),
  );
  await page.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();
  await expect(page.getByLabel("Filter status")).toHaveValue("ISSUES_ONLY");
  await expect(page.getByText("TI125941", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Data tidak ditemukan di CUSSONS.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("KINO-OK", { exact: true })).toHaveCount(0);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Ekspor XLSX" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^hasil-rekonsiliasi-cussons-\d{4}-\d{2}-\d{2}\.xlsx$/,
  );
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const workbook = XLSX.readFile(downloadPath!);
  const detail = XLSX.utils.sheet_to_json<{ Order: string }>(
    workbook.Sheets.Detail,
  );
  expect(detail.map((row) => row.Order)).toEqual([
    "1671-SOP-260000001",
    "TI125941",
  ]);
  await page.getByLabel("Filter status").selectOption("ALL");
  await expect(page.getByText("KINO-OK", { exact: true })).toBeVisible();
});
