/*
 * Parser + pure engine rekonsiliasi faktur penjualan Accurate dengan KINO.
 * Tidak melakukan DB/file I/O; caller memberi tiga buffer XLSX tervalidasi ukuran/MIME-nya.
 */
import * as XLSX from "xlsx";

export type ReconciliationStatus =
  | "MATCH"
  | "QTY_MISMATCH"
  | "VALUE_MISMATCH"
  | "QTY_AND_VALUE_MISMATCH"
  | "MISSING_INTERNAL"
  | "MISSING_PRINCIPAL"
  | "UNMAPPED_SKU"
  | "UNIT_CONVERSION_ERROR"
  | "INVALID_DATA";

export type AmountComponent = "gross" | "discount" | "dpp" | "tax" | "net";
export interface AmountDifference {
  component: AmountComponent;
  accurate: number;
  kino: number;
  difference: number;
}

type TransactionClass = "NORMAL" | "BONUS" | "RETURN";
type MappingStatus = "OK" | "UNMAPPED_SKU" | "UNIT_CONVERSION_ERROR";
type Row = unknown[];

export interface CanonicalSalesLine {
  source: "ACCURATE" | "PRINCIPAL";
  sourceRowNumber: number;
  documentNumber: string;
  orderNumber: string;
  transactionDate: string;
  customerCodeRaw: string;
  customerCodeInternal: string;
  salesmanCodeRaw: string;
  salesmanCodeInternal: string;
  productCodeRaw: string;
  productCodeInternal: string;
  transactionClass: TransactionClass;
  quantitySmallest: number;
  unitSmallest: string;
  grossAmount: number;
  discountAmount: number;
  dppAmount: number;
  taxAmount: number;
  netAmount: number;
  mappingStatus: MappingStatus;
}

export interface ReconciliationResult {
  orderNumber: string;
  internalProductCode: string;
  transactionClass: TransactionClass;
  accurateQuantity: number;
  principalQuantity: number;
  quantityDifference: number;
  accurateNet: number;
  principalNet: number;
  valueDifference: number;
  amountDifferences: AmountDifference[];
  status: ReconciliationStatus;
  warnings: string[];
  accurateSourceRows: number[];
  principalSourceRows: number[];
}

export interface ReconciliationOutput {
  accurateLines: CanonicalSalesLine[];
  kinoLines: CanonicalSalesLine[];
  results: ReconciliationResult[];
  summary: Record<ReconciliationStatus, number>;
}

const MONEY_SCALE = 10_000;
const UNIT_ALIASES: Record<string, string> = { BT: "BTL", BTL: "BTL", TUB: "TUBE", TUBE: "TUBE", INB: "BOX", BOX: "BOX" };
const STATUSES: ReconciliationStatus[] = ["MATCH", "QTY_MISMATCH", "VALUE_MISMATCH", "QTY_AND_VALUE_MISMATCH", "MISSING_INTERNAL", "MISSING_PRINCIPAL", "UNMAPPED_SKU", "UNIT_CONVERSION_ERROR", "INVALID_DATA"];

function text(value: unknown): string {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/[\u200B-\u200D\uFEFF]/g, "").trim().toUpperCase();
}

function unit(value: unknown): string {
  const normalized = text(value);
  return UNIT_ALIASES[normalized] ?? normalized;
}

function finite(value: unknown, label: string, row: number): number {
  if (value === null || value === undefined || text(value) === "") return 0;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(parsed)) throw new Error(`${label} tidak valid pada baris ${row}`);
  return parsed;
}

function money(value: unknown, label: string, row: number): number {
  const parsed = finite(value, label, row);
  const scaled = Math.round(parsed * MONEY_SCALE);
  if (!Number.isSafeInteger(scaled)) throw new Error(`${label} terlalu besar pada baris ${row}`);
  return scaled;
}

function isoDate(value: unknown, label: string, row: number): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000);
    if (Number.isNaN(date.getTime())) throw new Error(`${label} tidak valid pada baris ${row}`);
    return date.toISOString().slice(0, 10);
  }
  const normalized = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new Error(`${label} tidak valid pada baris ${row}`);
  return normalized;
}

function orderNumber(value: unknown, label: string, row: number): string {
  const matches = text(value).match(/1671-SOP-\d+/g) ?? [];
  if (matches.length !== 1) throw new Error(`${label} harus memuat tepat satu nomor order pada baris ${row}`);
  return matches[0];
}

function readRows(buffer: Buffer | Uint8Array, sheetName: string): Row[] {
  if (!buffer?.byteLength) throw new Error("File XLSX kosong");
  const workbook = XLSX.read(buffer, { type: "buffer", raw: true, cellFormula: false });
  const sheet = workbook.Sheets[sheetName];
  if (!sheet?.["!ref"]) throw new Error(`Sheet ${sheetName} tidak ditemukan atau kosong`);
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: false }) as Row[];
}

function headerIndex(rows: Row[], required: string[], maxRows = 10): { rowIndex: number; columns: Map<string, number> } {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, maxRows); rowIndex++) {
    const columns = new Map<string, number>();
    rows[rowIndex].forEach((value, index) => { if (text(value)) columns.set(text(value), index); });
    if (required.every((name) => columns.has(name))) return { rowIndex, columns };
  }
  throw new Error(`Header wajib tidak ditemukan: ${required.join(", ")}`);
}

function value(row: Row, columns: Map<string, number>, name: string): unknown {
  const index = columns.get(name);
  return index === undefined ? null : row[index];
}

function requiredText(row: Row, columns: Map<string, number>, name: string, rowNumber: number): string {
  const normalized = text(value(row, columns, name));
  if (!normalized) throw new Error(`${name} kosong pada baris ${rowNumber}`);
  return normalized;
}

function transactionClass(value: unknown): TransactionClass {
  const normalized = text(value);
  if (normalized.includes("RETUR") || normalized.includes("RETURN")) return "RETURN";
  if (normalized.includes("BONUS")) return "BONUS";
  return "NORMAL";
}

interface Mappings {
  products: Map<string, { internal: string; unit: string }>;
  customers: Map<string, string>;
  salesmen: Map<string, string>;
}

function mappingRows(workbook: XLSX.WorkBook, sheetName: string, required: string[]): { rows: Row[]; columns: Map<string, number>; start: number } {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet?.["!ref"]) throw new Error(`Sheet mapping ${sheetName} tidak ditemukan atau kosong`);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: false }) as Row[];
  const header = headerIndex(rows, required, 3);
  return { rows, columns: header.columns, start: header.rowIndex + 1 };
}

function makeUniqueMap(rows: Row[], columns: Map<string, number>, start: number, keyName: string, valueName: string, sheet: string): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = start; index < rows.length; index++) {
    const key = text(value(rows[index], columns, keyName));
    const mapped = text(value(rows[index], columns, valueName));
    if (!key && !mapped) continue;
    if (!mapped) continue;
    if (!key) throw new Error(`${sheet} tidak lengkap pada baris ${index + 1}`);
    if (result.has(key) && result.get(key) !== mapped) throw new Error(`${sheet} memiliki mapping konflik untuk ${key}`);
    result.set(key, mapped);
  }
  return result;
}

export function parseKinoMappings(buffer: Buffer | Uint8Array): Mappings {
  if (!buffer?.byteLength) throw new Error("File mapping kosong");
  const workbook = XLSX.read(buffer, { type: "buffer", raw: true, cellFormula: false });
  const productSheet = mappingRows(workbook, "Mapping_Prd", ["KODE ITEM", "KODE ALIAS", "SATUAN"]);
  const products = new Map<string, { internal: string; unit: string }>();
  for (let index = productSheet.start; index < productSheet.rows.length; index++) {
    const row = productSheet.rows[index];
    const alias = text(value(row, productSheet.columns, "KODE ALIAS"));
    const internal = text(value(row, productSheet.columns, "KODE ITEM"));
    const smallestUnit = unit(value(row, productSheet.columns, "SATUAN"));
    if (!alias && !internal && !smallestUnit) continue;
    if (!alias || !internal || !smallestUnit) throw new Error(`Mapping_Prd tidak lengkap pada baris ${index + 1}`);
    const existing = products.get(alias);
    if (existing && (existing.internal !== internal || existing.unit !== smallestUnit)) throw new Error(`Mapping_Prd memiliki mapping konflik untuk ${alias}`);
    products.set(alias, { internal, unit: smallestUnit });
  }
  const customerSheet = mappingRows(workbook, "Mapping_Customer", ["CODE KINO", "CODE INTERNAL"]);
  const salesmanSheet = mappingRows(workbook, "Mapping_Sls", ["SLSMAN_ID", "CODE INTERNAL"]);
  return {
    products,
    customers: makeUniqueMap(customerSheet.rows, customerSheet.columns, customerSheet.start, "CODE KINO", "CODE INTERNAL", "Mapping_Customer"),
    salesmen: makeUniqueMap(salesmanSheet.rows, salesmanSheet.columns, salesmanSheet.start, "SLSMAN_ID", "CODE INTERNAL", "Mapping_Sls"),
  };
}

export function parseAccurateSales(buffer: Buffer | Uint8Array): CanonicalSalesLine[] {
  const rows = readRows(buffer, "Rincian Faktur Penjualan");
  const required = ["NO_NOTA", "TANGGAL", "KODE PELANGGAN INDUK", "KODE_SALESMAN", "KODE_BARANG", "QTY_SATUANKECIL", "SATUAN_KECIL", "NILAI JUAL", "POTONGAN", "DPP", "NILAI_PAJAK", "JUMLAH", "REM", "JENIS_TRANSAKSI"];
  const header = headerIndex(rows, required);
  return rows.slice(header.rowIndex + 1).map((row, offset) => {
    const sourceRowNumber = header.rowIndex + offset + 2;
    const quantity = finite(value(row, header.columns, "QTY_SATUANKECIL"), "QTY_SATUANKECIL", sourceRowNumber);
    if (quantity < 0) throw new Error(`QTY_SATUANKECIL negatif pada baris ${sourceRowNumber}`);
    return {
      source: "ACCURATE",
      sourceRowNumber,
      documentNumber: requiredText(row, header.columns, "NO_NOTA", sourceRowNumber),
      orderNumber: orderNumber(value(row, header.columns, "REM"), "REM", sourceRowNumber),
      transactionDate: isoDate(value(row, header.columns, "TANGGAL"), "TANGGAL", sourceRowNumber),
      customerCodeRaw: requiredText(row, header.columns, "KODE PELANGGAN INDUK", sourceRowNumber),
      customerCodeInternal: requiredText(row, header.columns, "KODE PELANGGAN INDUK", sourceRowNumber),
      salesmanCodeRaw: requiredText(row, header.columns, "KODE_SALESMAN", sourceRowNumber),
      salesmanCodeInternal: requiredText(row, header.columns, "KODE_SALESMAN", sourceRowNumber),
      productCodeRaw: requiredText(row, header.columns, "KODE_BARANG", sourceRowNumber),
      productCodeInternal: requiredText(row, header.columns, "KODE_BARANG", sourceRowNumber),
      transactionClass: transactionClass(value(row, header.columns, "JENIS_TRANSAKSI")),
      quantitySmallest: quantity,
      unitSmallest: unit(requiredText(row, header.columns, "SATUAN_KECIL", sourceRowNumber)),
      grossAmount: money(value(row, header.columns, "NILAI JUAL"), "NILAI JUAL", sourceRowNumber),
      discountAmount: money(value(row, header.columns, "POTONGAN"), "POTONGAN", sourceRowNumber),
      dppAmount: money(value(row, header.columns, "DPP"), "DPP", sourceRowNumber),
      taxAmount: money(value(row, header.columns, "NILAI_PAJAK"), "NILAI_PAJAK", sourceRowNumber),
      netAmount: money(value(row, header.columns, "JUMLAH"), "JUMLAH", sourceRowNumber),
      mappingStatus: "OK",
    };
  });
}

export function parseKinoSales(buffer: Buffer | Uint8Array, mappings: Mappings): CanonicalSalesLine[] {
  const rows = readRows(buffer, "Sheet1");
  const required = ["CUSTCODE1", "ORDER_NO", "INVOICE_NO", "INVOICE_DATE", "PRODUCT_CODE", "SALESMAN_ID", "FLAG_BONUS", "INVOICE_QTY", "INVOICE_GROSS", "INVOICE_TOTALLINEDISC", "INVOICE_PROMO", "INVOICE_CASHDISC", "INVOICE_TAX", "INVOICE_NET", "PRD_UOM1"];
  const header = headerIndex(rows, required);
  const output: CanonicalSalesLine[] = [];
  for (let index = header.rowIndex + 1; index < rows.length; index++) {
    const row = rows[index];
    const sourceRowNumber = index + 1;
    const first = text(row.find((cell) => text(cell)));
    if (!first || first.startsWith("TOTAL FOR") || first === "GRAND TOTAL") continue;
    const rawProduct = requiredText(row, header.columns, "PRODUCT_CODE", sourceRowNumber);
    const mappedProduct = mappings.products.get(rawProduct);
    const sourceUnit = unit(requiredText(row, header.columns, "PRD_UOM1", sourceRowNumber));
    const flag = requiredText(row, header.columns, "FLAG_BONUS", sourceRowNumber);
    if (flag !== "Y" && flag !== "N") throw new Error(`FLAG_BONUS harus Y/N pada baris ${sourceRowNumber}`);
    const quantity = finite(value(row, header.columns, "INVOICE_QTY"), "INVOICE_QTY", sourceRowNumber);
    if (quantity < 0) throw new Error(`INVOICE_QTY negatif pada baris ${sourceRowNumber}`);
    const gross = money(value(row, header.columns, "INVOICE_GROSS"), "INVOICE_GROSS", sourceRowNumber);
    const discount = money(value(row, header.columns, "INVOICE_TOTALLINEDISC"), "INVOICE_TOTALLINEDISC", sourceRowNumber)
      + money(value(row, header.columns, "INVOICE_PROMO"), "INVOICE_PROMO", sourceRowNumber)
      + money(value(row, header.columns, "INVOICE_CASHDISC"), "INVOICE_CASHDISC", sourceRowNumber);
    const tax = money(value(row, header.columns, "INVOICE_TAX"), "INVOICE_TAX", sourceRowNumber);
    const net = money(value(row, header.columns, "INVOICE_NET"), "INVOICE_NET", sourceRowNumber);
    const mappingStatus: MappingStatus = !mappedProduct ? "UNMAPPED_SKU" : sourceUnit !== mappedProduct.unit ? "UNIT_CONVERSION_ERROR" : "OK";
    output.push({
      source: "PRINCIPAL",
      sourceRowNumber,
      documentNumber: requiredText(row, header.columns, "INVOICE_NO", sourceRowNumber),
      orderNumber: orderNumber(value(row, header.columns, "ORDER_NO"), "ORDER_NO", sourceRowNumber),
      transactionDate: isoDate(value(row, header.columns, "INVOICE_DATE"), "INVOICE_DATE", sourceRowNumber),
      customerCodeRaw: requiredText(row, header.columns, "CUSTCODE1", sourceRowNumber),
      customerCodeInternal: mappings.customers.get(requiredText(row, header.columns, "CUSTCODE1", sourceRowNumber)) ?? "",
      salesmanCodeRaw: requiredText(row, header.columns, "SALESMAN_ID", sourceRowNumber),
      salesmanCodeInternal: mappings.salesmen.get(requiredText(row, header.columns, "SALESMAN_ID", sourceRowNumber)) ?? "",
      productCodeRaw: rawProduct,
      productCodeInternal: mappedProduct?.internal ?? `UNMAPPED:${rawProduct}`,
      transactionClass: flag === "Y" ? "BONUS" : "NORMAL",
      quantitySmallest: quantity,
      unitSmallest: mappedProduct?.unit ?? sourceUnit,
      grossAmount: gross,
      discountAmount: discount,
      dppAmount: gross - discount,
      taxAmount: tax,
      netAmount: net,
      mappingStatus,
    });
  }
  return output;
}

interface Aggregate {
  orderNumber: string;
  productCode: string;
  transactionClass: TransactionClass;
  quantity: number;
  gross: number;
  discount: number;
  dpp: number;
  tax: number;
  net: number;
  mappingStatus: MappingStatus;
  warnings: Set<string>;
  rows: number[];
}

function aggregate(lines: CanonicalSalesLine[]): Map<string, Aggregate> {
  const result = new Map<string, Aggregate>();
  for (const line of lines) {
    const key = `${line.orderNumber}|${line.productCodeInternal}|${line.transactionClass}`;
    const current = result.get(key) ?? {
      orderNumber: line.orderNumber, productCode: line.productCodeInternal, transactionClass: line.transactionClass,
      quantity: 0, gross: 0, discount: 0, dpp: 0, tax: 0, net: 0, mappingStatus: "OK", warnings: new Set<string>(), rows: [],
    };
    current.quantity += line.quantitySmallest;
    current.gross += line.grossAmount;
    current.discount += line.discountAmount;
    current.dpp += line.dppAmount;
    current.tax += line.taxAmount;
    current.net += line.netAmount;
    current.rows.push(line.sourceRowNumber);
    if (line.mappingStatus !== "OK") current.mappingStatus = line.mappingStatus;
    if (line.source === "PRINCIPAL" && !line.customerCodeInternal) current.warnings.add("UNMAPPED_CUSTOMER");
    if (line.source === "PRINCIPAL" && !line.salesmanCodeInternal) current.warnings.add("UNMAPPED_SALESMAN");
    result.set(key, current);
  }
  return result;
}

function rupiah(scaled: number): number {
  return scaled / MONEY_SCALE;
}

export function reconcileKinoSales(
  accurateBuffer: Buffer | Uint8Array,
  kinoBuffer: Buffer | Uint8Array,
  mappingBuffer: Buffer | Uint8Array,
  options: { valueTolerance?: number } = {},
): ReconciliationOutput {
  const tolerance = Math.round((options.valueTolerance ?? 1) * MONEY_SCALE);
  if (!Number.isSafeInteger(tolerance) || tolerance < 0) throw new Error("valueTolerance tidak valid");
  const mappings = parseKinoMappings(mappingBuffer);
  const accurateLines = parseAccurateSales(accurateBuffer);
  const kinoLines = parseKinoSales(kinoBuffer, mappings);
  const accurate = aggregate(accurateLines);
  const kino = aggregate(kinoLines);
  const results: ReconciliationResult[] = [];
  for (const key of new Set([...accurate.keys(), ...kino.keys()])) {
    const left = accurate.get(key);
    const right = kino.get(key);
    const quantityDifference = (left?.quantity ?? 0) - (right?.quantity ?? 0);
    const amountPairs: Array<[AmountComponent, number, number]> = left && right ? [
      ["gross", left.gross, right.gross], ["discount", left.discount, right.discount],
      ["dpp", left.dpp, right.dpp], ["tax", left.tax, right.tax], ["net", left.net, right.net],
    ] : [];
    const amountDifferences = amountPairs
      .filter(([, accurate, kino]) => Math.abs(accurate - kino) > tolerance)
      .map(([component, accurate, kino]) => ({
        component,
        accurate: rupiah(accurate),
        kino: rupiah(kino),
        difference: rupiah(accurate - kino),
      }));
    const valueMismatch = amountDifferences.length > 0;
    let status: ReconciliationStatus;
    if (right?.mappingStatus === "UNMAPPED_SKU") status = "UNMAPPED_SKU";
    else if (right?.mappingStatus === "UNIT_CONVERSION_ERROR") status = "UNIT_CONVERSION_ERROR";
    else if (!left) status = "MISSING_INTERNAL";
    else if (!right) status = "MISSING_PRINCIPAL";
    else if (quantityDifference !== 0 && valueMismatch) status = "QTY_AND_VALUE_MISMATCH";
    else if (quantityDifference !== 0) status = "QTY_MISMATCH";
    else if (valueMismatch) status = "VALUE_MISMATCH";
    else status = "MATCH";
    results.push({
      orderNumber: (left ?? right)!.orderNumber,
      internalProductCode: (left ?? right)!.productCode,
      transactionClass: (left ?? right)!.transactionClass,
      accurateQuantity: left?.quantity ?? 0,
      principalQuantity: right?.quantity ?? 0,
      quantityDifference,
      accurateNet: rupiah(left?.net ?? 0),
      principalNet: rupiah(right?.net ?? 0),
      valueDifference: rupiah((left?.net ?? 0) - (right?.net ?? 0)),
      amountDifferences,
      status,
      warnings: [...new Set([...(left?.warnings ?? []), ...(right?.warnings ?? [])])],
      accurateSourceRows: left?.rows ?? [],
      principalSourceRows: right?.rows ?? [],
    });
  }
  const summary = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<ReconciliationStatus, number>;
  for (const result of results) summary[result.status]++;
  return { accurateLines, kinoLines, results, summary };
}
