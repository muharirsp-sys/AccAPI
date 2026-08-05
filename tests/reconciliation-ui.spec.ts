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

test("uses the registry and shows mapping access plus paginated persisted history", async ({ page, baseURL }) => {
  const login = await page.request.post("/api/auth/sign-in/email", {
    headers: { Origin: baseURL || "http://localhost:3000" },
    data: { email: QA_EMAIL, password: QA_PASSWORD },
  });
  if (!login.ok()) await page.context().addCookies([{ name: "local-dev-session", value: "qa-admin", url: baseURL || "http://localhost:3000" }]);

  const historyRequests: string[] = [];
  const mapping = {
    division: "sales",
    principalCode: "KINO",
    version: 3,
    uploadedByName: "Admin Mapping",
    createdAt: "2026-08-05T02:30:00.000Z",
    isActive: true,
  };
  await page.route("**/api/reconciliation/mappings?**", async (route) => {
    const url = new URL(route.request().url());
    const requestedPrincipal = url.searchParams.get("principal")!;
    const requestedMapping = { ...mapping, id: `mapping-${requestedPrincipal.toLowerCase()}`, principalCode: requestedPrincipal, originalName: `mapping-${requestedPrincipal.toLowerCase()}.xlsx` };
    const canManage = requestedPrincipal !== "GODREJ";
    await route.fulfill({ json: { active: requestedMapping, versions: [requestedMapping, { ...requestedMapping, id: `${requestedMapping.id}-old`, version: 2, originalName: `mapping-${requestedPrincipal.toLowerCase()}-lama.xlsx`, uploadedByName: "Budi Admin", createdAt: "2026-08-01T02:30:00.000Z", isActive: false }], canManage } });
  });
  await page.route("**/api/reconciliation/history?**", async (route) => {
    const url = new URL(route.request().url());
    historyRequests.push(`${url.searchParams.get("page")}:${url.searchParams.get("pageSize")}`);
    const pageNumber = Number(url.searchParams.get("page"));
    const item = {
      id: "run-1",
      division: "sales",
      principalCode: "KINO",
      mappingVersionId: `mapping-${url.searchParams.get("principal")?.toLowerCase()}`,
      status: "success",
      uploadedByName: "Sari Faktur",
      inputFiles: [
        { role: "accurateFile", name: "accurate-agustus.xlsx" },
        { role: "principalFile", name: "kino-agustus.xlsx" },
      ],
      summary: { MATCH: 18, QTY_MISMATCH: 2 },
      issues: [{ ...result.results[1], status: "QTY_AND_VALUE_MISMATCH" }],
      error: null,
      durationMs: 1450,
      startedAt: "2026-08-05T03:00:00.000Z",
      finishedAt: "2026-08-05T03:00:01.450Z",
    };
    await route.fulfill({ json: { items: pageNumber === 1 ? Array.from({ length: 20 }, (_, index) => ({ ...item, id: `run-${index + 1}` })) : [], page: pageNumber, pageSize: 20 } });
  });

  await page.goto("/reconciliation");
  await expect(page.getByLabel("Prinsipal").locator("option")).toHaveText(["KINO", "GODREJ", "SHINZUI", "MOTASA", "CUSSONS"]);
  await page.getByRole("button", { name: "Pembelian" }).click();
  await expect(page.getByLabel("Prinsipal").locator("option")).toHaveText(["GODREJ", "RECKITT", "CUSSONS", "KINO", "FORISA"]);
  await expect(page.getByLabel("Stempel versi mapping").getByText("mapping-godrej.xlsx", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Ganti mapping")).toHaveCount(0);
  await page.getByRole("button", { name: "Return" }).click();
  await expect(page.getByLabel("Prinsipal").locator("option")).toHaveText(["SHINZUI", "KINO", "GODREJ", "HEINZ", "CUSSONS"]);
  await page.getByRole("button", { name: "Faktur" }).click();

  const mappingStatus = page.getByRole("region", { name: "Mapping aktif" });
  const mappingStamp = mappingStatus.getByLabel("Stempel versi mapping");
  await expect(mappingStamp.getByText("mapping-kino.xlsx", { exact: true })).toBeVisible();
  await expect(mappingStamp.getByText("Versi 3", { exact: true })).toBeVisible();
  await expect(mappingStamp.getByText("Admin Mapping", { exact: true })).toBeVisible();
  const mappingHistory = page.getByRole("region", { name: "Riwayat versi mapping" });
  await expect(mappingHistory.getByText("mapping-kino-lama.xlsx", { exact: true })).toBeVisible();
  await expect(mappingHistory.getByText("Budi Admin", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Ganti mapping")).toBeVisible();
  const history = page.getByRole("region", { name: "Riwayat rekonsiliasi" });
  await expect(history.getByText("Berhasil", { exact: true }).first()).toBeVisible();
  await expect(history.getByText("Sari Faktur", { exact: true }).first()).toBeVisible();
  await expect(history.getByText("Versi 3", { exact: true }).first()).toBeVisible();
  await expect(history.getByText("accurate-agustus.xlsx, kino-agustus.xlsx", { exact: true }).first()).toBeVisible();
  await expect(history.getByText("1,45 detik", { exact: true }).first()).toBeVisible();
  await expect(history.getByText("Total 20", { exact: true }).first()).toBeVisible();
  await expect(history.getByText("Cocok 18", { exact: true }).first()).toBeVisible();
  await expect(history.getByText("Masalah 2", { exact: true }).first()).toBeVisible();
  await history.locator('summary[aria-label="Lihat rincian run-1"]').click();
  await expect(history.getByText("Jumlah: Accurate 3, KINO 6 — Accurate kurang 3", { exact: true }).first()).toBeVisible();
  expect(historyRequests).toContain("1:20");
  await history.getByRole("button", { name: "Halaman berikutnya" }).click();
  await expect.poll(() => historyRequests).toContain("2:20");
});

test("runs GODREJ, RECKITT, and CUSSONS Pembelian reconciliation, resets principal state, and keeps all themes", async ({
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
  await expect(types).toBeVisible();
  await page.route("**/api/reconciliation/kino/sales", (route) =>
    route.fulfill({ status: 422, json: { error: "Kesalahan Faktur lama." } }),
  );
  await page.getByLabel("Rincian Faktur Penjualan (Accurate)").setInputFiles(xlsx("accurate-old.xlsx"));
  await page.getByLabel("Sales Detail KINO").setInputFiles(xlsx("kino-old.xlsx"));
  await page.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();
  await expect(page.locator('p[role="alert"]')).toHaveText("Kesalahan Faktur lama.");

  await types.getByRole("button", { name: "Pembelian" }).click();
  await expect(page.locator('p[role="alert"]')).toHaveCount(0);
  await expect(page.getByText("Belum ada file dipilih")).toHaveCount(2);
  await expect(page.getByLabel("Ringkasan hasil")).toHaveCount(0);
  await expect(page.getByLabel("Prinsipal")).toHaveValue("GODREJ");
  await expect(page.getByLabel("Prinsipal")).toBeEnabled();
  await expect(page.getByLabel("Prinsipal").locator('option[value="RECKITT"]')).toHaveText("RECKITT");
  await expect(page.getByLabel("Prinsipal").locator('option[value="CUSSONS"]')).toHaveText("CUSSONS");
  await expect(page.getByLabel("Rincian Faktur Pembelian (Accurate)")).toBeVisible();
  await expect(page.getByLabel("GRN Status Report GODREJ")).toBeVisible();

  let purchaseCalled = false;
  await page.route("**/api/reconciliation/godrej/purchases", async (route) => {
    purchaseCalled = true;
    expect(route.request().method()).toBe("POST");
    const body = await route.request().postDataBuffer();
    expect(body?.toString()).toContain('name="accurateFile"');
    expect(body?.toString()).toContain('name="principalFile"');
    await route.fulfill({ json: returnResult });
  });
  await page.getByLabel("Rincian Faktur Pembelian (Accurate)").setInputFiles(xlsx("accurate-purchase.xlsx"));
  await expect(page.getByLabel("GRN Status Report GODREJ")).toHaveAttribute("accept", /text\/csv/);
  await page.getByLabel("GRN Status Report GODREJ").setInputFiles(csv("grn-status.csv"));
  await page.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();
  expect(purchaseCalled).toBe(true);
  await expect(page.getByLabel("Filter status")).toHaveValue("ISSUES_ONLY");
  await expect(page.getByText("INVGTS2505-0098-00877", { exact: true })).toBeVisible();
  await expect(page.getByText("INVGTS2505-0098-00876", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Qty: Accurate 3, GODREJ 5 — Accurate kurang 2", { exact: true })).toBeVisible();

  await expect(page.getByRole("columnheader", { name: "Dokumen Pembelian" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Supplier" })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Ekspor XLSX" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^rekonsiliasi-pembelian-godrej-\d{4}-\d{2}-\d{2}\.xlsx$/,
  );

  await page.getByLabel("Prinsipal").selectOption("RECKITT");
  await expect(page.getByText("Belum ada file dipilih")).toHaveCount(2);
  await expect(page.getByLabel("Ringkasan hasil")).toHaveCount(0);
  await expect(page.getByText("INVGTS2505-0098-00877", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Bandingkan faktur pembelian Accurate dengan TXN_COMPINV_DTL RECKITT.", { exact: true })).toBeVisible();
  const reckittFile = page.getByLabel("TXN_COMPINV_DTL RECKITT");
  await expect(reckittFile).toHaveAttribute("accept", ".csv,text/csv,application/csv");
  await expect(page.getByText("Format .csv, maksimal 10 MB")).toBeVisible();

  const reckittResult = {
    ...returnResult,
    results: returnResult.results.map((row) => ({
      ...row,
      invoiceNumber: row.invoiceNumber.replace("INVGTS2505-0098-008", "21000000"),
      principalProductCode: row.principalProductCode?.replace("SHZ", "RCK"),
    })),
  };
  let reckittCalled = false;
  await page.route("**/api/reconciliation/reckitt/purchases", async (route) => {
    reckittCalled = true;
    expect(route.request().method()).toBe("POST");
    const body = (await route.request().postDataBuffer())?.toString() ?? "";
    expect(body).toContain('name="accurateFile"');
    expect(body).toContain('name="principalFile"');
    expect(body).toContain('filename="txn-compinv-dtl.csv"');
    await route.fulfill({ json: reckittResult });
  });
  await page.getByLabel("Rincian Faktur Pembelian (Accurate)").setInputFiles(xlsx("accurate-reckitt-purchase.xlsx"));
  await reckittFile.setInputFiles(csv("txn-compinv-dtl.csv"));
  await page.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();
  expect(reckittCalled).toBe(true);
  await expect(page.getByLabel("Filter status")).toHaveValue("ISSUES_ONLY");
  await expect(page.getByText("2100000077", { exact: true })).toBeVisible();
  await expect(page.getByText("2100000076", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Qty: Accurate 3, RECKITT 5 — Accurate kurang 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "DPP RECKITT" })).toBeVisible();

  const reckittDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Ekspor XLSX" }).click();
  const reckittDownload = await reckittDownloadPromise;
  expect(reckittDownload.suggestedFilename()).toMatch(
    /^rekonsiliasi-pembelian-reckitt-\d{4}-\d{2}-\d{2}\.xlsx$/,
  );

  await page.getByLabel("Prinsipal").selectOption("GODREJ");
  await expect(page.getByText("Belum ada file dipilih")).toHaveCount(2);
  await expect(page.getByLabel("Ringkasan hasil")).toHaveCount(0);
  await page.unroute("**/api/reconciliation/godrej/purchases");
  await page.route("**/api/reconciliation/godrej/purchases", (route) =>
    route.fulfill({ status: 422, json: { error: "GRN tidak valid." } }),
  );
  await page.getByLabel("Rincian Faktur Pembelian (Accurate)").setInputFiles(xlsx("accurate-invalid.xlsx"));
  await page.getByLabel("GRN Status Report GODREJ").setInputFiles(csv("grn-invalid.csv"));
  await page.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();
  await expect(page.getByRole("alert")).toHaveText("GRN tidak valid.");
  await page.getByLabel("Prinsipal").selectOption("RECKITT");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Belum ada file dipilih")).toHaveCount(2);
  await expect(page.getByLabel("Ringkasan hasil")).toHaveCount(0);

  await page.getByLabel("Prinsipal").selectOption("CUSSONS");
  await expect(page.getByLabel("Rincian Faktur Pembelian (Accurate)")).toHaveValue("");
  await expect(page.getByText("Bandingkan faktur pembelian Accurate dengan TXN_COMPINV_DTL CUSSONS.", { exact: true })).toBeVisible();
  const cussonsFile = page.getByLabel("TXN_COMPINV_DTL CUSSONS");
  await expect(cussonsFile).toHaveValue("");
  await expect(cussonsFile).toHaveAttribute("accept", ".csv,text/csv,application/csv");
  await expect(page.getByText("Format .csv, maksimal 10 MB")).toBeVisible();
  await expect(page.getByRole("button", { name: "Jalankan rekonsiliasi" })).toBeDisabled();

  const cussonsResult = {
    ...returnResult,
    results: returnResult.results.map((row) => ({
      ...row,
      invoiceNumber: row.invoiceNumber.replace("INVGTS2505-0098-008", "1100000"),
      principalProductCode: row.principalProductCode?.replace("SHZ", "CUS"),
    })),
  };
  let cussonsCalled = false;
  await page.route("**/api/reconciliation/cussons/purchases", async (route) => {
    cussonsCalled = true;
    expect(route.request().method()).toBe("POST");
    const body = (await route.request().postDataBuffer())?.toString() ?? "";
    expect(body).toContain('name="accurateFile"');
    expect(body).toContain('name="principalFile"');
    expect(body).toContain('filename="txn-compinv-dtl-cussons.csv"');
    await route.fulfill({ json: cussonsResult });
  });
  await page.getByLabel("Rincian Faktur Pembelian (Accurate)").setInputFiles(xlsx("accurate-cussons-purchase.xlsx"));
  await cussonsFile.setInputFiles(csv("txn-compinv-dtl-cussons.csv"));
  await page.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();
  expect(cussonsCalled).toBe(true);
  await expect(page.getByLabel("Filter status")).toHaveValue("ISSUES_ONLY");
  await expect(page.getByText("110000077", { exact: true })).toBeVisible();
  await expect(page.getByText("110000076", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Qty: Accurate 3, CUSSONS 5 — Accurate kurang 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Dokumen Pembelian" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Supplier" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "DPP CUSSONS" })).toBeVisible();

  const cussonsDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Ekspor XLSX" }).click();
  const cussonsDownload = await cussonsDownloadPromise;
  expect(cussonsDownload.suggestedFilename()).toBe(
    `rekonsiliasi-pembelian-cussons-${new Date().toISOString().slice(0, 10)}.xlsx`,
  );

  await page.getByLabel("Prinsipal").selectOption("GODREJ");
  await expect(page.getByLabel("Rincian Faktur Pembelian (Accurate)")).toHaveValue("");
  await expect(page.getByLabel("GRN Status Report GODREJ")).toHaveValue("");
  await expect(page.getByText("Belum ada file dipilih")).toHaveCount(2);
  await expect(page.getByLabel("Ringkasan hasil")).toHaveCount(0);
  await expect(page.getByText("110000077", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Jalankan rekonsiliasi" })).toBeDisabled();

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
  await expect(page.getByRole("button", { name: "Pembelian" })).toHaveAttribute("aria-pressed", "false");
});
test("runs KINO, GODREJ, and CUSSONS Return reconciliation and resets when switching principal", async ({ page, baseURL }) => {
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

  await page.getByLabel("Prinsipal").selectOption("GODREJ");
  await expect(
    page.getByText("Bandingkan retur Accurate dengan laporan Sale Returns GODREJ.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Sale Returns GODREJ")).toHaveAttribute(
    "accept",
    ".csv,text/csv,application/csv",
  );

  const godrejReturnResult = {
    ...returnResult,
    results: returnResult.results.map((row) => ({
      ...row,
      principalProductCode: row.principalProductCode?.replace("SHZ", "GOD"),
    })),
  };
  let godrejReturnCalled = false;
  await page.route("**/api/reconciliation/godrej/returns", async (route) => {
    godrejReturnCalled = true;
    expect(route.request().method()).toBe("POST");
    const body = await route.request().postDataBuffer();
    expect(body?.toString()).toContain('name="accurateFile"');
    expect(body?.toString()).toContain('name="principalFile"');
    expect(body?.toString()).toContain('filename="sale-returns.csv"');
    await route.fulfill({ json: godrejReturnResult });
  });
  await page.getByLabel("Retur Penjualan (Accurate)").setInputFiles(xlsx("accurate-godrej-return.xlsx"));
  await page.getByLabel("Sale Returns GODREJ").setInputFiles(csv("sale-returns.csv"));
  await page.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();

  expect(godrejReturnCalled).toBe(true);
  await expect(page.getByLabel("Filter status")).toHaveValue("ISSUES_ONLY");
  await expect(page.getByText("INVGTS2505-0098-00877", { exact: true })).toBeVisible();
  await expect(page.getByText("INVGTS2505-0098-00876", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Pajak GODREJ" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Total GODREJ" })).toBeVisible();
  await expect(page.getByText("Qty: Accurate 3, GODREJ 5 — Accurate kurang 2", { exact: true })).toBeVisible();

  const godrejDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Ekspor XLSX" }).click();
  const godrejDownload = await godrejDownloadPromise;
  expect(godrejDownload.suggestedFilename()).toMatch(/^rekonsiliasi-return-godrej-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const godrejDownloadPath = await godrejDownload.path();
  expect(godrejDownloadPath).not.toBeNull();
  const godrejWorkbook = XLSX.readFile(godrejDownloadPath!);
  const godrejDetail = XLSX.utils.sheet_to_json<Record<string, string | number>>(godrejWorkbook.Sheets.Detail);
  expect(godrejDetail[1]).toMatchObject({
    "Produk GODREJ": "GOD-02",
    "Penyebab selisih": "Qty: Accurate 3, GODREJ 5 — Accurate kurang 2",
    "Baris GODREJ": "5",
  });

  await page.getByLabel("Prinsipal").selectOption("KINO");
  await expect(page.getByLabel("Sales Detail KINO")).toBeVisible();
  await expect(page.getByText("Belum ada file dipilih")).toHaveCount(2);
  await expect(page.getByLabel("Ringkasan hasil")).toHaveCount(0);
  await expect(page.getByText("INVGTS2505-0098-00877", { exact: true })).toHaveCount(0);

  await page.getByLabel("Prinsipal").selectOption("CUSSONS");
  await expect(
    page.getByText("Bandingkan retur Accurate dengan laporan TXN_NOTEPRD CUSSONS.", { exact: true }),
  ).toBeVisible();
  const cussonsFile = page.getByLabel("TXN_NOTEPRD CUSSONS");
  await expect(cussonsFile).toHaveAttribute("accept", ".csv,text/csv,application/csv");
  const runButton = page.getByRole("button", { name: "Jalankan rekonsiliasi" });
  await expect(runButton).toBeDisabled();
  await page.getByLabel("Retur Penjualan (Accurate)").setInputFiles(xlsx("accurate-cussons-return.xlsx"));
  await expect(runButton).toBeDisabled();
  await cussonsFile.setInputFiles(csv("txn-noteprd.csv"));
  await expect(runButton).toBeEnabled();

  const cussonsReturnResult = {
    ...returnResult,
    summary: { ...returnSummary, MATCH: 1, QTY_MISMATCH: 0, VALUE_MISMATCH: 0, MISSING_PRINCIPAL: 1 },
    results: [
      returnResult.results[0],
      {
        ...returnResult.results[1],
        invoiceNumber: "CN26000123",
        principalProductCode: null,
        principalQuantity: 0,
        principalDpp: 0,
        principalTax: 0,
        principalTotal: 0,
        status: "MISSING_PRINCIPAL",
        warnings: [],
        principalSourceRows: [],
      },
    ],
  };
  let cussonsReturnCalled = false;
  await page.route("**/api/reconciliation/cussons/returns", async (route) => {
    cussonsReturnCalled = true;
    expect(route.request().method()).toBe("POST");
    const body = await route.request().postDataBuffer();
    expect(body?.toString()).toContain('name="accurateFile"');
    expect(body?.toString()).toContain('name="principalFile"');
    expect(body?.toString()).toContain('filename="txn-noteprd.csv"');
    expect(body?.toString()).not.toContain('name="headerFile"');
    await route.fulfill({ json: cussonsReturnResult });
  });
  await runButton.click();

  expect(cussonsReturnCalled).toBe(true);
  await expect(page.getByLabel("Filter status")).toHaveValue("ISSUES_ONLY");
  await expect(page.getByText("CN26000123", { exact: true })).toBeVisible();
  await expect(page.getByText("Data tidak ditemukan di CUSSONS.", { exact: true })).toBeVisible();
  await expect(page.getByText("INVGTS2505-0098-00876", { exact: true })).toHaveCount(0);
  const cussonsDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Ekspor XLSX" }).click();
  const cussonsDownload = await cussonsDownloadPromise;
  expect(cussonsDownload.suggestedFilename()).toMatch(/^rekonsiliasi-return-cussons-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const cussonsDownloadPath = await cussonsDownload.path();
  expect(cussonsDownloadPath).not.toBeNull();
  const cussonsWorkbook = XLSX.readFile(cussonsDownloadPath!);
  const cussonsDetail = XLSX.utils.sheet_to_json<Record<string, string | number>>(cussonsWorkbook.Sheets.Detail);
  expect(cussonsDetail[1]).toMatchObject({
    Invoice: "CN26000123",
    "Baris Accurate": "3",
  });
  expect(cussonsDetail[1]["Penyebab selisih"]).toContain("Data tidak ditemukan di CUSSONS.");
  expect(cussonsDetail[1]["Penyebab selisih"]).toContain("Qty: Accurate 3, CUSSONS 0");

  await page.getByLabel("Prinsipal").selectOption("HEINZ");
  await expect(page.getByLabel("HEADER HEINZ")).toBeVisible();
  await expect(page.getByText("Belum ada file dipilih")).toHaveCount(3);
  await expect(page.getByLabel("Ringkasan hasil")).toHaveCount(0);
  await page.getByLabel("Prinsipal").selectOption("CUSSONS");
  await expect(page.getByLabel("TXN_NOTEPRD CUSSONS")).toBeVisible();
  await expect(page.getByText("Belum ada file dipilih")).toHaveCount(2);
  await expect(runButton).toBeDisabled();
});
test("runs HEINZ Return with HEADER and DETAIL then resets all three files", async ({ page, baseURL }) => {
  const login = await page.request.post("/api/auth/sign-in/email", {
    headers: { Origin: baseURL || "http://localhost:3000" },
    data: { email: QA_EMAIL, password: QA_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();

  await page.goto("/reconciliation");
  await page.getByRole("button", { name: "Return" }).click();
  await page.getByLabel("Prinsipal").selectOption("HEINZ");

  const run = page.getByRole("button", { name: "Jalankan rekonsiliasi" });
  await expect(page.getByText("Bandingkan retur Accurate dengan laporan HEADER dan DETAIL HEINZ.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("HEADER HEINZ")).toHaveAttribute("accept", ".csv,text/csv,application/csv");
  await expect(page.getByLabel("DETAIL HEINZ")).toHaveAttribute("accept", ".csv,text/csv,application/csv");
  await expect(run).toBeDisabled();

  await page.getByLabel("Retur Penjualan (Accurate)").setInputFiles(xlsx("accurate-heinz-return.xlsx"));
  await page.getByLabel("DETAIL HEINZ").setInputFiles(csv("detail-heinz.csv"));
  await expect(run).toBeDisabled();
  await page.getByLabel("HEADER HEINZ").setInputFiles(csv("header-heinz.csv"));
  await expect(run).toBeEnabled();

  const heinzResult = {
    ...returnResult,
    results: returnResult.results.map((row) => ({
      ...row,
      invoiceNumber: row.invoiceNumber.replace("INVGTS2505-0098-008", "CN-0242"),
      principalProductCode: row.principalProductCode?.replace("SHZ", "HEI"),
    })),
  };
  let heinzCalled = false;
  await page.route("**/api/reconciliation/heinz/returns", async (route) => {
    heinzCalled = true;
    const body = (await route.request().postDataBuffer())?.toString() ?? "";
    expect(body).toContain('name="accurateFile"');
    expect(body).toContain('name="headerFile"');
    expect(body).toContain('name="principalFile"');
    expect(body).toContain('filename="header-heinz.csv"');
    expect(body).toContain('filename="detail-heinz.csv"');
    await route.fulfill({ json: heinzResult });
  });

  await run.click();
  expect(heinzCalled).toBe(true);
  await expect(page.getByLabel("Filter status")).toHaveValue("ISSUES_ONLY");
  await expect(page.getByText("CN-024277", { exact: true })).toBeVisible();
  await expect(page.getByText("Qty: Accurate 3, HEINZ 5 — Accurate kurang 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Pajak HEINZ" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Total HEINZ" })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Ekspor XLSX" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^rekonsiliasi-return-heinz-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const workbook = XLSX.readFile(downloadPath!);
  const detail = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets.Detail);
  expect(detail[1]).toMatchObject({
    "Produk HEINZ": "HEI-02",
    "Pajak HEINZ": 6600.05,
    "Total HEINZ": 66600.55,
    "Baris HEINZ": "5",
  });

  await page.getByLabel("Prinsipal").selectOption("KINO");
  await expect(page.getByLabel("HEADER HEINZ")).toHaveCount(0);
  await expect(page.getByLabel("Sales Detail KINO")).toBeVisible();
  await expect(page.getByText("Belum ada file dipilih")).toHaveCount(2);
  await expect(page.getByLabel("Ringkasan hasil")).toHaveCount(0);

  await page.getByLabel("Prinsipal").selectOption("HEINZ");
  await expect(page.getByLabel("Retur Penjualan (Accurate)")).toHaveValue("");
  await expect(page.getByLabel("HEADER HEINZ", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("DETAIL HEINZ", { exact: true })).toHaveValue("");
  await expect(page.getByText("Belum ada file dipilih")).toHaveCount(3);
  await expect(run).toBeDisabled();
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
