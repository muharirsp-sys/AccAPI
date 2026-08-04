import { readFile } from "node:fs/promises";
import path from "node:path";
import { createKinoSalesPostHandler } from "@/lib/off-program-control/kino-sales-route";
import { reconcileForisaPurchases } from "@/lib/off-program-control/purchase-reconciliation";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

function safeForisaPurchaseParserMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const safeHeaders = new Set([
    "Header wajib tidak ditemukan: NO. PEMBELIAN, KODE BARANG, NAMA BARANG, QTY, SATUAN, DPP, PPN, REM",
    "Header wajib tidak ditemukan: Product Code, Product Name, Brand Name, Qty (CB), Price, Amount, Discount, Amount After Discount, PPN, Total Amount",
    "Header wajib tidak ditemukan: Kode Pcpl, Kode BARANG Win2, Nama Win, ISI/CTN",
  ]);
  return safeHeaders.has(error.message) ||
    /^(?:Nama file principal harus memuat tepat satu nomor DO FORISA \(format 401 \+ 7 digit\)|Header duplikat: (?:NO\. PEMBELIAN|KODE BARANG|NAMA BARANG|QTY|SATUAN|DPP|PPN|REM|Product Code|Product Name|Brand Name|Qty \(CB\)|Price|Amount|Discount|Amount After Discount|Total Amount|Kode Pcpl|Kode BARANG Win2|Nama Win|ISI\/CTN)|Mapping FORISA tidak lengkap pada baris \d+|ISI\/CTN harus lebih dari nol pada baris \d+|(?:QTY|DPP|PPN|Qty \(CB\)|Price|Amount|Discount|Amount After Discount|Total Amount|ISI\/CTN) (?:kosong|harus angka finite non-negatif) pada baris \d+|(?:REM harus memuat tepat satu nomor DO FORISA|SATUAN harus KRT|Formula (?:Amount|Amount After Discount|Total Amount|PPN) tidak konsisten) pada baris \d+)$/.test(error.message)
    ? error.message
    : null;
}

export const POST = createKinoSalesPostHandler({
  authorize: async (request) =>
    (await requirePermission(request, "reconciliation.run")).response,
  readMapping: () =>
    readFile(path.join(process.cwd(), "data", "reconciliation", "FORISA_PURCHASE.xlsx")),
  reconcile: (accurate, principal, mapping, principalFilename) =>
    reconcileForisaPurchases(accurate, principal, mapping, principalFilename),
  missingMappingMessage: "Master mapping FORISA Purchase tidak tersedia.",
  principalUpload: { kind: "xlsx" },
  safeParserMessage: safeForisaPurchaseParserMessage,
});
