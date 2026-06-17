import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as XLSX from "xlsx";

const QA_EMAIL = "qa.admin@local.test";
const QA_PASSWORD = "Admin123!";
const RECORD_ID = `LPB-INVALID-DATE-${Date.now()}`;
const PAYMENTS_PATH = resolve(process.cwd(), "python_backend", "data", "payments.json");

function seedQaUsers() {
  const result = spawnSync("node", ["scripts/seed-local-qa-users.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      [
        "Failed to seed local QA users.",
        result.stdout,
        result.stderr,
      ].filter(Boolean).join("\n"),
    );
  }
}

function hasUploadedRecord() {
  if (!existsSync(PAYMENTS_PATH)) return false;
  const raw = JSON.parse(readFileSync(PAYMENTS_PATH, "utf8"));
  return Boolean(raw?.lpb?.[RECORD_ID]);
}

function buildInvalidDateWorkbook() {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet([
    {
      "TGL. SETOR": "31/02/2026",
      "NO. LPB": RECORD_ID,
      "TGL. WIN": "01/03/2026",
      "TGL. J. TEMPO WIN": "30/03/2026",
      PRINCIPLE: "TEST PRINCIPLE INVALID DATE",
      "NILAI WIN": 1250000,
      "TGL TERIMA BARANG": "02/03/2026",
      "Tgl Invoice": "03/03/2026",
      "No Invoice": "INV-INVALID-DATE",
      "Nilai Invoice": 1250000,
    },
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "LPB_INVALID_DATE");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

test.beforeAll(() => {
  seedQaUsers();
});

test("Payments LPB upload shows a toast notification when a date is invalid", async ({ page }) => {
  expect(hasUploadedRecord()).toBe(false);

  await page.goto("/login");
  await page.getByPlaceholder("email@perusahaan.com").fill(QA_EMAIL);
  await page.getByPlaceholder("••••••••").fill(QA_PASSWORD);
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page.getByText("Login berhasil.")).toBeVisible();

  await page.goto("/payments");
  await expect(page.getByRole("heading", { name: "Manajemen Pembayaran & SPPD" })).toBeVisible();
  await page.waitForLoadState("networkidle");

  const uploadForm = page
    .locator("form")
    .filter({ has: page.locator('input[type="file"][accept=".xlsx,.xls"]') })
    .first();
  const uploadButton = uploadForm.locator('button[type="submit"]');
  const fileInput = uploadForm.locator('input[type="file"][accept=".xlsx,.xls"]');

  // Hidrasi React di `next dev` bisa selesai setelah heading tampil; bila file
  // di-set sebelum onChange terpasang, event `change` hilang dan tombol tetap
  // disabled selamanya. Ulangi set-file sampai React menangkapnya & tombol enable.
  await expect(async () => {
    await fileInput.setInputFiles({
      name: "lpb-invalid-date.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: buildInvalidDateWorkbook(),
    });
    await expect(uploadButton).toBeEnabled({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });

  const uploadFailure = new Promise<never>((_, reject) => {
    page.on("requestfailed", (request) => {
      if (request.url().includes("/payments/upload")) {
        reject(new Error(`Upload request failed: ${request.failure()?.errorText || "unknown error"}`));
      }
    });
  });
  const uploadResponse = page.waitForResponse(
    (res) => res.url().includes("/payments/upload") && res.request().method() === "POST",
    { timeout: 15_000 },
  );

  await uploadButton.click();
  const response = await Promise.race([uploadResponse, uploadFailure]);
  expect(response.status()).toBe(400);
  const payload = await response.json();
  expect(payload.ok).toBe(false);
  expect(String(payload.error)).toContain("Tanggal tidak valid");

  await expect(page.getByText(/Tanggal tidak valid/)).toBeVisible();
  await expect(page.getByText(/Upload dibatalkan/)).toBeVisible();
  expect(hasUploadedRecord()).toBe(false);
});
