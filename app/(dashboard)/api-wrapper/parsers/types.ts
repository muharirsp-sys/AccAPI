/**
 * Tujuan: Kontrak parser workbook per-endpoint agar upload Excel bisa dipisah tanpa mengganggu parser route lain.
 * Caller: Registry parser workbook dan `app/(dashboard)/api-wrapper/page.tsx`.
 * Dependensi: `xlsx` workbook object dan `accurateFetch` client-side.
 * Main Functions: Tipe `WorkbookRouteParser`, `WorkbookParseResult`, dan `workbookRouteParsers`.
 * Side Effects: Tidak ada; file ini hanya mendefinisikan tipe untuk flow parsing workbook.
 */
import type * as XLSX from "xlsx";

export type AccurateFetchLike = (
  endpointPath: string,
  method: string,
  payload?: unknown,
) => Promise<any>;

export type WorkbookParseResult = {
  payload: any[];
  summaryMessage: string;
  warnings: string[];
  reportRows: Record<string, unknown>[];
  meta?: Record<string, unknown>;
};

export type WorkbookRouteParser = (args: {
  workbook: XLSX.WorkBook;
  routeKey: string;
  trxDate: string;
  accurateFetch: AccurateFetchLike;
}) => Promise<WorkbookParseResult>;

