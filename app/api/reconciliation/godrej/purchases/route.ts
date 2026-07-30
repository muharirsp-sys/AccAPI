import { readFile } from "node:fs/promises";
import path from "node:path";
import { createKinoSalesPostHandler } from "@/lib/off-program-control/kino-sales-route";
import { reconcileGodrejPurchases } from "@/lib/off-program-control/purchase-reconciliation";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

function safeGodrejPurchaseParserMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const safeHeaders = new Set([
    "Header wajib tidak ditemukan: NO. PEMBELIAN, KODE BARANG, QTY, SATUAN, DPP, REM",
    "Header wajib tidak ditemukan: Invoice_Number, Bill_No, Approved, Amount_Uploaded, Quantity_in_Units, Quantity_in_Cases, Quantity_Uploaded, Qty_Approved, Sku_Name",
  ]);
  return safeHeaders.has(error.message) ||
    /^(?:File (?:kosong|rusak atau tidak valid)|Sheet tidak ditemukan atau kosong|(?:QTY|DPP) (?:kosong|harus angka finite non-negatif) pada baris \d+|SATUAN harus KRT pada baris \d+|REM harus memuat tepat satu DMS Bill pada baris \d+)$/.test(error.message)
    ? error.message
    : null;
}

export const POST = createKinoSalesPostHandler({
  authorize: async (request) =>
    (await requirePermission(request, "reconciliation.run")).response,
  readMapping: () =>
    readFile(
      path.join(
        process.cwd(),
        "data",
        "reconciliation",
        "GODREJ_RETURN.xlsx",
      ),
    ),
  reconcile: (accurate, principal, mapping) =>
    reconcileGodrejPurchases(accurate, principal, mapping, {
      dppTolerance: 1,
    }),
  missingMappingMessage: "Master mapping GODREJ Purchase tidak tersedia.",
  principalUpload: { kind: "csv" },
  safeParserMessage: safeGodrejPurchaseParserMessage,
});
