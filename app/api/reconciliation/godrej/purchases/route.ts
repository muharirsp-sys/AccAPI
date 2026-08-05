import { createKinoSalesPostHandler } from "@/lib/off-program-control/kino-sales-route";
import { reconciliationStore } from "@/lib/off-program-control/reconciliation-store";
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
  reconciliationKey: "purchases:GODREJ",
  authorize: async (request) => {
    const { response, session } = await requirePermission(request, "reconciliation.run");
    return { response, actor: session ? { id: session.user.id, name: session.user.name ?? session.user.email, email: session.user.email } : null };
  },
  readMapping: () => reconciliationStore.getActiveMapping("purchases", "GODREJ"),
  startReconciliationRun: (input) => reconciliationStore.startReconciliationRun(input),
  completeReconciliationRun: (id, output, durationMs) =>
    reconciliationStore.completeReconciliationRun(id, output, durationMs),
  failReconciliationRun: (id, error, durationMs) =>
    reconciliationStore.failReconciliationRun(id, error, durationMs),
  reconcile: (accurate, principal, mapping) =>
    reconcileGodrejPurchases(accurate, principal, mapping, {
      dppTolerance: 1,
    }),
  missingMappingMessage: "Master mapping GODREJ Purchase tidak tersedia.",
  principalUpload: { kind: "csv" },
  safeParserMessage: safeGodrejPurchaseParserMessage,
});
