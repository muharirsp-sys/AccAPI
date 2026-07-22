import { expect, test } from "@playwright/test";
import * as XLSX from "xlsx";

const QA_EMAIL = "qa.admin@local.test";
const QA_PASSWORD = "Admin123!";
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

test("shows the available reconciliation types without fake controls", async ({
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
  await expect(current.getByText("Aktif", { exact: true })).toBeVisible();
  await expect(types.getByText("Pembelian", { exact: true })).toBeVisible();
  await expect(types.getByText("Return", { exact: true })).toBeVisible();
  await expect(types.getByText("Belum aktif", { exact: true })).toHaveCount(2);
  await expect(types.getByRole("button")).toHaveCount(0);
  await expect(types.getByRole("link")).toHaveCount(0);
  await expect(types.locator('[tabindex]:not([tabindex="-1"])')).toHaveCount(0);
  expect(
    await types
      .getByText("Pembelian", { exact: true })
      .locator("..")
      .evaluate((element) => (element as HTMLElement).tabIndex),
  ).toBe(-1);
  expect(
    await types
      .getByText("Return", { exact: true })
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
