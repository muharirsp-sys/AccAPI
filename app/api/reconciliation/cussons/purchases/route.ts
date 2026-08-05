import { createKinoSalesPostHandler } from "@/lib/off-program-control/kino-sales-route";
import { reconciliationStore } from "@/lib/off-program-control/reconciliation-store";
import { reconcileCussonsPurchases } from "@/lib/off-program-control/purchase-reconciliation";
import { parseCussonsMappings } from "@/lib/off-program-control/sales-reconciliation";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

function safeCussonsPurchaseParserMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const safeHeaders = new Set([
    "Header wajib tidak ditemukan: NO. PEMBELIAN, KODE BARANG, QTY, SATUAN, DPP, PPN, REM",
    "Header wajib tidak ditemukan: Invoice No, Product Code, UOM Code, Default UOM, Received Product Quantity, Invoice Quantity UOM, Product List Price, Customer Discount Amount, Purchase Discount Amount, No Return Discount Amount, Discount Allowance Amount, Net Amount, Tax Percentage, Total Tax Amount",
  ]);
  return safeHeaders.has(error.message) ||
    /^(?:Header duplikat: (?:NO\. PEMBELIAN|KODE BARANG|QTY|SATUAN|DPP|PPN|REM|Invoice No|Product Code|UOM Code|Default UOM|Received Product Quantity|Invoice Quantity UOM|Product List Price|Customer Discount Amount|Purchase Discount Amount|No Return Discount Amount|Discount Allowance Amount|Net Amount|Tax Percentage|Total Tax Amount)|(?:QTY|DPP|PPN|Received Product Quantity|Invoice Quantity UOM|Product List Price|Customer Discount Amount|Purchase Discount Amount|No Return Discount Amount|Discount Allowance Amount|Net Amount|Tax Percentage|Total Tax Amount) (?:kosong|harus angka finite non-negatif) pada baris \d+|REM harus memuat tepat satu nomor invoice CUSSONS pada baris \d+|SATUAN harus KRT pada baris \d+|Invoice No tidak valid pada baris \d+|UOM Code harus CS pada baris \d+|Default UOM harus EA pada baris \d+|Received Product Quantity dan Invoice Quantity UOM tidak konsisten pada baris \d+|Formula (?:Net Amount|pajak) tidak konsisten pada baris \d+)$/.test(
      error.message,
    )
    ? error.message
    : null;
}

export const POST = createKinoSalesPostHandler({
  reconciliationKey: "purchases:CUSSONS",
  authorize: async (request) => {
    const { response, session } = await requirePermission(request, "reconciliation.run");
    return { response, actor: session ? { id: session.user.id, name: session.user.name ?? session.user.email, email: session.user.email } : null };
  },
  readMapping: () => reconciliationStore.getActiveMapping("purchases", "CUSSONS"),
  startReconciliationRun: (input) => reconciliationStore.startReconciliationRun(input),
  completeReconciliationRun: (id, output, durationMs) =>
    reconciliationStore.completeReconciliationRun(id, output, durationMs),
  failReconciliationRun: (id, error, durationMs) =>
    reconciliationStore.failReconciliationRun(id, error, durationMs),
  reconcile: (accurate, principal, mapping) => {
    try {
      parseCussonsMappings(mapping);
    } catch {
      throw new Error("Internal CUSSONS mapping is invalid");
    }
    return reconcileCussonsPurchases(accurate, principal, mapping, {
      dppTolerance: 1,
    });
  },
  missingMappingMessage: "Master mapping CUSSONS Purchase tidak tersedia.",
  principalUpload: { kind: "csv" },
  safeParserMessage: safeCussonsPurchaseParserMessage,
});
