/**
 * Tujuan: Registry parser workbook khusus per route bulk-save agar setiap endpoint bisa punya strategi parsing sendiri.
 * Caller: `app/(dashboard)/api-wrapper/page.tsx`.
 * Dependensi: Parser workbook khusus seperti `purchaseReturnBulkSave`.
 * Main Functions: `workbookRouteParsers`.
 * Side Effects: Tidak ada; hanya memetakan route key ke parser yang sesuai.
 */
import { parsePurchaseReturnBulkSaveWorkbook } from "./purchaseReturnBulkSave";
import type { WorkbookRouteParser } from "./types";

export const workbookRouteParsers: Partial<Record<string, WorkbookRouteParser>> = {
  purchaseReturnBulkSave: parsePurchaseReturnBulkSaveWorkbook,
};

