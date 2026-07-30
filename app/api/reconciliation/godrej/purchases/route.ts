import { readFile } from "node:fs/promises";
import path from "node:path";
import { createKinoSalesPostHandler } from "@/lib/off-program-control/kino-sales-route";
import { reconcileGodrejPurchases } from "@/lib/off-program-control/purchase-reconciliation";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

function safeGodrejPurchaseParserMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  return error.message ===
    "Header wajib tidak ditemukan: Invoice_Number, Bill_No, Approved, Amount_Uploaded, Quantity_in_Units, Quantity_Uploaded, Qty_Approved, Sku_Name" ||
    /^(?:Invoice_Number dan Bill_No tidak konsisten pada baris \d+|Kuantitas tidak konsisten pada baris \d+|(?:Amount_Uploaded|Quantity_in_Units|Quantity_Uploaded|Qty_Approved) (?:kosong|harus angka finite non-negatif) pada baris \d+)$/.test(
      error.message,
    )
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
  safeParserMessage: safeGodrejPurchaseParserMessage,
});
