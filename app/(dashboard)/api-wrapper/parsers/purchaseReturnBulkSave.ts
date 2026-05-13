/**
 * Tujuan: Parser workbook multi-sheet khusus purchase return dengan prioritas format sederhana berbasis kolom eksplisit branch/vendor, plus fallback layout lama yang masih resolve dari item pertama, lalu preflight stok gudang yang efisien via `item/list-stock.do` dengan fallback `item/get-stock.do`.
 * Caller: Registry parser workbook dan upload Excel di `app/(dashboard)/api-wrapper/page.tsx`.
 * Dependensi: `xlsx`, `accurateFetch`, master item/vendor/warehouse Accurate, dan endpoint stok `item/get-stock.do`.
 * Main Functions: `parsePurchaseReturnBulkSaveWorkbook`.
 * Side Effects: HTTP call ke Accurate untuk `item/list.do`, `item/detail.do`, `vendor/detail.do`, `warehouse/list.do`, `item/list-stock.do`, dan `item/get-stock.do`.
 */
import * as XLSX from "xlsx";
import type { AccurateFetchLike, WorkbookParseResult, WorkbookRouteParser } from "./types";

const TARGET_WAREHOUSE_CODE = "GD0BS";
const ITEM_LIST_FIELDS = "id,no,name,branch,branchId,branchName,vendorNo,preferedVendorId,preferedVendor,keywords,lastUpdate";
const ITEM_DETAIL_FIELDS = "id,no,name,branch,branchId,branchName,vendorNo,preferedVendorId,preferedVendor,keywords,lastUpdate";
const WAREHOUSE_LIST_FIELDS = "id,name,keywords,suspended";
const SHEET_HEADER_SCAN_LIMIT = 18;

type ParsedSheetItem = {
  itemNo: string;
  quantityExcel: number;
  unitPrice?: number;
  rowNumber: number;
};

type SheetExtraction = {
  codeColumnIndex: number;
  qtyColumnIndex: number;
  priceColumnIndex: number | null;
  headerRowIndex: number;
  dataStartRowIndex: number;
  items: ParsedSheetItem[];
};

type SheetContext = {
  itemId?: number;
  vendorNo: string;
  branchId: number;
  branchName: string;
};

type WarehouseContext = {
  id?: number;
  name: string;
  code: string;
};

type StockAdjustment = ParsedSheetItem & {
  quantityStock: number;
  quantityAdjusted: number;
  quantityRemaining: number;
};

type PreparedSheet = {
  sheetName: string;
  extraction: SheetExtraction;
  context: SheetContext;
  source: "simple-sheet" | "legacy-sheet";
};

const PURCHASE_RETURN_TYPE = "NO_INVOICE";
const SIMPLE_HEADER_SCAN_LIMIT = 6;
const SIMPLE_HEADERS = {
  itemNo: "KODE BARANG",
  price: "HARGA",
  quantity: "QTY",
  branchId: "BRANCHID",
  branchName: "BRANCHNAME",
  vendorNo: "VENDORNO",
} as const;
const STOCK_QTY_KEYS = [
  "availableQty",
  "availableQuantity",
  "quantity",
  "qty",
  "stock",
  "onHand",
  "balance",
  "endBalance",
  "controlQuantity",
];

const normalizeText = (value: unknown) =>
  String(value ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeKey = (value: unknown) => normalizeText(value).toUpperCase();

const toCodeString = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? value.toFixed(0) : String(value);
  }
  return normalizeText(value);
};

const toNumber = (value: unknown) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const text = normalizeText(value).replace(/,/g, "");
  if (!text) return NaN;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : NaN;
};

const isMeaningfulCode = (value: unknown) => {
  const text = normalizeKey(toCodeString(value));
  if (!text || text.length < 4) return false;
  if (["NO", "NO.", "KODE BARANG", "KODEBRG", "COLUMN2"].includes(text)) return false;
  if (text.startsWith("TOTAL") || text.startsWith("JUMLAH")) return false;
  return /[A-Z0-9]/.test(text);
};

const flattenObjects = (value: any, bucket: any[] = []) => {
  if (Array.isArray(value)) {
    value.forEach((item) => flattenObjects(item, bucket));
    return bucket;
  }
  if (value && typeof value === "object") {
    bucket.push(value);
    Object.values(value).forEach((child) => flattenObjects(child, bucket));
  }
  return bucket;
};

const pickFirstNumber = (obj: Record<string, any>, keys: string[]) => {
  for (const key of keys) {
    const raw = obj[key];
    const value = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return NaN;
};

const getWorksheetMatrix = (worksheet: XLSX.WorkSheet) =>
  XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    raw: true,
    defval: null,
  }) as unknown[][];

const buildSimpleHeaderMap = (row: unknown[]) => {
  const headerMap = new Map<string, number>();
  row.forEach((cell, index) => {
    const key = normalizeKey(cell);
    if (!key) return;
    headerMap.set(key, index);
  });
  return headerMap;
};

const findSimpleHeaderRowIndex = (rows: unknown[][]) => {
  const maxRow = Math.min(rows.length, SIMPLE_HEADER_SCAN_LIMIT);
  for (let rowIndex = 0; rowIndex < maxRow; rowIndex += 1) {
    const headerMap = buildSimpleHeaderMap(rows[rowIndex] || []);
    const hasAllRequiredHeaders = Object.values(SIMPLE_HEADERS).every((header) => headerMap.has(header));
    if (hasAllRequiredHeaders) return rowIndex;
  }
  return -1;
};

const detectSimplePurchaseReturnSheet = (
  sheetName: string,
  worksheet: XLSX.WorkSheet,
) => {
  const rows = getWorksheetMatrix(worksheet);
  const headerRowIndex = findSimpleHeaderRowIndex(rows);
  if (headerRowIndex < 0) return null;

  const headerMap = buildSimpleHeaderMap(rows[headerRowIndex] || []);
  const codeColumnIndex = headerMap.get(SIMPLE_HEADERS.itemNo)!;
  const qtyColumnIndex = headerMap.get(SIMPLE_HEADERS.quantity)!;
  const priceColumnIndex = headerMap.get(SIMPLE_HEADERS.price) ?? null;
  const branchIdColumnIndex = headerMap.get(SIMPLE_HEADERS.branchId)!;
  const branchNameColumnIndex = headerMap.get(SIMPLE_HEADERS.branchName)!;
  const vendorNoColumnIndex = headerMap.get(SIMPLE_HEADERS.vendorNo)!;
  const dataStartRowIndex = headerRowIndex + 1;
  const items: ParsedSheetItem[] = [];
  let context: SheetContext | null = null;

  for (let rowIndex = dataStartRowIndex; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const itemNo = toCodeString(row[codeColumnIndex]);
    if (!isMeaningfulCode(itemNo)) continue;

    const quantityExcel = toNumber(row[qtyColumnIndex]);
    if (!Number.isFinite(quantityExcel) || quantityExcel <= 0) continue;

    const unitPriceRaw = priceColumnIndex === null ? NaN : toNumber(row[priceColumnIndex]);
    const branchId = Number(row[branchIdColumnIndex]);
    const branchName = normalizeText(row[branchNameColumnIndex]);
    const vendorNo = normalizeText(row[vendorNoColumnIndex]);

    if (!Number.isFinite(branchId) || !branchName || !vendorNo) {
      throw new Error(
        `Sheet ${sheetName} memiliki baris sederhana dengan Branch/Vendor kosong pada row ${rowIndex + 1}.`,
      );
    }

    const rowContext: SheetContext = {
      vendorNo,
      branchId,
      branchName,
    };

    if (!context) {
      context = rowContext;
    } else if (
      context.vendorNo !== rowContext.vendorNo ||
      context.branchId !== rowContext.branchId ||
      context.branchName !== rowContext.branchName
    ) {
      throw new Error(
        `Sheet ${sheetName} memiliki lebih dari satu kombinasi Branch/Vendor pada format sederhana.`,
      );
    }

    items.push({
      itemNo,
      quantityExcel,
      unitPrice: Number.isFinite(unitPriceRaw) ? unitPriceRaw : undefined,
      rowNumber: rowIndex + 1,
    });
  }

  if (items.length === 0 || !context) {
    throw new Error(`Sheet ${sheetName} format sederhana tidak menghasilkan item valid.`);
  }

  return {
    extraction: {
      codeColumnIndex,
      qtyColumnIndex,
      priceColumnIndex,
      headerRowIndex,
      dataStartRowIndex,
      items,
    } satisfies SheetExtraction,
    context,
  };
};

const buildColumnHeaderText = (
  rows: unknown[][],
  columnIndex: number,
  startRowIndex: number,
  endRowIndex: number,
) => {
  const bucket: string[] = [];
  for (let rowIndex = startRowIndex; rowIndex <= endRowIndex; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const text = normalizeText(row[columnIndex]);
    if (!text) continue;
    if (!bucket.includes(text)) bucket.push(text);
  }
  return bucket.join(" | ");
};

const findHeaderRowIndex = (rows: unknown[][]) => {
  let bestIndex = -1;
  let bestScore = -1;
  const maxRow = Math.min(rows.length, SHEET_HEADER_SCAN_LIMIT);
  for (let rowIndex = 0; rowIndex < maxRow; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const joined = row.map((cell) => normalizeKey(cell)).join(" | ");
    let score = 0;
    if (joined.includes("KODE BARANG")) score += 5;
    if (joined.includes("KODEBRG")) score += 5;
    if (joined.includes("KODE BARU")) score += 5;
    if (joined.includes("WIN BARU")) score += 5;
    if (joined.includes("KODE PRINCIPLE")) score += 2;
    if (joined.includes("NAMA BARANG")) score += 2;
    if (joined.includes("PRICE") || joined.includes("HARGA")) score += 1;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = rowIndex;
    }
  }
  if (bestIndex < 0) {
    throw new Error("Header kode barang tidak ditemukan pada sheet.");
  }
  return bestIndex;
};

const findCodeColumnIndex = (rows: unknown[][], headerRowIndex: number) => {
  const row = rows[headerRowIndex] || [];
  for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
    const label = normalizeKey(row[columnIndex]);
    if (
      label.includes("KODE BARANG") ||
      label.includes("KODEBRG") ||
      label.includes("KODE BARU") ||
      label.includes("WIN BARU")
    ) {
      return columnIndex;
    }
  }
  throw new Error("Kolom kode barang tidak ditemukan.");
};

const findPriceColumnIndex = (rows: unknown[][], headerRowIndex: number, columnCount: number) => {
  const startRow = Math.max(0, headerRowIndex - 2);
  const endRow = Math.min(rows.length - 1, headerRowIndex + 2);
  let bestIndex: number | null = null;
  let bestScore = -1;

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const headerText = normalizeKey(buildColumnHeaderText(rows, columnIndex, startRow, endRow));
    let score = -1;
    if (headerText.includes("HARGA - PPN")) score = 10;
    else if (headerText.includes("HARGA JUAL - PPN")) score = 9;
    else if (headerText.includes("HARGA BELI")) score = 9;
    else if (headerText.includes("DAFTAR HARGA")) score = 8;
    else if (headerText.includes("PRICE")) score = 7;
    else if (headerText.includes("HARGA")) score = 6;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = columnIndex;
    }
  }

  return bestIndex;
};

const getQtyColumnSampleMetrics = (
  rows: unknown[][],
  dataStartRowIndex: number,
  columnIndex: number,
) => {
  const maxRow = Math.min(rows.length, dataStartRowIndex + 40);
  let positiveCount = 0;
  let numericCount = 0;
  for (let rowIndex = dataStartRowIndex; rowIndex < maxRow; rowIndex += 1) {
    const value = toNumber(rows[rowIndex]?.[columnIndex]);
    if (!Number.isFinite(value)) continue;
    numericCount += 1;
    if (value > 0) positiveCount += 1;
  }
  return { positiveCount, numericCount };
};

const findQtyColumnIndex = (
  rows: unknown[][],
  headerRowIndex: number,
  dataStartRowIndex: number,
  columnCount: number,
) => {
  const startRow = Math.max(0, headerRowIndex - 3);
  const endRow = Math.min(rows.length - 1, headerRowIndex + 3);
  let bestIndex = -1;
  let bestScore = -Infinity;

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const headerText = normalizeKey(buildColumnHeaderText(rows, columnIndex, startRow, endRow));
    if (!headerText.includes("QTY")) continue;
    if (headerText.includes("VALUE") || headerText.includes("ED") || headerText.includes("BATCH")) continue;
    const sampleMetrics = getQtyColumnSampleMetrics(rows, dataStartRowIndex, columnIndex);

    let score = columnIndex;
    if (headerText.includes("QTY ALL")) score += 1000;
    if (headerText.includes("JUMLAH")) score += 200;
    if (headerText.includes("TOTAL")) score += 150;
    if (headerText.includes("RETUR")) score += 50;
    if (headerText.includes("KARUNG")) score += 25;
    if (sampleMetrics.numericCount > 0) score += sampleMetrics.numericCount * 20;
    if (sampleMetrics.positiveCount > 0) score += sampleMetrics.positiveCount * 60;
    if (sampleMetrics.positiveCount === 0) score -= 10000;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = columnIndex;
    }
  }

  if (bestIndex >= 0) return bestIndex;
  throw new Error("Kolom QTY final paling kanan tidak ditemukan.");
};

const findDataStartRowIndex = (rows: unknown[][], headerRowIndex: number, codeColumnIndex: number) => {
  for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    if (isMeaningfulCode(rows[rowIndex]?.[codeColumnIndex])) {
      return rowIndex;
    }
  }
  throw new Error("Baris data item pertama tidak ditemukan.");
};

const extractSheetItems = (
  rows: unknown[][],
  codeColumnIndex: number,
  qtyColumnIndex: number,
  priceColumnIndex: number | null,
  dataStartRowIndex: number,
) => {
  const items: ParsedSheetItem[] = [];
  for (let rowIndex = dataStartRowIndex; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const itemNo = toCodeString(row[codeColumnIndex]);
    if (!isMeaningfulCode(itemNo)) continue;
    const quantityExcel = toNumber(row[qtyColumnIndex]);
    if (!Number.isFinite(quantityExcel) || quantityExcel <= 0) continue;

    const unitPriceRaw = priceColumnIndex === null ? NaN : toNumber(row[priceColumnIndex]);
    items.push({
      itemNo,
      quantityExcel,
      unitPrice: Number.isFinite(unitPriceRaw) ? unitPriceRaw : undefined,
      rowNumber: rowIndex + 1,
    });
  }
  return items;
};

const detectPurchaseReturnSheetLayout = (
  sheetName: string,
  worksheet: XLSX.WorkSheet,
): SheetExtraction => {
  const rows = getWorksheetMatrix(worksheet);
  const headerRowIndex = findHeaderRowIndex(rows);
  const codeColumnIndex = findCodeColumnIndex(rows, headerRowIndex);
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const dataStartRowIndex = findDataStartRowIndex(rows, headerRowIndex, codeColumnIndex);
  const qtyColumnIndex = findQtyColumnIndex(rows, headerRowIndex, dataStartRowIndex, columnCount);
  const priceColumnIndex = findPriceColumnIndex(rows, headerRowIndex, columnCount);
  const items = extractSheetItems(
    rows,
    codeColumnIndex,
    qtyColumnIndex,
    priceColumnIndex,
    dataStartRowIndex,
  );

  if (items.length === 0) {
    throw new Error(`Sheet ${sheetName} tidak menghasilkan item dengan qty final valid.`);
  }

  return {
    codeColumnIndex,
    qtyColumnIndex,
    priceColumnIndex,
    headerRowIndex,
    dataStartRowIndex,
    items,
  };
};

const findExactItem = (rows: any[], itemNo: string) => {
  const normalizedTarget = normalizeKey(itemNo);
  return rows.find((row) => normalizeKey(row?.no || row?.itemNo || row?.number) === normalizedTarget);
};

const resolveVendorNo = (candidate: any) => {
  const direct = normalizeText(
    candidate?.vendorNo ||
      candidate?.preferedVendor?.vendorNo ||
      candidate?.preferedVendor?.no ||
      candidate?.vendor?.no ||
      candidate?.vendor?.vendorNo,
  );
  return direct;
};

const resolveBranchFromCandidate = (candidate: any) => {
  const branchId = Number(
    candidate?.branch?.id ?? candidate?.branchId ?? candidate?.defaultBranch?.id,
  );
  const branchName = normalizeText(
    candidate?.branch?.name ?? candidate?.branchName ?? candidate?.defaultBranch?.name,
  );
  return {
    branchId: Number.isFinite(branchId) ? branchId : NaN,
    branchName,
  };
};

const resolveSheetContextFromFirstItem = async (
  itemNo: string,
  accurateFetch: AccurateFetchLike,
  cache: Map<string, SheetContext>,
) => {
  if (cache.has(itemNo)) return cache.get(itemNo)!;

  const listPayload = {
    fields: ITEM_LIST_FIELDS,
    "sp.pageSize": 20,
    "filter.number.op": "EQUAL",
    "filter.number.val": itemNo,
  };
  const listRes = await accurateFetch("/api/item/list.do", "GET", listPayload);
  const listRows = Array.isArray(listRes?.d) ? listRes.d : [];
  let item = findExactItem(listRows, itemNo) || listRows[0];
  if (!item) {
    throw new Error(`Item pertama ${itemNo} tidak ditemukan di item/list.do.`);
  }

  let vendorNo = resolveVendorNo(item);
  let { branchId, branchName } = resolveBranchFromCandidate(item);
  const itemId = Number(item?.id);

  if ((!vendorNo || !Number.isFinite(branchId) || !branchName) && Number.isFinite(itemId)) {
    const detailRes = await accurateFetch("/api/item/detail.do", "GET", {
      id: itemId,
      fields: ITEM_DETAIL_FIELDS,
    });
    const detailItem = detailRes?.d || detailRes || {};
    vendorNo = vendorNo || resolveVendorNo(detailItem);
    const detailBranch = resolveBranchFromCandidate(detailItem);
    if (!Number.isFinite(branchId)) branchId = detailBranch.branchId;
    if (!branchName) branchName = detailBranch.branchName;

    const preferedVendorId = Number(
      detailItem?.preferedVendorId ?? detailItem?.preferedVendor?.id ?? item?.preferedVendorId,
    );
    if (!vendorNo && Number.isFinite(preferedVendorId)) {
      const vendorRes = await accurateFetch("/api/vendor/detail.do", "GET", {
        id: preferedVendorId,
      });
      const vendor = vendorRes?.d || vendorRes || {};
      vendorNo = normalizeText(vendor?.no || vendor?.vendorNo);
    }
  }

  if (!vendorNo) {
    throw new Error(`VendorNo item pertama ${itemNo} tidak ditemukan.`);
  }
  if (!Number.isFinite(branchId) || !branchName) {
    throw new Error(`Branch item pertama ${itemNo} tidak ditemukan.`);
  }

  const context: SheetContext = {
    itemId: Number.isFinite(itemId) ? itemId : undefined,
    vendorNo,
    branchId,
    branchName,
  };
  cache.set(itemNo, context);
  return context;
};

const resolveTargetWarehouse = async (accurateFetch: AccurateFetchLike) => {
  const res = await accurateFetch("/api/warehouse/list.do", "GET", {
    fields: WAREHOUSE_LIST_FIELDS,
    "sp.pageSize": 2000,
    keyword: TARGET_WAREHOUSE_CODE,
  });
  const rows: any[] = Array.isArray(res?.d) ? res.d : [];
  const target = rows.find((row) => {
    const candidates = [
      row?.name,
      row?.keywords,
      row?.warehouseName,
      row?.no,
      row?.code,
    ];
    return candidates.some((value) => normalizeKey(value) === TARGET_WAREHOUSE_CODE);
  });

  if (!target) {
    throw new Error(`Gudang ${TARGET_WAREHOUSE_CODE} tidak ditemukan di Accurate.`);
  }

  return {
    id: Number.isFinite(Number(target.id)) ? Number(target.id) : undefined,
    name: normalizeText(target.name || TARGET_WAREHOUSE_CODE),
    code: TARGET_WAREHOUSE_CODE,
  } satisfies WarehouseContext;
};

const resolveStockItemNo = (candidate: Record<string, any>) => {
  const nestedItemNo = normalizeText(
    candidate?.item?.no ||
      candidate?.item?.number ||
      candidate?.item?.itemNo ||
      candidate?.detailItem?.itemNo,
  );
  if (nestedItemNo) return nestedItemNo;

  const directItemNo = normalizeText(candidate?.itemNo || candidate?.itemNumber || candidate?.number);
  if (directItemNo) return directItemNo;

  const directNo = normalizeText(candidate?.no);
  if (
    directNo &&
    !candidate?.warehouseName &&
    !candidate?.warehouseCode &&
    !candidate?.warehouseNo &&
    !candidate?.warehouseId
  ) {
    return directNo;
  }

  return "";
};

const extractDirectStockQuantity = (rawResponse: any) => {
  const data = rawResponse?.d ?? rawResponse;
  if (typeof data === "number" && Number.isFinite(data)) {
    return Math.max(0, data);
  }

  if (typeof data === "string") {
    const parsed = Number(normalizeText(data).replace(/,/g, ""));
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }

  const objects = flattenObjects(data);
  for (const obj of objects) {
    const quantity = pickFirstNumber(obj, STOCK_QTY_KEYS);
    if (Number.isFinite(quantity)) return Math.max(0, quantity);
  }

  throw new Error("Qty stok tidak ditemukan pada response get-stock.do.");
};

const tryGetStock = async (
  accurateFetch: AccurateFetchLike,
  itemNo: string,
  warehouse: WarehouseContext,
) => {
  const payloadVariants = [
    { no: itemNo, warehouseName: warehouse.name },
    { no: itemNo, warehouseName: warehouse.code },
    { no: itemNo },
  ];
  let lastError: Error | null = null;

  for (const payload of payloadVariants) {
    try {
      return await accurateFetch("/api/item/get-stock.do", "GET", payload);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError || new Error(`item/get-stock.do gagal untuk item ${itemNo}.`);
};

const fetchWarehouseStockIndex = async (
  accurateFetch: AccurateFetchLike,
  warehouse: WarehouseContext,
) => {
  const stockIndex = new Map<string, number>();
  const basePayload: Record<string, unknown> = {
    "sp.pageSize": 500,
    "sp.page": 1,
  };
  if (warehouse.id) basePayload.warehouseId = warehouse.id;
  else basePayload.warehouseName = warehouse.name;

  let currentPage = 1;
  let pageCount = 1;
  do {
    const response = await accurateFetch("/api/item/list-stock.do", "GET", {
      ...basePayload,
      "sp.page": currentPage,
    });
    const rows = Array.isArray(response?.d) ? response.d : [];
    rows.forEach((row: any) => {
      const itemNo = resolveStockItemNo(row);
      const quantity = pickFirstNumber(row, STOCK_QTY_KEYS);
      if (!itemNo || !Number.isFinite(quantity)) return;
      stockIndex.set(normalizeKey(itemNo), Math.max(0, quantity));
    });

    const reportedPageCount = Number(response?.sp?.pageCount || 0);
    if (Number.isFinite(reportedPageCount) && reportedPageCount > 0) {
      pageCount = reportedPageCount;
    } else {
      pageCount = rows.length >= 500 ? currentPage + 1 : currentPage;
    }
    currentPage += 1;
  } while (currentPage <= pageCount && currentPage <= 200);

  return stockIndex;
};

const prefetchSheetStocks = async (
  sheetItems: ParsedSheetItem[],
  warehouse: WarehouseContext,
  accurateFetch: AccurateFetchLike,
  stockCache: Map<string, number>,
  warehouseStockIndex: Map<string, number>,
) => {
  const stocks = new Map<string, number>();
  const seen = new Set<string>();
  for (const item of sheetItems) {
    const itemNo = item.itemNo;
    if (seen.has(itemNo)) continue;
    seen.add(itemNo);
    const cacheKey = `${itemNo}|${warehouse.code}`;
    if (stockCache.has(cacheKey)) {
      stocks.set(itemNo, stockCache.get(cacheKey)!);
      continue;
    }

    const normalizedItemNo = normalizeKey(itemNo);
    if (warehouseStockIndex.has(normalizedItemNo)) {
      const indexedQty = Number(warehouseStockIndex.get(normalizedItemNo) ?? 0);
      stockCache.set(cacheKey, indexedQty);
      stocks.set(itemNo, indexedQty);
      continue;
    }

    try {
      const stockResponse = await tryGetStock(accurateFetch, itemNo, warehouse);
      const quantity = extractDirectStockQuantity(stockResponse);
      stockCache.set(cacheKey, quantity);
      stocks.set(itemNo, quantity);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Item ${itemNo}: ${message}`);
    }
  }
  return stocks;
};

const adjustSheetQuantitiesByStock = (
  sheetItems: ParsedSheetItem[],
  stockMap: Map<string, number>,
) =>
  sheetItems.map((item) => {
    const quantityStock = Number(stockMap.get(item.itemNo) ?? 0);
    const quantityAdjusted = Math.max(0, Math.min(item.quantityExcel, quantityStock));
    const quantityRemaining = Math.max(0, item.quantityExcel - quantityAdjusted);
    return {
      ...item,
      quantityStock,
      quantityAdjusted,
      quantityRemaining,
    } satisfies StockAdjustment;
  });

const buildPurchaseReturnDocFromSheet = (
  sheetName: string,
  trxDate: string,
  context: SheetContext,
  warehouse: WarehouseContext,
  adjustedItems: StockAdjustment[],
) => {
  const detailItems = adjustedItems
    .filter((item) => item.quantityAdjusted > 0)
    .map((item) => {
      const detail: Record<string, unknown> = {
        itemNo: item.itemNo,
        quantity: item.quantityAdjusted,
        warehouseName: warehouse.name,
      };
      if (typeof item.unitPrice === "number" && Number.isFinite(item.unitPrice)) {
        detail.unitPrice = item.unitPrice;
      }
      return detail;
    });

  if (detailItems.length === 0) {
    throw new Error(`Sheet ${sheetName} tidak punya item yang bisa diproses setelah cek stok.`);
  }

  return {
    vendorNo: context.vendorNo,
    branchId: context.branchId,
    branchName: context.branchName,
    returnType: PURCHASE_RETURN_TYPE,
    taxDate: trxDate.split("-").reverse().join("/"),
    taxNumber: "",
    transDate: trxDate.split("-").reverse().join("/"),
    detailItem: detailItems,
  };
};

const buildSheetAdjustmentReport = (
  sheetName: string,
  adjustedItems: StockAdjustment[],
  context: SheetContext,
) =>
  adjustedItems
    .filter(
      (item) =>
        item.quantityAdjusted !== item.quantityExcel || item.quantityRemaining > 0,
    )
    .map((item) => ({
      Sheet: sheetName,
      Branch: context.branchName,
      VendorNo: context.vendorNo,
      "Kode Barang": item.itemNo,
      "Qty di Excel": item.quantityExcel,
      "Qty Stok GD0BS": item.quantityStock,
      "Qty yang Disesuaikan": item.quantityAdjusted,
      "Sisa yang Harus Dipenuhi": item.quantityRemaining,
    }));

export const parsePurchaseReturnBulkSaveWorkbook: WorkbookRouteParser = async ({
  workbook,
  trxDate,
  accurateFetch,
}) => {
  const warehouse = await resolveTargetWarehouse(accurateFetch);
  const itemContextCache = new Map<string, SheetContext>();
  const stockCache = new Map<string, number>();
  const payload: any[] = [];
  const warnings: string[] = [];
  const reportRows: Record<string, unknown>[] = [];
  const sheetSummaries: Record<string, unknown>[] = [];
  const preparedSheets: PreparedSheet[] = [];

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;

    try {
      const simpleSheet = detectSimplePurchaseReturnSheet(sheetName, worksheet);
      if (simpleSheet) {
        preparedSheets.push({
          sheetName,
          extraction: simpleSheet.extraction,
          context: simpleSheet.context,
          source: "simple-sheet",
        });
        continue;
      }

      const extraction = detectPurchaseReturnSheetLayout(sheetName, worksheet);
      const firstItemNo = extraction.items[0]?.itemNo;
      if (!firstItemNo) {
        throw new Error(`Sheet ${sheetName} tidak punya item pertama yang valid.`);
      }
      const context = await resolveSheetContextFromFirstItem(
        firstItemNo,
        accurateFetch,
        itemContextCache,
      );
      preparedSheets.push({
        sheetName,
        extraction,
        context,
        source: "legacy-sheet",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Sheet ${sheetName}: ${message}`);
    }
  }

  let warehouseStockIndex = new Map<string, number>();
  let stockPrefetchSource = "list-stock.do";
  try {
    warehouseStockIndex = await fetchWarehouseStockIndex(accurateFetch, warehouse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(
      `Prefetch stok massal GD0BS via list-stock.do gagal: ${message}. Fallback ke get-stock.do per item.`,
    );
    stockPrefetchSource = "get-stock.do fallback";
  }

  for (const preparedSheet of preparedSheets) {
      const { sheetName, extraction, context, source } = preparedSheet;
    try {
      const stockMap = await prefetchSheetStocks(
        extraction.items,
        warehouse,
        accurateFetch,
        stockCache,
        warehouseStockIndex,
      );
      const adjustedItems = adjustSheetQuantitiesByStock(extraction.items, stockMap);
      reportRows.push(...buildSheetAdjustmentReport(sheetName, adjustedItems, context));

      const doc = buildPurchaseReturnDocFromSheet(
        sheetName,
        trxDate,
        context,
        warehouse,
        adjustedItems,
      );
      payload.push(doc);

      const adjustedCount = adjustedItems.filter(
        (item) => item.quantityAdjusted !== item.quantityExcel,
      ).length;
      const droppedCount = adjustedItems.filter((item) => item.quantityAdjusted <= 0).length;
      const summaryRow = {
        Sheet: sheetName,
        Sumber: source,
        Branch: context.branchName,
        VendorNo: context.vendorNo,
        "Item Valid": extraction.items.length,
        "Item Masuk Payload": doc.detailItem.length,
        "Item Disesuaikan": adjustedCount,
        "Item Tidak Masuk": droppedCount,
      };
      sheetSummaries.push(summaryRow);

      if (adjustedCount > 0 || droppedCount > 0) {
        warnings.push(
          `Sheet ${sheetName}: ${adjustedCount} item disesuaikan, ${droppedCount} item tidak masuk karena stok GD0BS.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Sheet ${sheetName}: ${message}`);
    }
  }

  if (payload.length === 0) {
    throw new Error(`Tidak ada sheet purchase return yang valid. ${warnings.join(" | ")}`);
  }

  return {
    payload,
    summaryMessage: `Purchase Return parser menyiapkan ${payload.length} dokumen dari ${workbook.SheetNames.length} sheet dengan gudang ${warehouse.name}.`,
    warnings,
    reportRows: reportRows.length > 0 ? reportRows : sheetSummaries,
    meta: {
      warehouseName: warehouse.name,
      warehouseCode: warehouse.code,
      stockIndexCount: warehouseStockIndex.size,
      stockPrefetchSource,
      parserPriority: "simple-sheet-first",
      sheetSummaries,
    },
  } satisfies WorkbookParseResult;
};
