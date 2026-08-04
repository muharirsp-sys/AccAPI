import { readFile } from "node:fs/promises";
import path from "node:path";
import { createKinoSalesPostHandler } from "@/lib/off-program-control/kino-sales-route";
import { reconcileKinoPurchases } from "@/lib/off-program-control/purchase-reconciliation";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

function safeKinoPurchaseParserMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const safeHeaders = new Set([
    "Header wajib tidak ditemukan: NO. PEMBELIAN, KODE BARANG, QTY, SATUAN, DPP, PPN, REM",
    "Header wajib tidak ditemukan: No. Order, No. SJ, No. Item, Kirim, Price, Total",
    "Header wajib tidak ditemukan: Kode Barang Win, Kode Pcpl, ISI/CTN",
  ]);
  return safeHeaders.has(error.message) ||
    /^(?:Header duplikat: (?:NO\. PEMBELIAN|KODE BARANG|QTY|SATUAN|DPP|PPN|REM|No\. Order|No\. SJ|No\. Item|Kirim|Price|Total|Kode Barang Win|Kode Pcpl|ISI\/CTN)|(?:QTY|DPP|PPN|Kirim|Price|Total|ISI\/CTN) (?:kosong|harus angka finite non-negatif) pada baris \d+|REM harus memuat No\. SJ dan No\. Order pada baris \d+|SATUAN harus KRT pada baris \d+|Formula Total tidak konsisten pada baris \d+)$/.test(error.message)
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
        "KINO_PURCHASE.xlsx",
      ),
    ),
  reconcile: (accurate, principal, mapping) =>
    reconcileKinoPurchases(accurate, principal, mapping),
  missingMappingMessage: "Master mapping KINO Purchase tidak tersedia.",
  principalUpload: { kind: "xlsx" },
  safeParserMessage: safeKinoPurchaseParserMessage,
});
