/*
 * Parser + pure engine rekonsiliasi faktur penjualan Accurate dengan KINO.
 * Tidak melakukan DB/file I/O; caller memberi buffer XLSX tervalidasi.
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
type MappingStatus =
  "OK" | "UNMAPPED_SKU" | "UNIT_CONVERSION_ERROR" | "INVALID_DATA";
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
const UNIT_ALIASES: Record<string, string> = {
  BT: "BTL",
  BTL: "BTL",
  TUB: "TUBE",
  TUBE: "TUBE",
  INB: "BOX",
  BOX: "BOX",
};
const STATUSES: ReconciliationStatus[] = [
  "MATCH",
  "QTY_MISMATCH",
  "VALUE_MISMATCH",
  "QTY_AND_VALUE_MISMATCH",
  "MISSING_INTERNAL",
  "MISSING_PRINCIPAL",
  "UNMAPPED_SKU",
  "UNIT_CONVERSION_ERROR",
  "INVALID_DATA",
];

function text(value: unknown): string {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .toUpperCase();
}
function unit(value: unknown): string {
  const normalized = text(value);
  return UNIT_ALIASES[normalized] ?? normalized;
}
function finite(value: unknown, label: string, row: number): number {
  if (value == null || text(value) === "") return 0;
  const parsed =
    typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(parsed))
    throw new Error(`${label} tidak valid pada baris ${row}`);
  return parsed;
}
function money(value: unknown, label: string, row: number): number {
  const scaled = Math.round(finite(value, label, row) * MONEY_SCALE);
  if (!Number.isSafeInteger(scaled))
    throw new Error(`${label} terlalu besar pada baris ${row}`);
  return scaled;
}
function isoDate(value: unknown, label: string, row: number): string {
  if (typeof value === "number" && Number.isFinite(value))
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000)
      .toISOString()
      .slice(0, 10);
  const normalized = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized))
    throw new Error(`${label} tidak valid pada baris ${row}`);
  return normalized;
}
function orderNumber(value: unknown, label: string, row: number, noun = "order"): string {
  const normalized = text(value),
    kino = normalized.match(/1671-SOP-\d+/g) ?? [],
    godrej = [...normalized.matchAll(/(?:FK\/BFG|FK|BFG)-(\d+)/g)].map(
      (match) => `BFG-${match[1]}`,
    ),
    shinzui = normalized.match(/INVGTS\d+-\d+-\d+/g) ?? [],
    motasa = normalized.match(/(?<![A-Z0-9])MK\d{10}(?![A-Z0-9])/g) ?? [],
    matches = [...kino, ...godrej, ...shinzui, ...motasa];
  if (matches.length !== 1)
    throw new Error(
      `${label} harus memuat tepat satu nomor ${noun} pada baris ${row}`,
    );
  return matches[0];
}
function godrejOrderNumber(value: unknown, label: string, row: number): string {
  const matches = [...text(value).matchAll(/(?:FK\/BFG|FK|BFG)-(\d+)/g)].map(
    (match) => `BFG-${match[1]}`,
  );
  if (matches.length !== 1)
    throw new Error(
      `${label} harus memuat tepat satu nomor invoice pada baris ${row}`,
    );
  return matches[0];
}
export function cussonsOrderNumber(
  value: unknown,
  label: string,
  row: number,
): string {
  const matches = text(value).match(/(?<![A-Z0-9])TI\d{6}(?![A-Z0-9])/g) ?? [];
  if (matches.length !== 1)
    throw new Error(
      `${label} baris ${row} harus memiliki tepat satu nomor faktur TI`,
    );
  return matches[0];
}
function readRows(buffer: Buffer | Uint8Array, sheetName: string): Row[] {
  if (!buffer?.byteLength) throw new Error("File XLSX kosong");
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    raw: true,
    cellFormula: false,
  });
  const sheet = workbook.Sheets[sheetName];
  if (!sheet?.["!ref"])
    throw new Error(`Sheet ${sheetName} tidak ditemukan atau kosong`);
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  }) as Row[];
}
function headerIndex(
  rows: Row[],
  required: string[],
  maxRows = 10,
): { rowIndex: number; columns: Map<string, number> } {
  for (
    let rowIndex = 0;
    rowIndex < Math.min(rows.length, maxRows);
    rowIndex++
  ) {
    const columns = new Map<string, number>();
    rows[rowIndex].forEach((value, index) => {
      if (text(value)) columns.set(text(value), index);
    });
    if (required.every((name) => columns.has(name)))
      return { rowIndex, columns };
  }
  throw new Error(`Header wajib tidak ditemukan: ${required.join(", ")}`);
}
function value(row: Row, columns: Map<string, number>, name: string): unknown {
  const index = columns.get(name);
  return index === undefined ? null : row[index];
}
function requiredText(
  row: Row,
  columns: Map<string, number>,
  name: string,
  rowNumber: number,
): string {
  const normalized = text(value(row, columns, name));
  if (!normalized) throw new Error(`${name} kosong pada baris ${rowNumber}`);
  return normalized;
}
function transactionClass(value: unknown): TransactionClass {
  const normalized = text(value);
  return normalized.includes("RETUR") || normalized.includes("RETURN")
    ? "RETURN"
    : normalized.includes("BONUS")
      ? "BONUS"
      : "NORMAL";
}

interface Mappings {
  products: Map<string, { internal: string; unit: string }>;
  customers: Map<string, string>;
  salesmen: Map<string, string>;
}
interface GodrejMappings {
  products: Map<string, Array<{ internal: string; unit: string }>>;
}
interface ShinzuiProductMapping {
  internal: string;
  unit: string;
  caseSize: number | null;
  caseSizeError: string | null;
  sourceRowNumber: number;
}
interface ShinzuiMappings {
  products: Map<string, ShinzuiProductMapping[]>;
}
interface MotasaProductMapping {
  unit: string;
  caseSize: number | null;
  mappingStatus: MappingStatus;
}
interface MotasaMappings {
  products: Map<string, MotasaProductMapping>;
}
export interface CussonsProductMapping {
  productCodeInternal: string;
  unit: string;
  caseSize: number | null;
  mappingStatus: MappingStatus;
}
export interface CussonsMappings {
  products: Map<string, CussonsProductMapping>;
}
function mappingRows(
  workbook: XLSX.WorkBook,
  sheetName: string,
  required: string[],
  headerRow?: number,
) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet?.["!ref"])
    throw new Error(`Sheet mapping ${sheetName} tidak ditemukan atau kosong`);
  const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: headerRow !== undefined,
      ...(headerRow === undefined ? {} : { range: 0 }),
    }) as Row[],
    offset = headerRow === undefined ? 0 : headerRow - 1,
    header = headerIndex(
      rows.slice(offset),
      required,
      headerRow === undefined ? 3 : 1,
    );
  return {
    rows,
    columns: header.columns,
    start: header.rowIndex + offset + 1,
  };
}
function makeUniqueMap(
  rows: Row[],
  columns: Map<string, number>,
  start: number,
  keyName: string,
  valueName: string,
  sheet: string,
): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = start; index < rows.length; index++) {
    const key = text(value(rows[index], columns, keyName)),
      mapped = text(value(rows[index], columns, valueName));
    if (!key && !mapped) continue;
    if (!mapped) continue;
    if (!key) throw new Error(`${sheet} tidak lengkap pada baris ${index + 1}`);
    if (result.has(key) && result.get(key) !== mapped)
      throw new Error(`${sheet} memiliki mapping konflik untuk ${key}`);
    result.set(key, mapped);
  }
  return result;
}

export function parseKinoMappings(buffer: Buffer | Uint8Array): Mappings {
  if (!buffer?.byteLength) throw new Error("File mapping kosong");
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    raw: true,
    cellFormula: false,
  });
  const productSheet = mappingRows(workbook, "Mapping_Prd", [
    "KODE ITEM",
    "KODE ALIAS",
    "SATUAN",
  ]);
  const products = new Map<string, { internal: string; unit: string }>();
  for (
    let index = productSheet.start;
    index < productSheet.rows.length;
    index++
  ) {
    const row = productSheet.rows[index],
      alias = text(value(row, productSheet.columns, "KODE ALIAS")),
      internal = text(value(row, productSheet.columns, "KODE ITEM")),
      smallestUnit = unit(value(row, productSheet.columns, "SATUAN"));
    if (!alias && !internal && !smallestUnit) continue;
    if (!alias || !internal || !smallestUnit)
      throw new Error(`Mapping_Prd tidak lengkap pada baris ${index + 1}`);
    const existing = products.get(alias);
    if (
      existing &&
      (existing.internal !== internal || existing.unit !== smallestUnit)
    )
      throw new Error(`Mapping_Prd memiliki mapping konflik untuk ${alias}`);
    products.set(alias, { internal, unit: smallestUnit });
  }
  const customerSheet = mappingRows(workbook, "Mapping_Customer", [
    "CODE KINO",
    "CODE INTERNAL",
  ]);
  const salesmanSheet = mappingRows(workbook, "Mapping_Sls", [
    "SLSMAN_ID",
    "CODE INTERNAL",
  ]);
  return {
    products,
    customers: makeUniqueMap(
      customerSheet.rows,
      customerSheet.columns,
      customerSheet.start,
      "CODE KINO",
      "CODE INTERNAL",
      "Mapping_Customer",
    ),
    salesmen: makeUniqueMap(
      salesmanSheet.rows,
      salesmanSheet.columns,
      salesmanSheet.start,
      "SLSMAN_ID",
      "CODE INTERNAL",
      "Mapping_Sls",
    ),
  };
}

export function parseGodrejMappings(
  buffer: Buffer | Uint8Array,
): GodrejMappings {
  if (!buffer?.byteLength) throw new Error("File mapping kosong");
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    raw: true,
    cellFormula: false,
  });
  const sheet = mappingRows(workbook, "Pvt Map 1", [
    "KODE PCPL",
    "KODE BARANG WIN2",
    "SATUAN FIX WIN",
  ]);
  const products = new Map<string, Array<{ internal: string; unit: string }>>();
  for (let index = sheet.start; index < sheet.rows.length; index++) {
    const row = sheet.rows[index],
      principal = text(value(row, sheet.columns, "KODE PCPL")),
      internal = text(value(row, sheet.columns, "KODE BARANG WIN2")),
      smallestUnit = unit(value(row, sheet.columns, "SATUAN FIX WIN"));
    if (
      [principal, internal, smallestUnit].every(
        (entry) => !entry || entry === "(BLANK)" || entry === "0",
      )
    )
      continue;
    if (!principal || !internal || !smallestUnit)
      throw new Error(`Pvt Map 1 tidak lengkap pada baris ${index + 1}`);
    const mapped = products.get(principal) ?? [];
    if (
      !mapped.some(
        (entry) => entry.internal === internal && entry.unit === smallestUnit,
      )
    )
      mapped.push({ internal, unit: smallestUnit });
    products.set(principal, mapped);
  }
  return { products };
}

export function parseShinzuiMappings(
  buffer: Buffer | Uint8Array,
): ShinzuiMappings {
  if (!buffer?.byteLength) throw new Error("File mapping kosong");
  const workbook = XLSX.read(buffer, {
      type: "buffer",
      raw: true,
      cellFormula: false,
    }),
    sheet = mappingRows(workbook, "Pvt Map 1", [
      "KODE PCPL",
      "KODE BARANG WIN2",
      "SATUAN FIX WIN",
      "ISI/CTN",
    ]),
    products = new Map<string, ShinzuiProductMapping[]>();
  for (let index = sheet.start; index < sheet.rows.length; index++) {
    const row = sheet.rows[index],
      principal = text(value(row, sheet.columns, "KODE PCPL")),
      internal = text(value(row, sheet.columns, "KODE BARANG WIN2")),
      smallestUnit = unit(value(row, sheet.columns, "SATUAN FIX WIN")),
      rawCaseSize = value(row, sheet.columns, "ISI/CTN"),
      normalizedCaseSize = text(rawCaseSize),
      entries = [principal, internal, smallestUnit, normalizedCaseSize];
    if (
      entries.every((entry) => !entry || entry === "(BLANK)" || entry === "0")
    )
      continue;
    if (!principal || principal === "(BLANK)" || principal === "0") continue;
    if (
      [principal, internal, smallestUnit].some(
        (entry) => !entry || entry === "(BLANK)" || entry === "0",
      ) ||
      !normalizedCaseSize ||
      normalizedCaseSize === "(BLANK)"
    )
      throw new Error(`Pvt Map 1 tidak lengkap pada baris ${index + 1}`);
    let caseSize: number | null = null,
      caseSizeError: string | null = null;
    try {
      caseSize = finite(rawCaseSize, "ISI/CTN", index + 1);
      if (caseSize <= 0) {
        caseSize = null;
        caseSizeError = `ISI/CTN harus positif pada baris ${index + 1}`;
      }
    } catch {
      caseSizeError = `ISI/CTN tidak valid pada baris ${index + 1}`;
    }
    const mapped = products.get(principal) ?? [];
    if (
      !mapped.some(
        (entry) =>
          entry.internal === internal &&
          entry.unit === smallestUnit &&
          entry.caseSize === caseSize &&
          entry.caseSizeError === caseSizeError,
      )
    )
      mapped.push({
        internal,
        unit: smallestUnit,
        caseSize,
        caseSizeError,
        sourceRowNumber: index + 1,
      });
    products.set(principal, mapped);
  }
  return { products };
}

export function parseMotasaMappings(
  buffer: Buffer | Uint8Array,
): MotasaMappings {
  if (!buffer?.byteLength) throw new Error("File mapping kosong");
  const workbook = XLSX.read(buffer, {
      type: "buffer",
      raw: true,
      cellFormula: false,
    }),
    sheet = mappingRows(
      workbook,
      "Form Fix",
      ["KODE BARANG WIN2", "ISI/CTN", "SATUAN FIX WIN"],
      5,
    ),
    products = new Map<string, MotasaProductMapping>();

  for (let index = sheet.start; index < sheet.rows.length; index++) {
    const row = sheet.rows[index],
      internal = text(value(row, sheet.columns, "KODE BARANG WIN2")),
      smallestUnit = unit(value(row, sheet.columns, "SATUAN FIX WIN")),
      rawCaseSize = value(row, sheet.columns, "ISI/CTN");
    if (!internal && !smallestUnit && !text(rawCaseSize)) continue;
    if (!internal)
      throw new Error(`KODE BARANG WIN2 kosong pada baris ${index + 1}`);

    let caseSize: number | null = null,
      mappingStatus: MappingStatus =
        smallestUnit === "KRT" || smallestUnit === "SCH"
          ? "OK"
          : "UNIT_CONVERSION_ERROR";
    try {
      caseSize = finite(rawCaseSize, "ISI/CTN", index + 1);
    } catch {
      if (smallestUnit === "KRT")
        mappingStatus = "UNIT_CONVERSION_ERROR";
    }
    if (smallestUnit === "KRT" && (!caseSize || caseSize <= 0))
      mappingStatus = "UNIT_CONVERSION_ERROR";

    const next = { unit: smallestUnit, caseSize, mappingStatus },
      existing = products.get(internal);
    if (
      existing &&
      (existing.unit !== next.unit ||
        ((existing.unit !== "SCH" || next.unit !== "SCH") &&
          existing.caseSize !== next.caseSize))
    )
      products.set(internal, { ...existing, mappingStatus: "INVALID_DATA" });
    else if (!existing)
      products.set(internal, next);
  }
  return { products };
}

export function parseCussonsMappings(
  buffer: Buffer | Uint8Array,
): CussonsMappings {
  if (!buffer?.byteLength) throw new Error("File mapping kosong");
  const workbook = XLSX.read(buffer, {
      type: "buffer",
      raw: true,
      cellFormula: false,
    }),
    sheet = mappingRows(
      workbook,
      "Form Fix",
      ["KODE PCPL", "ISI/CTN", "SATUAN FIX WIN", "KODE BARANG WIN2"],
      5,
    ),
    products = new Map<string, CussonsProductMapping>();

  for (let index = sheet.start; index < sheet.rows.length; index++) {
    const row = sheet.rows[index],
      principal = text(value(row, sheet.columns, "KODE PCPL"));
    if (!principal || principal === "(BLANK)") continue;

    const productCodeInternal = text(
        value(row, sheet.columns, "KODE BARANG WIN2"),
      ),
      smallestUnit = unit(value(row, sheet.columns, "SATUAN FIX WIN")),
      rawCaseSize = value(row, sheet.columns, "ISI/CTN");
    let caseSize: number | null = null,
      mappingStatus: MappingStatus = "OK";
    try {
      if (text(rawCaseSize))
        caseSize = finite(rawCaseSize, "ISI/CTN", index + 1);
    } catch {
      // Pack hanya wajib saat baris CSV memakai CS.
    }
    if (!productCodeInternal) mappingStatus = "INVALID_DATA";
    else if (!smallestUnit) mappingStatus = "UNIT_CONVERSION_ERROR";

    const next = {
        productCodeInternal,
        unit: smallestUnit,
        caseSize,
        mappingStatus,
      },
      existing = products.get(principal);
    if (
      existing &&
      (existing.productCodeInternal !== next.productCodeInternal ||
        existing.unit !== next.unit ||
        existing.caseSize !== next.caseSize)
    )
      products.set(principal, { ...existing, mappingStatus: "INVALID_DATA" });
    else if (!existing) products.set(principal, next);
  }
  return { products };
}

export type AccurateParseOptions = {
  orderNumber?: (value: unknown, label: string, row: number) => string;
};

export function parseAccurateSales(
  buffer: Buffer | Uint8Array,
  options: AccurateParseOptions = {},
): CanonicalSalesLine[] {
  const rows = readRows(buffer, "Rincian Faktur Penjualan");
  const required = [
    "NO_NOTA",
    "TANGGAL",
    "KODE PELANGGAN INDUK",
    "KODE_SALESMAN",
    "KODE_BARANG",
    "QTY_SATUANKECIL",
    "SATUAN_KECIL",
    "NILAI JUAL",
    "POTONGAN",
    "DPP",
    "NILAI_PAJAK",
    "JUMLAH",
    "REM",
    "JENIS_TRANSAKSI",
  ];
  const header = headerIndex(rows, required);
  return rows.slice(header.rowIndex + 1).map((row, offset) => {
    const sourceRowNumber = header.rowIndex + offset + 2,
      quantity = finite(
        value(row, header.columns, "QTY_SATUANKECIL"),
        "QTY_SATUANKECIL",
        sourceRowNumber,
      );
    if (quantity < 0)
      throw new Error(`QTY_SATUANKECIL negatif pada baris ${sourceRowNumber}`);
    const customer = requiredText(
        row,
        header.columns,
        "KODE PELANGGAN INDUK",
        sourceRowNumber,
      ),
      salesman = requiredText(
        row,
        header.columns,
        "KODE_SALESMAN",
        sourceRowNumber,
      ),
      product = requiredText(
        row,
        header.columns,
        "KODE_BARANG",
        sourceRowNumber,
      );
    return {
      source: "ACCURATE",
      sourceRowNumber,
      documentNumber: requiredText(
        row,
        header.columns,
        "NO_NOTA",
        sourceRowNumber,
      ),
      orderNumber: (options.orderNumber ?? orderNumber)(
        value(row, header.columns, "REM"),
        "REM",
        sourceRowNumber,
      ),
      transactionDate: isoDate(
        value(row, header.columns, "TANGGAL"),
        "TANGGAL",
        sourceRowNumber,
      ),
      customerCodeRaw: customer,
      customerCodeInternal: customer,
      salesmanCodeRaw: salesman,
      salesmanCodeInternal: salesman,
      productCodeRaw: product,
      productCodeInternal: product,
      transactionClass: transactionClass(
        value(row, header.columns, "JENIS_TRANSAKSI"),
      ),
      quantitySmallest: quantity,
      unitSmallest: unit(
        requiredText(row, header.columns, "SATUAN_KECIL", sourceRowNumber),
      ),
      grossAmount: money(
        value(row, header.columns, "NILAI JUAL"),
        "NILAI JUAL",
        sourceRowNumber,
      ),
      discountAmount: money(
        value(row, header.columns, "POTONGAN"),
        "POTONGAN",
        sourceRowNumber,
      ),
      dppAmount: money(
        value(row, header.columns, "DPP"),
        "DPP",
        sourceRowNumber,
      ),
      taxAmount: money(
        value(row, header.columns, "NILAI_PAJAK"),
        "NILAI_PAJAK",
        sourceRowNumber,
      ),
      netAmount: money(
        value(row, header.columns, "JUMLAH"),
        "JUMLAH",
        sourceRowNumber,
      ),
      mappingStatus: "OK",
    };
  });
}

export function parseKinoSales(
  buffer: Buffer | Uint8Array,
  mappings: Mappings,
): CanonicalSalesLine[] {
  const rows = readRows(buffer, "Sheet1"),
    required = [
      "CUSTCODE1",
      "ORDER_NO",
      "INVOICE_NO",
      "INVOICE_DATE",
      "PRODUCT_CODE",
      "SALESMAN_ID",
      "FLAG_BONUS",
      "INVOICE_QTY",
      "INVOICE_GROSS",
      "INVOICE_TOTALLINEDISC",
      "INVOICE_PROMO",
      "INVOICE_CASHDISC",
      "INVOICE_TAX",
      "INVOICE_NET",
      "PRD_UOM1",
    ],
    header = headerIndex(rows, required),
    output: CanonicalSalesLine[] = [];
  for (let index = header.rowIndex + 1; index < rows.length; index++) {
    const row = rows[index],
      sourceRowNumber = index + 1,
      first = text(row.find((cell) => text(cell)));
    if (!first || first.startsWith("TOTAL FOR") || first === "GRAND TOTAL")
      continue;
    const rawProduct = requiredText(
        row,
        header.columns,
        "PRODUCT_CODE",
        sourceRowNumber,
      ),
      mappedProduct = mappings.products.get(rawProduct),
      sourceUnit = unit(
        requiredText(row, header.columns, "PRD_UOM1", sourceRowNumber),
      ),
      flag = requiredText(row, header.columns, "FLAG_BONUS", sourceRowNumber);
    if (flag !== "Y" && flag !== "N")
      throw new Error(`FLAG_BONUS harus Y/N pada baris ${sourceRowNumber}`);
    const quantity = finite(
      value(row, header.columns, "INVOICE_QTY"),
      "INVOICE_QTY",
      sourceRowNumber,
    );
    if (quantity < 0)
      throw new Error(`INVOICE_QTY negatif pada baris ${sourceRowNumber}`);
    const gross = money(
        value(row, header.columns, "INVOICE_GROSS"),
        "INVOICE_GROSS",
        sourceRowNumber,
      ),
      discount =
        money(
          value(row, header.columns, "INVOICE_TOTALLINEDISC"),
          "INVOICE_TOTALLINEDISC",
          sourceRowNumber,
        ) +
        money(
          value(row, header.columns, "INVOICE_PROMO"),
          "INVOICE_PROMO",
          sourceRowNumber,
        ) +
        money(
          value(row, header.columns, "INVOICE_CASHDISC"),
          "INVOICE_CASHDISC",
          sourceRowNumber,
        ),
      tax = money(
        value(row, header.columns, "INVOICE_TAX"),
        "INVOICE_TAX",
        sourceRowNumber,
      ),
      net = money(
        value(row, header.columns, "INVOICE_NET"),
        "INVOICE_NET",
        sourceRowNumber,
      ),
      mappingStatus: MappingStatus = !mappedProduct
        ? "UNMAPPED_SKU"
        : sourceUnit !== mappedProduct.unit
          ? "UNIT_CONVERSION_ERROR"
          : "OK",
      customer = requiredText(
        row,
        header.columns,
        "CUSTCODE1",
        sourceRowNumber,
      ),
      salesman = requiredText(
        row,
        header.columns,
        "SALESMAN_ID",
        sourceRowNumber,
      );
    output.push({
      source: "PRINCIPAL",
      sourceRowNumber,
      documentNumber: requiredText(
        row,
        header.columns,
        "INVOICE_NO",
        sourceRowNumber,
      ),
      orderNumber: orderNumber(
        value(row, header.columns, "ORDER_NO"),
        "ORDER_NO",
        sourceRowNumber,
      ),
      transactionDate: isoDate(
        value(row, header.columns, "INVOICE_DATE"),
        "INVOICE_DATE",
        sourceRowNumber,
      ),
      customerCodeRaw: customer,
      customerCodeInternal: mappings.customers.get(customer) ?? "",
      salesmanCodeRaw: salesman,
      salesmanCodeInternal: mappings.salesmen.get(salesman) ?? "",
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

export function parseGodrejSales(
  buffer: Buffer | Uint8Array,
  mappings: GodrejMappings,
  accurateLines: CanonicalSalesLine[],
): CanonicalSalesLine[] {
  const rows = readRows(buffer, "Sheet1"),
    header = headerIndex(rows, [
      "IV_NO",
      "IV_DATE",
      "CS_NO",
      "PS_NO",
      "INV_NO",
      "IV_TOTPCS",
      "IV_PRICE",
      "IV_DISC1",
      "IV_FRA",
    ]),
    accurateProducts = new Map<string, Set<string>>(),
    accurateUnits = new Map<string, Set<string>>(),
    output: CanonicalSalesLine[] = [];
  for (const line of accurateLines) {
    (
      accurateProducts.get(line.orderNumber) ??
      accurateProducts.set(line.orderNumber, new Set()).get(line.orderNumber)!
    ).add(line.productCodeInternal);
    const key = `${line.orderNumber}|${line.productCodeInternal}`,
      units = accurateUnits.get(key) ?? new Set<string>();
    units.add(line.unitSmallest);
    accurateUnits.set(key, units);
  }
  const unsupported = [
    "IV_DISC",
    "IV_PPN",
    "IV_STAMP",
    "IV_DISREG",
    "IV_DISADD",
    "IV_DISCASH",
    "IV_TOTDISC",
    "IV_DISC2",
    "IV_DISVALUE",
  ];
  for (let index = header.rowIndex + 1; index < rows.length; index++) {
    const row = rows[index],
      sourceRowNumber = index + 1;
    if (!text(row.find((cell) => text(cell)))) continue;
    for (const column of unsupported)
      if (
        header.columns.has(column) &&
        finite(value(row, header.columns, column), column, sourceRowNumber) !==
          0
      )
        throw new Error(
          `${column} belum memiliki aturan pada baris ${sourceRowNumber}`,
        );
    const rawProduct = requiredText(
        row,
        header.columns,
        "INV_NO",
        sourceRowNumber,
      ),
      order = godrejOrderNumber(
        value(row, header.columns, "IV_NO"),
        "IV_NO",
        sourceRowNumber,
      ),
      choices = mappings.products.get(rawProduct) ?? [],
      matches = choices.filter((choice) =>
        accurateProducts.get(order)?.has(choice.internal),
      ),
      mappedProduct =
        choices.length === 1
          ? choices[0]
          : matches.length === 1
            ? matches[0]
            : undefined,
      mappingStatus: MappingStatus = !choices.length
        ? "UNMAPPED_SKU"
        : !mappedProduct
          ? "INVALID_DATA"
          : accurateUnits.has(`${order}|${mappedProduct.internal}`) &&
              !accurateUnits
                .get(`${order}|${mappedProduct.internal}`)!
                .has(mappedProduct.unit)
            ? "UNIT_CONVERSION_ERROR"
            : "OK",
      quantity = finite(
        value(row, header.columns, "IV_TOTPCS"),
        "IV_TOTPCS",
        sourceRowNumber,
      ),
      price = finite(
        value(row, header.columns, "IV_PRICE"),
        "IV_PRICE",
        sourceRowNumber,
      ),
      fraction = finite(
        value(row, header.columns, "IV_FRA"),
        "IV_FRA",
        sourceRowNumber,
      ),
      discountPercent = finite(
        value(row, header.columns, "IV_DISC1"),
        "IV_DISC1",
        sourceRowNumber,
      );
    if (discountPercent < 0 || discountPercent > 100)
      throw new Error(
        `IV_DISC1 harus antara 0 dan 100 pada baris ${sourceRowNumber}`,
      );
    if (quantity < 0 || price < 0 || fraction <= 0)
      throw new Error(`Nilai GDI tidak valid pada baris ${sourceRowNumber}`);
    const grossValue = (quantity * price) / fraction,
      discountValue = (grossValue * discountPercent) / 100,
      gross = money(grossValue, "GROSS", sourceRowNumber),
      discount = money(discountValue, "DISKON", sourceRowNumber),
      dpp = gross - discount,
      tax = Math.floor(dpp / 100) * 11 + Math.round(((dpp % 100) * 11) / 100),
      customer = requiredText(row, header.columns, "CS_NO", sourceRowNumber),
      salesman = requiredText(row, header.columns, "PS_NO", sourceRowNumber);
    output.push({
      source: "PRINCIPAL",
      sourceRowNumber,
      documentNumber: requiredText(
        row,
        header.columns,
        "IV_NO",
        sourceRowNumber,
      ),
      orderNumber: order,
      transactionDate: isoDate(
        value(row, header.columns, "IV_DATE"),
        "IV_DATE",
        sourceRowNumber,
      ),
      customerCodeRaw: customer,
      customerCodeInternal: customer,
      salesmanCodeRaw: salesman,
      salesmanCodeInternal: salesman,
      productCodeRaw: rawProduct,
      productCodeInternal: mappedProduct?.internal ?? `INVALID:${rawProduct}`,
      transactionClass: "NORMAL",
      quantitySmallest: quantity,
      unitSmallest: mappedProduct?.unit ?? "",
      grossAmount: gross,
      discountAmount: discount,
      dppAmount: dpp,
      taxAmount: tax,
      netAmount: dpp + tax,
      mappingStatus,
    });
  }
  return output;
}

export function parseCussonsSales(
  buffer: Buffer | Uint8Array,
  mappings: CussonsMappings,
): CanonicalSalesLine[] {
  if (!buffer?.byteLength) throw new Error("File CSV kosong");
  const workbook = XLSX.read(buffer, {
      type: "buffer",
      raw: true,
      cellFormula: false,
    }),
    sheet = workbook.Sheets[workbook.SheetNames[0]],
    rows = sheet?.["!ref"]
      ? (XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          raw: true,
          defval: null,
          blankrows: false,
        }) as Row[])
      : [];
  if (!rows.length) throw new Error("File CSV kosong");
  const required = [
      "INVOICE NO", "CUSTOMER CODE", "ROUTE CODE", "PRODUCT CODE",
      "PRODUCT DESCRIPTION",
      "UOM CODE", "SELLING TYPE", "PRODUCT QUANTITY", "UOM LIST PRICE",
      "GROSS AMOUNT", "DISCOUNT AMOUNT", "AMOUNT AFTER SKU DISC",
      "CUSTOMER DISCOUNT", "TOTAL TAX AMOUNT", "TOTAL NET AMOUNT",
      "TAX CODE", "TAX PERCENTAGE 1",
    ],
    header = headerIndex(rows, required),
    output: CanonicalSalesLine[] = [];
  for (let index = header.rowIndex + 1; index < rows.length; index++) {
    const row = rows[index],
      sourceRowNumber = index + 1;
    if (!text(row.find((cell) => text(cell)))) continue;
    const read = (name: string) => value(row, header.columns, name),
      requiredNumber = (name: string) => {
        const raw = read(name);
        if (raw == null || text(raw) === "")
          throw new Error(name + " kosong pada baris " + sourceRowNumber);
        const parsed = finite(raw, name, sourceRowNumber);
        if (parsed < 0)
          throw new Error(name + " negatif pada baris " + sourceRowNumber);
        return parsed;
      },
      rawProduct = requiredText(
        row, header.columns, "PRODUCT CODE", sourceRowNumber,
      ),
      mapped = mappings.products.get(rawProduct),
      sourceUnit = unit(requiredText(
        row, header.columns, "UOM CODE", sourceRowNumber,
      )),
      quantity = requiredNumber("PRODUCT QUANTITY"),
      price = money(requiredNumber("UOM LIST PRICE"), "UOM List Price", sourceRowNumber),
      gross = money(requiredNumber("GROSS AMOUNT"), "Gross Amount", sourceRowNumber),
      skuDiscount = money(requiredNumber("DISCOUNT AMOUNT"), "Discount Amount", sourceRowNumber),
      afterSku = money(requiredNumber("AMOUNT AFTER SKU DISC"), "Amount After SKU Disc", sourceRowNumber),
      customerDiscount = money(requiredNumber("CUSTOMER DISCOUNT"), "Customer Discount", sourceRowNumber),
      dpp = afterSku - customerDiscount,
      tax = money(requiredNumber("TOTAL TAX AMOUNT"), "Total Tax Amount", sourceRowNumber),
      net = money(requiredNumber("TOTAL NET AMOUNT"), "Total Net Amount", sourceRowNumber),
      taxPercentage = requiredNumber("TAX PERCENTAGE 1"),
      formulaInvalid =
        Math.abs(gross - Math.round(quantity * price)) > 1 ||
        Math.abs(afterSku - (gross - skuDiscount)) > 1 ||
        Math.abs(tax - Math.round((dpp * taxPercentage) / 100)) > 1 ||
        Math.abs(net - (dpp + tax)) > 1 ||
        text(read("SELLING TYPE")) !== "S" ||
        text(read("TAX CODE")) !== "PPN_OUTPUT" ||
        Math.round(taxPercentage * MONEY_SCALE) !== 11 * MONEY_SCALE;
    let mappingStatus: MappingStatus = mapped?.mappingStatus ?? "UNMAPPED_SKU";
    if (
      mappingStatus !== "INVALID_DATA" &&
      (sourceUnit !== "EA" && sourceUnit !== "CS" ||
        sourceUnit === "CS" &&
          (mapped?.caseSize == null || mapped.caseSize <= 0))
    )
      mappingStatus = "UNIT_CONVERSION_ERROR";
    if (formulaInvalid) mappingStatus = "INVALID_DATA";
    const customer = requiredText(
        row, header.columns, "CUSTOMER CODE", sourceRowNumber,
      ),
      salesman = requiredText(
        row, header.columns, "ROUTE CODE", sourceRowNumber,
      ),
      document = requiredText(
        row, header.columns, "INVOICE NO", sourceRowNumber,
      );
    output.push({
      source: "PRINCIPAL",
      sourceRowNumber,
      documentNumber: document,
      orderNumber: cussonsOrderNumber(
        document, "Invoice No", sourceRowNumber,
      ),
      transactionDate: "",
      customerCodeRaw: customer,
      customerCodeInternal: customer,
      salesmanCodeRaw: salesman,
      salesmanCodeInternal: salesman,
      productCodeRaw: rawProduct,
      productCodeInternal:
        !mapped || mapped.mappingStatus === "INVALID_DATA"
          ? "CUSSONS_INVALID:" + rawProduct
          : mapped.productCodeInternal,
      transactionClass: "NORMAL",
      quantitySmallest:
        sourceUnit === "CS" && mapped?.caseSize
          ? quantity * mapped.caseSize
          : quantity,
      unitSmallest: mapped?.unit ?? sourceUnit,
      grossAmount: gross,
      discountAmount: skuDiscount + customerDiscount,
      dppAmount: dpp,
      taxAmount: tax,
      netAmount: net,
      mappingStatus,
    });
  }
  return output;
}

const SHINZUI_DISCOUNT_COLUMNS = [
  "DISC 1 INV",
  "DISC 2A INV",
  "DISC 2B (PROMO DIST.) INV",
  "DISC 2B (MANUAL) INV",
  "DISC 3 INV",
  "DISC 4 (PROMO DIST.) INV",
  "DISC 4 (MANUAL) INV",
  "DISC 5 INV",
];
function requireScaledEqual(
  actual: number,
  expected: number,
  label: string,
  row: number,
): void {
  if (actual !== expected)
    throw new Error(`${label} tidak konsisten pada baris ${row}`);
}

export function parseShinzuiSales(
  buffer: Buffer | Uint8Array,
  mappings: ShinzuiMappings,
  accurateLines: CanonicalSalesLine[],
): CanonicalSalesLine[] {
  const rows = readRows(buffer, "PenjualanInvoice"),
    required = [
      "INV NUM",
      "INV DATE",
      "ID PRODUK",
      "ID PELANGGAN",
      "ID SALES",
      "TIPE PENJUALAN",
      "QTY TRX-INV",
      "QTY SMALL",
      "HARGA",
      "VALUE EXCL DISC",
      ...SHINZUI_DISCOUNT_COLUMNS,
      "TOTAL DISC INV",
      "DPP INV",
      "PPN INV",
      "TOTAL INV",
    ],
    header = headerIndex(rows, required),
    accurateProducts = new Map<string, Set<string>>(),
    accurateUnits = new Map<string, Set<string>>(),
    output: CanonicalSalesLine[] = [];
  for (const line of accurateLines) {
    const products =
      accurateProducts.get(line.orderNumber) ?? new Set<string>();
    products.add(line.productCodeInternal);
    accurateProducts.set(line.orderNumber, products);
    const key = `${line.orderNumber}|${line.productCodeInternal}`,
      units = accurateUnits.get(key) ?? new Set<string>();
    units.add(line.unitSmallest);
    accurateUnits.set(key, units);
  }
  for (let index = header.rowIndex + 1; index < rows.length; index++) {
    const row = rows[index],
      sourceRowNumber = index + 1;
    if (!text(row.find((cell) => text(cell)))) continue;
    const column = (name: string) => value(row, header.columns, name),
      rawProduct = requiredText(
        row,
        header.columns,
        "ID PRODUK",
        sourceRowNumber,
      ),
      document = requiredText(row, header.columns, "INV NUM", sourceRowNumber),
      order = orderNumber(document, "INV NUM", sourceRowNumber, "invoice"),
      type = requiredText(
        row,
        header.columns,
        "TIPE PENJUALAN",
        sourceRowNumber,
      );
    if (type !== "JUAL" && type !== "PROMO" && type !== "RETUR")
      throw new Error(
        `TIPE PENJUALAN tidak valid pada baris ${sourceRowNumber}`,
      );
    const choices = mappings.products.get(rawProduct) ?? [],
      matches = choices.filter((choice) =>
        accurateProducts.get(order)?.has(choice.internal),
      ),
      mappedProduct =
        choices.length === 1
          ? choices[0]
          : matches.length === 1
            ? matches[0]
            : undefined;
    if (mappedProduct?.caseSizeError)
      throw new Error(mappedProduct.caseSizeError);
    const mappingStatus: MappingStatus = !choices.length
        ? "UNMAPPED_SKU"
        : !mappedProduct
          ? "INVALID_DATA"
          : accurateUnits.has(`${order}|${mappedProduct.internal}`) &&
              !accurateUnits
                .get(`${order}|${mappedProduct.internal}`)!
                .has(mappedProduct.unit)
            ? "UNIT_CONVERSION_ERROR"
            : "OK",
      quantityTransaction = finite(
        column("QTY TRX-INV"),
        "QTY TRX-INV",
        sourceRowNumber,
      ),
      quantitySmall = finite(column("QTY SMALL"), "QTY SMALL", sourceRowNumber),
      price = finite(column("HARGA"), "HARGA", sourceRowNumber),
      gross = money(
        column("VALUE EXCL DISC"),
        "VALUE EXCL DISC",
        sourceRowNumber,
      ),
      discount = money(
        column("TOTAL DISC INV"),
        "TOTAL DISC INV",
        sourceRowNumber,
      ),
      dpp = money(column("DPP INV"), "DPP INV", sourceRowNumber),
      tax = money(column("PPN INV"), "PPN INV", sourceRowNumber),
      net = money(column("TOTAL INV"), "TOTAL INV", sourceRowNumber),
      discountParts = SHINZUI_DISCOUNT_COLUMNS.reduce(
        (total, name) => total + money(column(name), name, sourceRowNumber),
        0,
      );
    requireScaledEqual(
      gross,
      money(quantityTransaction * price, "Value Excl Disc", sourceRowNumber),
      "Value Excl Disc",
      sourceRowNumber,
    );
    requireScaledEqual(
      discount,
      discountParts,
      "Total Disc Inv",
      sourceRowNumber,
    );
    requireScaledEqual(dpp, gross - discount, "DPP Inv", sourceRowNumber);
    requireScaledEqual(
      tax,
      Math.round((dpp * 11) / 100),
      "PPN Inv",
      sourceRowNumber,
    );
    requireScaledEqual(net, dpp + tax, "Total Inv", sourceRowNumber);
    if (
      type !== "RETUR" &&
      [quantityTransaction, quantitySmall, gross, discount, dpp, tax, net].some(
        (entry) => entry < 0,
      )
    )
      throw new Error(
        `Tanda transaksi ${type} tidak valid pada baris ${sourceRowNumber}`,
      );
    const customer = requiredText(
        row,
        header.columns,
        "ID PELANGGAN",
        sourceRowNumber,
      ),
      salesman = requiredText(row, header.columns, "ID SALES", sourceRowNumber);
    output.push({
      source: "PRINCIPAL",
      sourceRowNumber,
      documentNumber: document,
      orderNumber: order,
      transactionDate: isoDate(column("INV DATE"), "INV DATE", sourceRowNumber),
      customerCodeRaw: customer,
      customerCodeInternal: customer,
      salesmanCodeRaw: salesman,
      salesmanCodeInternal: salesman,
      productCodeRaw: rawProduct,
      productCodeInternal:
        mappedProduct?.internal ??
        `${choices.length ? "INVALID" : "UNMAPPED"}:${rawProduct}`,
      transactionClass: type === "RETUR" ? "RETURN" : "NORMAL",
      quantitySmallest: quantitySmall,
      unitSmallest: mappedProduct?.unit ?? "",
      grossAmount: gross,
      discountAmount: discount,
      dppAmount: dpp,
      taxAmount: tax,
      netAmount: net,
      mappingStatus,
    });
  }
  return output;
}

const MOTASA_DISCOUNT_COLUMNS = [
  "DISC. 1", "DISC. 2", "DISC. 3", "DISC. 4", "DISC. 5",
] as const;

export function parseMotasaSales(
  buffer: Buffer | Uint8Array,
  mappings: MotasaMappings,
): CanonicalSalesLine[] {
  const rows = readRows(buffer, "Sheet1"),
    required = [
      "TIPE", "NO.INV", "TGL.INV", "CODE CUST", "CODE SALES",
      "KODE PRODUK", "PRD_QTY", "SATUAN", "HARGA",
      ...MOTASA_DISCOUNT_COLUMNS, "FIX DISC. VALUE",
    ],
    header = headerIndex(rows, required),
    output: CanonicalSalesLine[] = [];

  for (let index = header.rowIndex + 1; index < rows.length; index++) {
    const row = rows[index], sourceRowNumber = index + 1;
    if (!text(row.find((cell) => text(cell)))) continue;
    const read = (name: string) => value(row, header.columns, name),
      type = requiredText(row, header.columns, "TIPE", sourceRowNumber);
    if (type !== "SD")
      throw new Error(`Tipe harus SD pada baris ${sourceRowNumber}`);

    const quantity = finite(
        requiredText(row, header.columns, "PRD_QTY", sourceRowNumber),
        "PRD_QTY",
        sourceRowNumber,
      ),
      price = finite(
        requiredText(row, header.columns, "HARGA", sourceRowNumber),
        "Harga",
        sourceRowNumber,
      ),
      fixed = finite(
        read("FIX DISC. VALUE"),
        "FIX DISC. VALUE",
        sourceRowNumber,
      );
    if (quantity < 0) throw new Error(`PRD_QTY negatif pada baris ${sourceRowNumber}`);
    if (price < 0) throw new Error(`Harga negatif pada baris ${sourceRowNumber}`);
    if (fixed < 0)
      throw new Error(`FIX DISC. VALUE negatif pada baris ${sourceRowNumber}`);

    const rates = MOTASA_DISCOUNT_COLUMNS.map((name) => {
      const rate = finite(read(name), name, sourceRowNumber);
      if (rate < 0 || rate > 100)
        throw new Error(`${name} harus antara 0 dan 100 pada baris ${sourceRowNumber}`);
      return rate;
    });
    const rawProduct = requiredText(
        row, header.columns, "KODE PRODUK", sourceRowNumber,
      ),
      mapped = mappings.products.get(rawProduct),
      sourceUnit = unit(requiredText(row, header.columns, "SATUAN", sourceRowNumber));

    let mappingStatus: MappingStatus = mapped?.mappingStatus ?? "UNMAPPED_SKU";
    let quantitySmallest = quantity;
    if (mapped?.mappingStatus === "OK") {
      if (sourceUnit === "KRT") {
        if (
          mapped.caseSize === null ||
          !Number.isFinite(mapped.caseSize) ||
          mapped.caseSize <= 0
        )
          mappingStatus = "UNIT_CONVERSION_ERROR";
        else quantitySmallest *= mapped.caseSize;
      }
      else if (sourceUnit !== mapped.unit)
        mappingStatus = "UNIT_CONVERSION_ERROR";
    }

    const roundedPrice = Math.round(price * 10) / 10,
      grossValue = quantity * roundedPrice;
    let dppValue = rates.reduce(
      (balance, rate) => balance * (1 - rate / 100),
      grossValue,
    );
    dppValue -= fixed;
    if (dppValue < 0)
      throw new Error(`DPP MOTASA negatif pada baris ${sourceRowNumber}`);

    const gross = money(grossValue, "Gross MOTASA", sourceRowNumber),
      dpp = money(dppValue, "DPP MOTASA", sourceRowNumber),
      discount = gross - dpp,
      tax = Math.round((dpp * 11) / 100),
      customer = requiredText(row, header.columns, "CODE CUST", sourceRowNumber),
      salesman = requiredText(row, header.columns, "CODE SALES", sourceRowNumber),
      document = requiredText(row, header.columns, "NO.INV", sourceRowNumber);

    output.push({
      source: "PRINCIPAL",
      sourceRowNumber,
      documentNumber: document,
      orderNumber: orderNumber(document, "No.INV", sourceRowNumber),
      transactionDate: isoDate(read("TGL.INV"), "TGL.INV", sourceRowNumber),
      customerCodeRaw: customer,
      customerCodeInternal: customer,
      salesmanCodeRaw: salesman,
      salesmanCodeInternal: salesman,
      productCodeRaw: rawProduct,
      productCodeInternal: rawProduct,
      transactionClass: "NORMAL",
      quantitySmallest,
      unitSmallest: mapped?.unit ?? sourceUnit,
      grossAmount: gross,
      discountAmount: discount,
      dppAmount: dpp,
      taxAmount: tax,
      netAmount: dpp + tax,
      mappingStatus,
    });
  }
  return output;
}

const MAPPING_STATUS_RANK: Record<MappingStatus, number> = {
  OK: 0,
  UNMAPPED_SKU: 1,
  UNIT_CONVERSION_ERROR: 2,
  INVALID_DATA: 3,
};

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
    const key = `${line.orderNumber}|${line.productCodeInternal}|${line.transactionClass}`,
      current = result.get(key) ?? {
        orderNumber: line.orderNumber,
        productCode: line.productCodeInternal,
        transactionClass: line.transactionClass,
        quantity: 0,
        gross: 0,
        discount: 0,
        dpp: 0,
        tax: 0,
        net: 0,
        mappingStatus: "OK" as MappingStatus,
        warnings: new Set<string>(),
        rows: [],
      };
    current.quantity += line.quantitySmallest;
    current.gross += line.grossAmount;
    current.discount += line.discountAmount;
    current.dpp += line.dppAmount;
    current.tax += line.taxAmount;
    current.net += line.netAmount;
    current.rows.push(line.sourceRowNumber);
    if (
      MAPPING_STATUS_RANK[line.mappingStatus] >
      MAPPING_STATUS_RANK[current.mappingStatus]
    )
      current.mappingStatus = line.mappingStatus;
    if (line.source === "PRINCIPAL" && !line.customerCodeInternal)
      current.warnings.add("UNMAPPED_CUSTOMER");
    if (line.source === "PRINCIPAL" && !line.salesmanCodeInternal)
      current.warnings.add("UNMAPPED_SALESMAN");
    result.set(key, current);
  }
  return result;
}
function rupiah(scaled: number): number {
  return scaled / MONEY_SCALE;
}
function reconcileLines(
  accurateLines: CanonicalSalesLine[],
  principalLines: CanonicalSalesLine[],
  options: { valueTolerance?: number },
): ReconciliationOutput {
  const tolerance = Math.round((options.valueTolerance ?? 1) * MONEY_SCALE);
  if (!Number.isSafeInteger(tolerance) || tolerance < 0)
    throw new Error("valueTolerance tidak valid");
  const accurate = aggregate(accurateLines),
    principal = aggregate(principalLines),
    results: ReconciliationResult[] = [];
  for (const key of new Set([...accurate.keys(), ...principal.keys()])) {
    const left = accurate.get(key),
      right = principal.get(key),
      quantityDifference = (left?.quantity ?? 0) - (right?.quantity ?? 0),
      amountPairs: Array<[AmountComponent, number, number]> =
        left && right
          ? [
              ["gross", left.gross, right.gross],
              ["discount", left.discount, right.discount],
              ["dpp", left.dpp, right.dpp],
              ["tax", left.tax, right.tax],
              ["net", left.net, right.net],
            ]
          : [],
      amountDifferences = amountPairs
        .filter(
          ([, accurateValue, principalValue]) =>
            Math.abs(accurateValue - principalValue) > tolerance,
        )
        .map(([component, accurateValue, principalValue]) => ({
          component,
          accurate: rupiah(accurateValue),
          kino: rupiah(principalValue),
          difference: rupiah(accurateValue - principalValue),
        })),
      valueMismatch = amountDifferences.length > 0;
    let status: ReconciliationStatus;
    if (right?.mappingStatus === "INVALID_DATA") status = "INVALID_DATA";
    else if (right?.mappingStatus === "UNMAPPED_SKU") status = "UNMAPPED_SKU";
    else if (right?.mappingStatus === "UNIT_CONVERSION_ERROR")
      status = "UNIT_CONVERSION_ERROR";
    else if (!left) status = "MISSING_INTERNAL";
    else if (!right) status = "MISSING_PRINCIPAL";
    else if (quantityDifference !== 0 && valueMismatch)
      status = "QTY_AND_VALUE_MISMATCH";
    else if (quantityDifference !== 0) status = "QTY_MISMATCH";
    else if (valueMismatch) status = "VALUE_MISMATCH";
    else status = "MATCH";
    const current = left ?? right!;
    results.push({
      orderNumber: current.orderNumber,
      internalProductCode: current.productCode,
      transactionClass: current.transactionClass,
      accurateQuantity: left?.quantity ?? 0,
      principalQuantity: right?.quantity ?? 0,
      quantityDifference,
      accurateNet: rupiah(left?.net ?? 0),
      principalNet: rupiah(right?.net ?? 0),
      valueDifference: rupiah((left?.net ?? 0) - (right?.net ?? 0)),
      amountDifferences,
      status,
      warnings: [
        ...new Set([...(left?.warnings ?? []), ...(right?.warnings ?? [])]),
      ],
      accurateSourceRows: left?.rows ?? [],
      principalSourceRows: right?.rows ?? [],
    });
  }
  const summary = Object.fromEntries(
    STATUSES.map((status) => [status, 0]),
  ) as Record<ReconciliationStatus, number>;
  for (const result of results) summary[result.status]++;
  return { accurateLines, kinoLines: principalLines, results, summary };
}
export function reconcileMotasaSales(
  accurateBuffer: Buffer | Uint8Array,
  motasaBuffer: Buffer | Uint8Array,
  mappingBuffer: Buffer | Uint8Array,
  options: { valueTolerance?: number } = {},
): ReconciliationOutput {
  const accurateLines = parseAccurateSales(accurateBuffer),
    mappings = parseMotasaMappings(mappingBuffer);
  return reconcileLines(
    accurateLines,
    parseMotasaSales(motasaBuffer, mappings),
    options,
  );
}

export function reconcileKinoSales(
  accurateBuffer: Buffer | Uint8Array,
  kinoBuffer: Buffer | Uint8Array,
  mappingBuffer: Buffer | Uint8Array,
  options: { valueTolerance?: number } = {},
): ReconciliationOutput {
  const mappings = parseKinoMappings(mappingBuffer),
    accurateLines = parseAccurateSales(accurateBuffer);
  return reconcileLines(
    accurateLines,
    parseKinoSales(kinoBuffer, mappings),
    options,
  );
}
export function reconcileGodrejSales(
  accurateBuffer: Buffer | Uint8Array,
  godrejBuffer: Buffer | Uint8Array,
  mappingBuffer: Buffer | Uint8Array,
  options: { valueTolerance?: number } = {},
): ReconciliationOutput {
  const accurateLines = parseAccurateSales(accurateBuffer);
  return reconcileLines(
    accurateLines,
    parseGodrejSales(
      godrejBuffer,
      parseGodrejMappings(mappingBuffer),
      accurateLines,
    ),
    options,
  );
}

export function reconcileCussonsSales(
  accurateBuffer: Buffer | Uint8Array,
  cussonsBuffer: Buffer | Uint8Array,
  mappingBuffer: Buffer | Uint8Array,
  options: { valueTolerance?: number } = {},
): ReconciliationOutput {
  const accurateLines = parseAccurateSales(accurateBuffer, {
    orderNumber: cussonsOrderNumber,
  });
  return reconcileLines(
    accurateLines,
    parseCussonsSales(cussonsBuffer, parseCussonsMappings(mappingBuffer)),
    { valueTolerance: options.valueTolerance ?? 1 },
  );
}

export function reconcileShinzuiSales(
  accurateBuffer: Buffer | Uint8Array,
  shinzuiBuffer: Buffer | Uint8Array,
  mappingBuffer: Buffer | Uint8Array,
  options: { valueTolerance?: number } = {},
): ReconciliationOutput {
  const accurateLines = parseAccurateSales(accurateBuffer),
    mappings = parseShinzuiMappings(mappingBuffer);
  return reconcileLines(
    accurateLines,
    parseShinzuiSales(shinzuiBuffer, mappings, accurateLines),
    options,
  );
}
