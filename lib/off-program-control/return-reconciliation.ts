import * as XLSX from "xlsx";
import {
  parseCussonsMappings,
  type CussonsMappings,
} from "./sales-reconciliation";

export type ReturnStatus =
  | "DOUBLE" | "DOUBLE_INPUT"
  | "TIDAK_IMPOR"
  | "KOREKSI"
  | "MATCH"
  | "QTY_MISMATCH"
  | "VALUE_MISMATCH"
  | "QTY_AND_VALUE_MISMATCH"
  | "MISSING_ACCURATE"
  | "MISSING_PRINCIPAL"
  | "UNMAPPED"
  | "INVALID_DATA";

export interface CanonicalReturnLine {
  source: "ACCURATE" | "PRINCIPAL";
  sourceRowNumber: number;
  invoiceNumber: string;
  customerCode: string;
  customerCodeRaw?: string;
  correctionInvoiceReferences?: string[];
  correctionBillNumber?: string;
  accurateProductCode: string | null;
  principalProductCode: string | null;
  quantity: number;
  dpp: number;
  tax: number;
  total: number;
  invalidReason?: string | null;
}

export interface ReturnReconciliationResult {
  invoiceNumber: string;
  customerCode: string;
  accurateProductCode: string | null;
  principalProductCode: string | null;
  accurateQuantity: number;
  principalQuantity: number;
  quantityDifference: number;
  accurateDpp: number;
  principalDpp: number;
  dppDifference: number;
  accurateTax: number;
  principalTax: number;
  accurateTotal: number;
  principalTotal: number;
  status: ReturnStatus;
  invalidReason: string | null;
  warnings: string[];
  accurateSourceRows: number[];
  principalSourceRows: number[];
}

export interface ReturnReconciliationOutput {
  accurateLines: CanonicalReturnLine[];
  principalLines: CanonicalReturnLine[];
  results: ReturnReconciliationResult[];
  summary: Record<Exclude<ReturnStatus, "KOREKSI" | "TIDAK_IMPOR" | "DOUBLE" | "DOUBLE_INPUT">, number> & { KOREKSI?: number; TIDAK_IMPOR?: number; DOUBLE?: number; DOUBLE_INPUT?: number };
  ignoredLines?: IgnoredReturnLine[];
}

export type IgnoredReturnLine = {
  status: "IGNORED";
  sourceRowNumber: number;
  invoiceNumber: string;
  taxNumber: string;
  principalProductCode: string;
  reason: string;
  accurateSourceRows?: number[];
};

type Row = unknown[];
type Aggregate = {
  invoiceNumber: string;
  customerCode: string;
  accurateProductCode: string | null;
  principalProductCode: string | null;
  quantity: number;
  dpp: number;
  tax: number;
  total: number;
  sourceRows: number[];
  invalidReason?: string | null;
};

const STATUSES: ReturnStatus[] = [
  "MATCH",
  "QTY_MISMATCH",
  "VALUE_MISMATCH",
  "QTY_AND_VALUE_MISMATCH",
  "MISSING_ACCURATE",
  "MISSING_PRINCIPAL",
  "UNMAPPED",
  "INVALID_DATA",
];

function text(value: unknown): string {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .toUpperCase();
}

function finite(value: unknown, label: string, row: number): number {
  if (value == null || text(value) === "") return 0;
  const parsed =
    typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(parsed))
    throw new Error(`${label} tidak valid pada baris ${row}`);
  return Math.abs(parsed);
}

function signed(value: unknown, label: string, row: number): number {
  if (value == null || text(value) === "") return 0;
  const parsed =
    typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(parsed))
    throw new Error(`${label} tidak valid pada baris ${row}`);
  return parsed;
}

function requiredFinite(value: unknown, label: string, row: number): number {
  if (value == null || text(value) === "")
    throw new Error(`${label} kosong pada baris ${row}`);
  return finite(value, label, row);
}

function requiredSigned(value: unknown, label: string, row: number): number {
  if (value == null || text(value) === "")
    throw new Error(`${label} kosong pada baris ${row}`);
  return signed(value, label, row);
}

function readRows(buffer: Buffer | Uint8Array, sheetName: string, preserveBlankRows = false): Row[] {
  if (!buffer?.byteLength) throw new Error("File XLSX kosong");
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, {
      type: "buffer",
      raw: true,
      cellFormula: false,
    });
  } catch {
    throw new Error("File XLSX rusak atau tidak valid.");
  }
  const sheet = workbook.Sheets[sheetName];
  if (!sheet?.["!ref"])
    throw new Error(`Sheet ${sheetName} tidak ditemukan atau kosong`);
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: preserveBlankRows,
  }) as Row[];
}

function findHeader(
  rows: Row[],
  required: string[],
): { rowIndex: number; columns: Map<string, number> } {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const columns = new Map<string, number>();
    rows[rowIndex].forEach((entry, index) => {
      if (text(entry)) columns.set(text(entry), index);
    });
    if (required.every((name) => columns.has(name))) return { rowIndex, columns };
  }
  throw new Error(`Header wajib tidak ditemukan: ${required.join(", ")}`);
}

function cell(row: Row, columns: Map<string, number>, name: string): unknown {
  const index = columns.get(name);
  return index === undefined ? null : row[index];
}

function requiredText(
  row: Row,
  columns: Map<string, number>,
  name: string,
  rowNumber: number,
): string {
  const value = text(cell(row, columns, name));
  if (!value) throw new Error(`${name} kosong pada baris ${rowNumber}`);
  return value;
}

function invoiceFromRem(value: unknown, row: number): string {
  const matches = text(value).match(/INVGTS\d+-\d+-\d+/g) ?? [];
  if (matches.length !== 1)
    throw new Error(`REM harus memuat tepat satu nomor invoice pada baris ${row}`);
  return matches[0];
}

export function parseMappings(buffer: Buffer | Uint8Array): Map<string, string[]> {
  const rows = readRows(buffer, "Fix Mapping"),
    required = [
      "KODE BARANG",
      "PCPL KODE 1",
      "PCPL KODE 2",
      "PCPL KODE 3",
      "PCPL KODE 4",
      "PCPL KODE 5",
    ],
    header = findHeader(rows, required),
    mappings = new Map<string, string[]>();
  for (let index = header.rowIndex + 1; index < rows.length; index++) {
    const row = rows[index],
      internal = text(cell(row, header.columns, "KODE BARANG")),
      principals = required
        .slice(1)
        .map((name) => text(cell(row, header.columns, name)))
        .filter((value) => value && value !== "0");
    if (!internal && !principals.length) continue;
    if (!internal) throw new Error(`KODE BARANG kosong pada baris ${index + 1}`);
    for (const principal of new Set(principals)) {
      const existing = mappings.get(internal) ?? [];
      if (!existing.includes(principal)) existing.push(principal);
      mappings.set(internal, existing);
    }
  }
  return mappings;
}

export function parseKinoReturnMappings(
  buffer: Buffer | Uint8Array,
): Map<string, string> {
  const rows = readRows(buffer, "Table Pvt 1"),
    header = findHeader(rows, ["KODE PCPL", "KODE BARANG WIN"]),
    mappings = new Map<string, string>();
  for (let index = header.rowIndex + 1; index < rows.length; index++) {
    const principal = text(cell(rows[index], header.columns, "KODE PCPL")),
      internal = text(cell(rows[index], header.columns, "KODE BARANG WIN"));
    if (!principal && !internal) continue;
    if (!principal || principal === "0") continue;
    if (!internal)
      throw new Error(`Table Pvt 1 tidak lengkap pada baris ${index + 1}`);
    const existing = mappings.get(principal);
    if (existing && existing !== internal)
      throw new Error(`Mapping produk KINO konflik untuk ${principal}`);
    mappings.set(principal, internal);
  }
  try {
    for (const [internal, principals] of parseMappings(buffer))
      for (const principal of principals) {
        const existing = mappings.get(principal);
        if (existing && existing !== internal)
          throw new Error(`Mapping produk KINO konflik untuk ${principal}`);
        mappings.set(principal, internal);
      }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "Sheet Fix Mapping tidak ditemukan atau kosong"
    )
      throw error;
  }
  return mappings;
}

export function parseGodrejMappings(buffer: Buffer | Uint8Array): {
  codes: Map<string, string[]>;
  names: Map<string, string[]>;
} {
  const codeRows = readRows(buffer, "Pvt Map 1"),
    codeHeader = findHeader(codeRows, ["KODE BARANG WIN2", "KODE PCPL"]),
    codes = new Map<string, string[]>();
  for (let index = codeHeader.rowIndex + 1; index < codeRows.length; index++) {
    const principal = text(
        cell(codeRows[index], codeHeader.columns, "KODE PCPL"),
      ),
      internal = text(
        cell(codeRows[index], codeHeader.columns, "KODE BARANG WIN2"),
      );
    if (!principal || principal === "0" || principal === "(BLANK)" || !internal)
      continue;
    const candidates = codes.get(principal) ?? [];
    if (!candidates.includes(internal)) candidates.push(internal);
    codes.set(principal, candidates);
  }

  const nameRows = readRows(buffer, "Form Fix"),
    nameHeader = findHeader(nameRows, [
      "NAMA BARANG PRINCIPLE",
      "KODE BARANG WIN2",
    ]),
    names = new Map<string, string[]>();
  for (let index = nameHeader.rowIndex + 1; index < nameRows.length; index++) {
    const name = cleanGodrejProductName(
        cell(nameRows[index], nameHeader.columns, "NAMA BARANG PRINCIPLE"),
      ),
      internal = text(
        cell(nameRows[index], nameHeader.columns, "KODE BARANG WIN2"),
      );
    if (!name || name === "0" || !internal) continue;
    const candidates = names.get(name) ?? [];
    if (!candidates.includes(internal)) candidates.push(internal);
    names.set(name, candidates);
  }
  return { codes, names };
}

export function parseHeinzMappings(
  buffer: Buffer | Uint8Array,
): Map<string, string> {
  const rows = readRows(buffer, "Fix Mapping"),
    required = [
      "KODE BARANG",
      "PCPL KODE 1",
      "PCPL KODE 2",
      "PCPL KODE 3",
      "PCPL KODE 4",
      "PCPL KODE 5",
    ],
    header = findHeader(rows, required),
    mappings = new Map<string, string>();
  for (let index = header.rowIndex + 1; index < rows.length; index++) {
    const internal = text(cell(rows[index], header.columns, "KODE BARANG")),
      principals = required
        .slice(1)
        .map((name) => text(cell(rows[index], header.columns, name)))
        .filter((value) => value && value !== "0");
    if (!internal && !principals.length) continue;
    if (!internal) throw new Error(`KODE BARANG kosong pada baris ${index + 1}`);
    for (const principal of new Set(principals)) {
      const existing = mappings.get(principal);
      if (existing && existing !== internal)
        throw new Error(`Mapping produk HEINZ konflik untuk ${principal}`);
      mappings.set(principal, internal);
    }
  }
  return mappings;
}

function cleanGodrejProductName(value: unknown, leadingCode = ""): string {
  let name = text(value).replace(/\s+/g, " ");
  if (leadingCode)
    name = name.replace(
      new RegExp(`^${leadingCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[-:]?\\s*`),
      "",
    );
  name = name
    .replace(/[.,;:|\-]+\s*$/, "")
    .replace(/\s*\(\d+\/\d+\)\s*$/, "")
    .replace(/[.,;:|\-]+\s*$/, "")
    .trim();
  if (leadingCode)
    name = name.replace(
      new RegExp(`\\s+${leadingCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      "",
    );
  return name.replace(/[.,;:|\-]+\s*$/, "").trim();
}

function exactlyOneToken(
  value: unknown,
  pattern: RegExp,
  label: string,
  row: number,
): string {
  const matches = text(value).match(pattern) ?? [];
  if (matches.length !== 1)
    throw new Error(`${label} harus memuat tepat satu token pada baris ${row}`);
  return matches[0];
}

function godrejPrincipalCustomer(value: unknown, row: number): string {
  const customer = text(value).replace(/\s+/g, " ");
  // Confirmed exact names only: never infer a customer from partial or similar names.
  const knownCustomers: Record<string, string> = {
    "PT. LOTTE MART PANAKUKANG": "C-LO0013",
    "CV.MAJU BERSAMA": "C-DU0003",
    "JACK GROCERS": "C-JAC767",
    "CV. MITRA BELANJA SEJAHTERA": "C-KIN009",
    "MINASA MART": "C-MIN013",
    "MINI MART": "C-MIN010",
  };
  if (Object.hasOwn(knownCustomers, customer)) return knownCustomers[customer];
  return exactlyOneToken(customer, /(?<![A-Z0-9])CA?-[A-Z0-9]+(?![A-Z0-9-])/g, "CUSTOMER", row);
}

function godrejAccurateCustomer(value: unknown, row: number): string {
  const customer = text(value),
    suffixed = customer.match(/^(CA?-[A-Z0-9]+)-GD$/);
  if (suffixed) return suffixed[1];
  if (/^CA?-[A-Z0-9]+$/.test(customer)) return customer;
  throw new Error(
    `KODE PELANGGAN INDUK harus memuat tepat satu token pada baris ${row}`,
  );
}

function godrejNumber(value: unknown, label: string, row: number): number {
  if (value == null || text(value) === "")
    throw new Error(`${label} kosong pada baris ${row}`);
  const parsed =
    typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(parsed))
    throw new Error(`${label} tidak valid pada baris ${row}`);
  return Math.abs(parsed);
}

function parseAccurate(
  buffer: Buffer | Uint8Array,
  mappings: Map<string, string[]>,
  principalLines: CanonicalReturnLine[],
): CanonicalReturnLine[] {
  const rows = readRows(buffer, "Rincian Faktur Penjualan"),
    required = [
      "KODE PELANGGAN INDUK",
      "KODE_BARANG",
      "QTY_SATUANKECIL",
      "DPP",
      "NILAI_PAJAK",
      "JUMLAH",
      "REM",
      "JENIS_TRANSAKSI",
    ],
    header = findHeader(rows, required),
    lines: CanonicalReturnLine[] = [],
    principalKeys = new Set(
      principalLines.map(
        (line) => `${line.invoiceNumber}|${line.principalProductCode}|${line.customerCode}`,
      ),
    );
  for (let index = header.rowIndex + 1; index < rows.length; index++) {
    const row = rows[index], sourceRowNumber = index + 1;
    if (!row.some((entry) => text(entry))) continue;
    const kind = requiredText(
      row,
      header.columns,
      "JENIS_TRANSAKSI",
      sourceRowNumber,
    );
    if (!kind.includes("RETUR PENJUALAN")) continue;
    const accurateProductCode = requiredText(
        row,
        header.columns,
        "KODE_BARANG",
        sourceRowNumber,
      ),
      invoiceNumber = invoiceFromRem(
        cell(row, header.columns, "REM"),
        sourceRowNumber,
      ),
      customerCode = requiredText(
        row,
        header.columns,
        "KODE PELANGGAN INDUK",
        sourceRowNumber,
      ),
      candidates = mappings.get(accurateProductCode) ?? [],
      matches = candidates.filter((principal) =>
        principalKeys.has(`${invoiceNumber}|${principal}|${customerCode}`),
      );
    if (candidates.length > 1 && matches.length !== 1)
      throw new Error(`Mapping KODE BARANG ambigu pada baris ${sourceRowNumber}`);
    lines.push({
      source: "ACCURATE",
      sourceRowNumber,
      invoiceNumber,
      customerCode,
      accurateProductCode,
      principalProductCode: matches[0] ?? candidates[0] ?? null,
      quantity: finite(cell(row, header.columns, "QTY_SATUANKECIL"), "QTY_SATUANKECIL", sourceRowNumber),
      dpp: finite(cell(row, header.columns, "DPP"), "DPP", sourceRowNumber),
      tax: finite(cell(row, header.columns, "NILAI_PAJAK"), "NILAI_PAJAK", sourceRowNumber),
      total: finite(cell(row, header.columns, "JUMLAH"), "JUMLAH", sourceRowNumber),
    });
  }
  return lines;
}

function parsePrincipal(buffer: Buffer | Uint8Array): CanonicalReturnLine[] {
  const rows = readRows(buffer, "PenjualanInvoice"),
    required = [
      "INV NUM",
      "ID PRODUK",
      "ID PELANGGAN LAMA",
      "TIPE PENJUALAN",
      "QTY SMALL",
      "DPP INV",
      "PPN INV",
      "TOTAL INV",
    ],
    header = findHeader(rows, required),
    lines: CanonicalReturnLine[] = [];
  for (let index = header.rowIndex + 1; index < rows.length; index++) {
    const row = rows[index], sourceRowNumber = index + 1;
    if (!row.some((entry) => text(entry))) continue;
    const kind = requiredText(
      row,
      header.columns,
      "TIPE PENJUALAN",
      sourceRowNumber,
    );
    if (kind !== "RETUR") continue;
    lines.push({
      source: "PRINCIPAL",
      sourceRowNumber,
      invoiceNumber: requiredText(row, header.columns, "INV NUM", sourceRowNumber),
      customerCode: requiredText(row, header.columns, "ID PELANGGAN LAMA", sourceRowNumber),
      accurateProductCode: null,
      principalProductCode: requiredText(row, header.columns, "ID PRODUK", sourceRowNumber),
      quantity: finite(cell(row, header.columns, "QTY SMALL"), "QTY SMALL", sourceRowNumber),
      dpp: finite(cell(row, header.columns, "DPP INV"), "DPP INV", sourceRowNumber),
      tax: finite(cell(row, header.columns, "PPN INV"), "PPN INV", sourceRowNumber),
      total: finite(cell(row, header.columns, "TOTAL INV"), "TOTAL INV", sourceRowNumber),
    });
  }
  return lines;
}

function parseKinoPrincipal(
  buffer: Buffer | Uint8Array,
  mappings: Map<string, string>,
  ignoredLines: IgnoredReturnLine[],
  correctionLines: CanonicalReturnLine[],
): CanonicalReturnLine[] {
  const rows = readRows(buffer, "Sheet1", true),
    required = [
      "INVOICE_NO",
      "CUSTCODE2",
      "PRODUCT_CODE",
      "INVOICE_QTY",
      "INVOICE_GROSS",
      "INVOICE_TOTALLINEDISC",
      "INVOICE_PROMO",
      "INVOICE_CASHDISC",
      "INVOICE_TAX",
      "INVOICE_NET",
      "INVOICE_TYPE",
    ],
    header = findHeader(rows, required),
    lines: CanonicalReturnLine[] = [];
  for (let index = header.rowIndex + 1; index < rows.length; index++) {
    const row = rows[index], sourceRowNumber = index + 1;
    if (!row.some((entry) => text(entry))) continue;
    const invoice = text(cell(row, header.columns, "INVOICE_NO"));
    if (invoice.startsWith("TOTAL FOR") || invoice === "GRAND TOTAL") continue;
    if (text(cell(row, header.columns, "INVOICE_TYPE")) !== "RET01") continue;
    const taxNumber = text(cell(row, header.columns, "PAJAK_NO"));
    if (taxNumber.startsWith("INV")) {
      ignoredLines.push({
        status: "IGNORED",
        sourceRowNumber,
        invoiceNumber: invoice,
        taxNumber,
        principalProductCode: text(cell(row, header.columns, "PRODUCT_CODE")),
        reason: "Koreksi/retur KINO dengan PAJAK_NO berawalan INV; tidak termasuk pencocokan dan total rekonsiliasi.",
      });
    }
    const principalProductCode = requiredText(
        row,
        header.columns,
        "PRODUCT_CODE",
        sourceRowNumber,
      ),
      gross = requiredSigned(
        cell(row, header.columns, "INVOICE_GROSS"),
        "INVOICE_GROSS",
        sourceRowNumber,
      ),
      lineDiscount = signed(
        cell(row, header.columns, "INVOICE_TOTALLINEDISC"),
        "INVOICE_TOTALLINEDISC",
        sourceRowNumber,
      ),
      promoDiscount = signed(
        cell(row, header.columns, "INVOICE_PROMO"),
        "INVOICE_PROMO",
        sourceRowNumber,
      ),
      cashDiscount = signed(
        cell(row, header.columns, "INVOICE_CASHDISC"),
        "INVOICE_CASHDISC",
        sourceRowNumber,
      );
    (taxNumber.startsWith("INV") ? correctionLines : lines).push({
      source: "PRINCIPAL",
      sourceRowNumber,
      invoiceNumber: requiredText(
        row,
        header.columns,
        "INVOICE_NO",
        sourceRowNumber,
      ),
      customerCode: requiredText(row, header.columns, "CUSTCODE2", sourceRowNumber),
      customerCodeRaw: text(cell(row, header.columns, "CUSTCODE2")),
      accurateProductCode: mappings.get(principalProductCode) ?? null,
      principalProductCode,
      quantity: requiredFinite(
        cell(row, header.columns, "INVOICE_QTY"),
        "INVOICE_QTY",
        sourceRowNumber,
      ),
      dpp: Math.abs(
        gross - lineDiscount - promoDiscount - cashDiscount,
      ),
      tax: requiredFinite(
        cell(row, header.columns, "INVOICE_TAX"),
        "INVOICE_TAX",
        sourceRowNumber,
      ),
      total: requiredFinite(
        cell(row, header.columns, "INVOICE_NET"),
        "INVOICE_NET",
        sourceRowNumber,
      ),
    });
  }
  return lines;
}

function parseKinoAccurate(
  buffer: Buffer | Uint8Array,
): { lines: CanonicalReturnLine[]; invalidLines: CanonicalReturnLine[] } {
  const rows = readRows(buffer, "Rincian Faktur Penjualan"),
    required = [
      "NO_NOTA",
      "KODE PELANGGAN INDUK",
      "KODE_BARANG",
      "QTY_SATUANKECIL",
      "DPP",
      "NILAI_PAJAK",
      "JUMLAH",
      "REM",
      "JENIS_TRANSAKSI",
    ],
    header = findHeader(rows, required),
    lines: CanonicalReturnLine[] = [],
    invalidLines: CanonicalReturnLine[] = [];
  for (let index = header.rowIndex + 1; index < rows.length; index++) {
    const row = rows[index], sourceRowNumber = index + 1;
    if (!row.some((entry) => text(entry))) continue;
    if (
      !text(cell(row, header.columns, "JENIS_TRANSAKSI")).includes(
        "RETUR PENJUALAN",
      )
    )
      continue;
    const accurateProductCode = requiredText(
        row,
        header.columns,
        "KODE_BARANG",
        sourceRowNumber,
      ),
      customerCode = requiredText(
        row,
        header.columns,
        "KODE PELANGGAN INDUK",
        sourceRowNumber,
      ),
      matches = text(cell(row, header.columns, "REM")).match(
        /1671-SRI-\d+/g,
      ) ?? [],
      invoiceNumber =
        matches.length === 1
          ? matches[0]
          : requiredText(row, header.columns, "NO_NOTA", sourceRowNumber),
      line: CanonicalReturnLine = {
        source: "ACCURATE",
        sourceRowNumber,
        invoiceNumber,
        customerCode,
        correctionInvoiceReferences: text(cell(row, header.columns, "REM")).match(/INV\/\d+\/[A-Z0-9]+/g) ?? [],
        accurateProductCode,
        principalProductCode: null,
        quantity: requiredFinite(
          cell(row, header.columns, "QTY_SATUANKECIL"),
          "QTY_SATUANKECIL",
          sourceRowNumber,
        ),
        dpp: requiredFinite(
          cell(row, header.columns, "DPP"),
          "DPP",
          sourceRowNumber,
        ),
        tax: requiredFinite(
          cell(row, header.columns, "NILAI_PAJAK"),
          "NILAI_PAJAK",
          sourceRowNumber,
        ),
        total: requiredFinite(
          cell(row, header.columns, "JUMLAH"),
          "JUMLAH",
          sourceRowNumber,
        ),
        invalidReason:
          matches.length === 0
            ? "REM tidak memuat nomor invoice KINO 1671-SRI."
            : matches.length > 1
              ? "REM memuat lebih dari satu nomor invoice KINO 1671-SRI."
              : null,
      };
    (matches.length === 1 ? lines : invalidLines).push(line);
  }
  return { lines, invalidLines };
}

function parseGodrejAccurate(
  buffer: Buffer | Uint8Array,
): { lines: CanonicalReturnLine[]; invalidLines: CanonicalReturnLine[] } {
  const rows = readRows(buffer, "Rincian Faktur Penjualan"),
    required = [
      "NO_NOTA",
      "KODE PELANGGAN INDUK",
      "KODE_BARANG",
      "QTY_SATUANKECIL",
      "DPP",
      "NILAI_PAJAK",
      "JUMLAH",
      "REM",
      "JENIS_TRANSAKSI",
    ],
    header = findHeader(rows, required),
    lines: CanonicalReturnLine[] = [],
    invalidLines: CanonicalReturnLine[] = [];
  for (let index = header.rowIndex + 1; index < rows.length; index++) {
    const row = rows[index], sourceRowNumber = index + 1;
    if (!row.some((entry) => text(entry))) continue;
    if (
      !text(cell(row, header.columns, "JENIS_TRANSAKSI")).includes(
        "RETUR PENJUALAN",
      )
    )
      continue;
    const matches = text(cell(row, header.columns, "REM")).match(
        /(?<![A-Z0-9])RB\/BFG-\d+(?![A-Z0-9])/g,
      ) ?? [],
      line: CanonicalReturnLine = {
        source: "ACCURATE",
        sourceRowNumber,
        invoiceNumber:
          matches.length === 1
            ? matches[0]
            : requiredText(row, header.columns, "NO_NOTA", sourceRowNumber),
        customerCode: godrejAccurateCustomer(
          cell(row, header.columns, "KODE PELANGGAN INDUK"),
          sourceRowNumber,
        ),
        accurateProductCode: requiredText(
          row,
          header.columns,
          "KODE_BARANG",
          sourceRowNumber,
        ),
        principalProductCode: null,
        quantity: requiredFinite(
          cell(row, header.columns, "QTY_SATUANKECIL"),
          "QTY_SATUANKECIL",
          sourceRowNumber,
        ),
        dpp: requiredFinite(
          cell(row, header.columns, "DPP"),
          "DPP",
          sourceRowNumber,
        ),
        tax: requiredFinite(
          cell(row, header.columns, "NILAI_PAJAK"),
          "NILAI_PAJAK",
          sourceRowNumber,
        ),
        total: requiredFinite(
          cell(row, header.columns, "JUMLAH"),
          "JUMLAH",
          sourceRowNumber,
        ),
        invalidReason:
          matches.length === 0
            ? "REM tidak memuat nomor return GODREJ RB/BFG."
            : matches.length > 1
              ? "REM memuat lebih dari satu nomor return GODREJ RB/BFG."
              : null,
      };
    (matches.length === 1 ? lines : invalidLines).push(line);
  }
  return { lines, invalidLines };
}

function parseGodrejPrincipal(
  buffer: Buffer | Uint8Array,
  mappings: ReturnType<typeof parseGodrejMappings>,
): { lines: CanonicalReturnLine[]; unmappedLines: CanonicalReturnLine[] } {
  const rows = readRows(buffer, "Sheet1"),
    required = [
      "SALE RETURN NO.",
      "CUSTOMER",
      "SKUNIT",
      "QUANTITY(UNITS)",
      "AMOUNT",
      "SALE RETURN STATE",
    ],
    header = findHeader(rows, required),
    lines: CanonicalReturnLine[] = [],
    unmappedLines: CanonicalReturnLine[] = [];
  for (let index = header.rowIndex + 1; index < rows.length; index++) {
    const row = rows[index], sourceRowNumber = index + 1;
    if (!row.some((entry) => text(entry))) continue;
    if (text(cell(row, header.columns, "SALE RETURN STATE")) !== "APPROVED")
      continue;
    const sku = requiredText(row, header.columns, "SKUNIT", sourceRowNumber),
      principalProductCode =
        sku.match(/^([A-Z0-9-]+)\s+-\s+/)?.[1] ??
        sku.match(/^[A-Z0-9]+/)?.[0] ??
        sku,
      name = cleanGodrejProductName(sku, principalProductCode),
      codeCandidates = mappings.codes.get(principalProductCode) ?? [],
      nameCandidates = mappings.names.get(name) ?? [],
      accurateProductCode =
        codeCandidates.length === 1
          ? codeCandidates[0]
          : nameCandidates.length === 1
            ? nameCandidates[0]
            : null;
    if (codeCandidates.length > 1)
      throw new Error(
        `Mapping produk GODREJ konflik: ${codeCandidates.join(", ")}`,
      );
    if (nameCandidates.length > 1 && codeCandidates.length === 0)
      throw new Error(
        `Mapping produk GODREJ konflik: ${nameCandidates.join(", ")}`,
      );
    const total = godrejNumber(
        cell(row, header.columns, "AMOUNT"),
        "Amount",
        sourceRowNumber,
      ),
      dpp = total / 1.11,
      line: CanonicalReturnLine = {
        source: "PRINCIPAL",
        sourceRowNumber,
        ...(text(cell(row, header.columns, "BILL NO")).startsWith("FK/BFG-")
          ? { correctionBillNumber: text(cell(row, header.columns, "BILL NO")) }
          : {}),
        invoiceNumber: exactlyOneToken(
          cell(row, header.columns, "SALE RETURN NO."),
          /(?<![A-Z0-9])RB\/BFG-\d+(?![A-Z0-9])/g,
          "SALE RETURN NO.",
          sourceRowNumber,
        ),
        customerCode: godrejPrincipalCustomer(
          cell(row, header.columns, "CUSTOMER"),
          sourceRowNumber,
        ),
        accurateProductCode,
        principalProductCode,
        quantity: godrejNumber(
          cell(row, header.columns, "QUANTITY(UNITS)"),
          "Quantity(Units)",
          sourceRowNumber,
        ),
        dpp,
        tax: total - dpp,
        total,
      };
    (accurateProductCode ? lines : unmappedLines).push(line);
  }
  return { lines, unmappedLines };
}

function parseHeinzAccurate(
  buffer: Buffer | Uint8Array,
  headerBuffer: Buffer | Uint8Array,
): { lines: CanonicalReturnLine[]; invalidLines: CanonicalReturnLine[] } {
  const referenceRows = readRows(headerBuffer, "Sheet1");
  const referenceHeader = findHeader(referenceRows, ["CREDIT_NOTE_NUMBER", "REMARKS", "STATUS"]);
  const references = new Map<string, Set<string>>();
  for (const row of referenceRows.slice(referenceHeader.rowIndex + 1)) {
    if (text(cell(row, referenceHeader.columns, "STATUS")) !== "APPROVED") continue;
    const cn = text(cell(row, referenceHeader.columns, "CREDIT_NOTE_NUMBER"));
    if (!/^CN-\d+$/.test(cn)) continue;
    let notes = text(cell(row, referenceHeader.columns, "REMARKS"));
    if (cn === "CN-026345" && notes === "RJS/2610/00025 (MTR)") notes = "RSJ/2610/00025";
    for (const no of notes.match(/(?<![A-Z0-9/])(?:RSJ|RJN)\/\d+\/[A-Z0-9]+(?![A-Z0-9/])/g) ?? []) {
      const candidates = references.get(no) ?? new Set<string>();
      candidates.add(cn);
      references.set(no, candidates);
    }
  }
  const rows = readRows(buffer, "Rincian Faktur Penjualan"),
    required = [
      "NO_NOTA",
      "KODE PELANGGAN INDUK",
      "KODE_BARANG",
      "QTY_SATUANKECIL",
      "DPP",
      "NILAI_PAJAK",
      "JUMLAH",
      "REM",
      "JENIS_TRANSAKSI",
    ],
    header = findHeader(rows, required),
    lines: CanonicalReturnLine[] = [],
    invalidLines: CanonicalReturnLine[] = [];
  for (let index = header.rowIndex + 1; index < rows.length; index++) {
    const row = rows[index], sourceRowNumber = index + 1;
    if (!row.some((entry) => text(entry))) continue;
    if (
      !text(cell(row, header.columns, "JENIS_TRANSAKSI")).includes(
        "RETUR PENJUALAN",
      )
    )
      continue;
    const matches: string[] =
        text(cell(row, header.columns, "REM")).match(
          /(?<![A-Z0-9])CN-\d+(?![A-Z0-9-])/g,
        ) ?? [];
    // Only the approved motoris exception may resolve a missing CN through a document reference.
    const motoris = /^RSJ\/\d+\/[A-Z0-9]+$/.test(text(cell(row, header.columns, "NO_NOTA"))) &&
      /^DO\.\d{4}\.\d{2}\.\d+$/.test(text(cell(row, header.columns, "REM"))) &&
      ["DPP", "NILAI_PAJAK", "JUMLAH"].every(field =>
        requiredFinite(cell(row, header.columns, field), field, sourceRowNumber) === 0);
    if (matches.length === 0 && motoris) {
      const candidates = references.get(text(cell(row, header.columns, "NO_NOTA")));
      if (candidates?.size === 1) matches.push(...candidates);
      // Two returns from the same delivery complete the 16 bottles on this CN.
      if (!candidates && text(cell(row, header.columns, "NO_NOTA")) === "RSJ/2610/00007") {
        const sameDeliveryItem = (entry: typeof row) =>
          text(cell(entry, header.columns, "REM")) === "DO.2026.10.00004" &&
          text(cell(entry, header.columns, "KODE PELANGGAN INDUK")) === "C-MUH026" &&
          text(cell(entry, header.columns, "KODE_BARANG")) === "A1092007042510";
        const linked = references.get("RSJ/2610/00006");
        if (sameDeliveryItem(row) && linked?.size === 1 && linked.has("CN-026159") &&
            rows.some(entry => text(cell(entry, header.columns, "NO_NOTA")) === "RSJ/2610/00006" &&
              text(cell(entry, header.columns, "JENIS_TRANSAKSI")).includes("RETUR PENJUALAN") && sameDeliveryItem(entry)))
          matches.push("CN-026159");
      }
    }
    const line: CanonicalReturnLine = {
        source: "ACCURATE",
        sourceRowNumber,
        invoiceNumber:
          matches.length > 0
            ? [...new Set(matches)].sort().join(", ")
            : requiredText(row, header.columns, "NO_NOTA", sourceRowNumber),
        customerCode: requiredText(
          row,
          header.columns,
          "KODE PELANGGAN INDUK",
          sourceRowNumber,
        ),
        accurateProductCode: requiredText(
          row,
          header.columns,
          "KODE_BARANG",
          sourceRowNumber,
        ),
        principalProductCode: null,
        quantity: requiredFinite(
          cell(row, header.columns, "QTY_SATUANKECIL"),
          "QTY_SATUANKECIL",
          sourceRowNumber,
        ),
        dpp: requiredFinite(
          cell(row, header.columns, "DPP"),
          "DPP",
          sourceRowNumber,
        ),
        tax: requiredFinite(
          cell(row, header.columns, "NILAI_PAJAK"),
          "NILAI_PAJAK",
          sourceRowNumber,
        ),
        total: requiredFinite(
          cell(row, header.columns, "JUMLAH"),
          "JUMLAH",
          sourceRowNumber,
        ),
        invalidReason:
          matches.length === 0
            ? "REM tidak memuat nomor return HEINZ CN."
            : null,
      };
    (matches.length > 0 ? lines : invalidLines).push(line);
  }
  return { lines, invalidLines };
}

function heinzVerifiedCustomer(cn: string, retailer: string, name: string, remarks: string): string | undefined {
  // These codes identify verified transactions, not aliases across customers.
  switch (cn) {
    case "CN-025929":
      if (retailer === "MK4479" && name === "TOKO BERKAH DUA PUTRA_") return "C-BER124";
      break;
    case "CN-025894":
      if (retailer === "MK1404" && name === "AULIA MAMADAI_") return "C-TOK826";
      break;
    case "CN-026016":
      if (retailer === "MK4105" && name === "TOKO JUNAEDAH_") return "C-JUN178";
      break;
    case "CN-026039":
      if (retailer === "MK1523" && name === "HJ. SYAMSIAH_C-SY0072 C-MAM075") return "C-SY0072";
      break;
    case "CN-026022":
      if (retailer === "MKS-001231" && name === "TK H DOLO_") return "C-TOK275";
      break;
    case "CN-026118":
      if (retailer === "MKS-000523" && name === "RAHMAT CHACHA_") return "C-RAH155";
      break;
    case "CN-026256":
      if (retailer === "MK0860" && name === "UD. MAUL WARDI_") return "C-TOK148";
      break;
    case "CN-026216":
      if (retailer === "MKS-001359" && name === "TK. LINA(CREDIT)_" && remarks.startsWith("INV/2610/HZ00494_") && remarks.includes("_BATAL_")) return "C-KAS016";
      break;
    case "CN-026366":
      if (retailer === "MKS-000957" && name === "TK. STAND 11_C-110002_C-ABD257") return "C-ABD257";
      break;
    case "CN-026204":
      if (retailer === "MKS-003696" && name === "TK.DEPOT BAKSO DASS_C-DB01_C-DB0003") return "C-DB0003";
      break;
    case "CN-026071":
      if (retailer === "MK1933" && name === "TK. AAN_C-TK 124") return "C-TK 124";
  }
}

function parseHeinzPrincipal(
  headerBuffer: Buffer | Uint8Array,
  detailBuffer: Buffer | Uint8Array,
  mappings: Map<string, string>,
): {
  lines: CanonicalReturnLine[];
  unmappedLines: CanonicalReturnLine[];
  invalidLines: CanonicalReturnLine[];
} {
  const headerRows = readRows(headerBuffer, "Sheet1"),
    headerRequired = [
      "CREDIT_NOTE_NUMBER",
      "GOODS_RETURN_NOTE_NUMBER",
      "SALES_REPRESENTATIVE_CODE",
      "RETAILER_CODE",
      "RETAILER_NAME",
      "CREDIT_NOTE_DATE",
      "INVOICE_NUMBER",
      "REMARKS",
      "LINE_COUNT",
      "NET_VALUE",
      "STATUS",
    ],
    header = findHeader(headerRows, headerRequired),
    approved = new Map<
      string,
      { customerCode: string; lineCount: number; sourceRowNumber: number; invalidReason: string | null }
    >(),
    seen = new Set<string>();
  for (let index = header.rowIndex + 1; index < headerRows.length; index++) {
    const row = headerRows[index], sourceRowNumber = index + 1;
    if (!row.some((entry) => text(entry))) continue;
    const creditNote = requiredText(
      row,
      header.columns,
      "CREDIT_NOTE_NUMBER",
      sourceRowNumber,
    );
    if (seen.has(creditNote))
      throw new Error(`credit_note_number duplikat ${creditNote}`);
    seen.add(creditNote);
    if (text(cell(row, header.columns, "STATUS")) !== "APPROVED") continue;
    const retailerCode = text(cell(row, header.columns, "RETAILER_CODE")),
      nameCodes = text(cell(row, header.columns, "RETAILER_NAME")).match(
        /(?<![A-Z0-9-])C-[A-Z0-9]+(?![A-Z0-9-]|\s+\d)/g,
      ) ?? [],
      parsedCandidates = [...new Set([
        ...nameCodes,
        ...(/^C-[A-Z0-9]+$/.test(retailerCode) ? [retailerCode] : []),
        // Verified against Accurate RJN/2610/HZ00250; keep this alias CN-scoped.
        ...(creditNote === "CN-026194" && retailerCode === "MKS-001359" && nameCodes.length === 0
          ? ["C-LIN024"] : []),
      ])],
      verifiedCustomer = heinzVerifiedCustomer(creditNote, retailerCode, text(cell(row, header.columns, "RETAILER_NAME")), text(cell(row, header.columns, "REMARKS"))),
      customerIdentities = new Set(parsedCandidates.map(code => code.replace(/^(C-[A-Z]*)0+(?=\d+$)/, "$1"))),
      candidates = verifiedCustomer ? [verifiedCustomer]
        : customerIdentities.size === 1 && parsedCandidates.includes(retailerCode) ? [retailerCode]
        : customerIdentities.size === 1 ? [parsedCandidates[0]] : parsedCandidates,
      customerCode = candidates.length === 1 ? candidates[0] : retailerCode,
      invalidReason = candidates.length === 1 ? null :
        `Kode pelanggan HEINZ ${candidates.length ? "berbeda/ambigu" : "belum dikenali"} pada HEADER baris ${sourceRowNumber}: ${text(cell(row, header.columns, "RETAILER_NAME"))} (retailer_code: ${retailerCode})`,
      lineCount = requiredSigned(
        cell(row, header.columns, "LINE_COUNT"),
        "line_count",
        sourceRowNumber,
      );
    if (!Number.isInteger(lineCount) || lineCount < 0)
      throw new Error(
        `line_count harus bilangan bulat non-negatif pada baris ${sourceRowNumber}`,
      );
    approved.set(creditNote, {
      customerCode,
      invalidReason,
      lineCount,
      sourceRowNumber,
    });
  }

  const detailRows = readRows(detailBuffer, "Sheet1"),
    detailRequired = [
      "CREDIT_NOTE_NUMBER",
      "LINE_NUMBER",
      "DISTRIBUTOR_STOCK_KEEPING_UNIT",
      "UNIT_QUANTITY",
      "UNIT",
      "EACHES_QUANTITY",
      "UNIT_PRICE",
      "GROSS_VALUE",
      "RETURN_CODE",
    ],
    detail = findHeader(detailRows, detailRequired),
    grouped = new Map<string, CanonicalReturnLine[]>(),
    invalidLines: CanonicalReturnLine[] = [];
  for (let index = detail.rowIndex + 1; index < detailRows.length; index++) {
    const row = detailRows[index], sourceRowNumber = index + 1;
    if (!row.some((entry) => text(entry))) continue;
    const creditNote = requiredText(
        row,
        detail.columns,
        "CREDIT_NOTE_NUMBER",
        sourceRowNumber,
      ),
      headerRow = approved.get(creditNote);
    const
      principalProductCode = requiredText(
        row,
        detail.columns,
        "DISTRIBUTOR_STOCK_KEEPING_UNIT",
        sourceRowNumber,
      ),
      accurateProductCode = mappings.get(principalProductCode) ?? null,
      total = requiredFinite(
        cell(row, detail.columns, "GROSS_VALUE"),
        "gross_value",
        sourceRowNumber,
      ),
      line: CanonicalReturnLine = {
        source: "PRINCIPAL",
        sourceRowNumber,
        invoiceNumber: creditNote,
        customerCode: headerRow?.customerCode ?? "",
        accurateProductCode,
        principalProductCode,
        quantity: requiredFinite(
          cell(row, detail.columns, "EACHES_QUANTITY"),
          "eaches_quantity",
          sourceRowNumber,
        ),
        dpp: total / 1.11,
        tax: total - total / 1.11,
        total,
        invalidReason: headerRow
          ? headerRow.invalidReason
          : `HEADER Approved tidak ditemukan untuk ${creditNote}`,
      };
    if (!headerRow) {
      invalidLines.push(line);
      continue;
    }
    const lines = grouped.get(creditNote) ?? [];
    lines.push(line);
    grouped.set(creditNote, lines);
  }

  const lines: CanonicalReturnLine[] = [],
    unmappedLines: CanonicalReturnLine[] = [];
  for (const [creditNote, headerRow] of approved) {
    const creditNoteLines = grouped.get(creditNote) ?? [],
      expected = headerRow.lineCount;
    if (creditNoteLines.length !== expected) {
      if (!creditNoteLines.length)
        invalidLines.push({
          source: "PRINCIPAL",
          sourceRowNumber: headerRow.sourceRowNumber,
          invoiceNumber: creditNote,
          customerCode: headerRow.customerCode,
          accurateProductCode: null,
          principalProductCode: null,
          quantity: 0,
          dpp: 0,
          tax: 0,
          total: 0,
          invalidReason: `line_count ${expected} tidak sama dengan 0 detail untuk ${creditNote}`,
        });
      for (const line of creditNoteLines)
        invalidLines.push({
          ...line,
          invalidReason: `line_count ${expected} tidak sama dengan ${creditNoteLines.length} detail untuk ${creditNote}`,
        });
      continue;
    }
    for (const line of creditNoteLines)
      (line.invalidReason ? invalidLines : line.accurateProductCode ? lines : unmappedLines).push(line);
  }
  return { lines, unmappedLines, invalidLines };
}

function cussonsNumber(value: unknown, label: string, row: number): number {
  if (value == null || text(value) === "")
    throw new Error(`${label} kosong pada baris ${row}`);
  const parsed =
    typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`${label} tidak valid pada baris ${row}`);
  return parsed;
}

function separateDuplicateCustomers(
  lines: CanonicalReturnLine[],
  invalidLines: CanonicalReturnLine[],
  customerScopeLines: CanonicalReturnLine[],
): {
  lines: CanonicalReturnLine[];
  invalidLines: CanonicalReturnLine[];
} {
  const customers = new Map<string, Set<string>>();
  for (const line of customerScopeLines) {
    const values = customers.get(line.invoiceNumber) ?? new Set<string>();
    values.add(line.customerCode);
    customers.set(line.invoiceNumber, values);
  }
  const ambiguous = new Set(
      [...customers]
        .filter(([, values]) => values.size > 1)
        .map(([invoice]) => invoice),
    ),
    ambiguousLines = new Set(
      customerScopeLines.filter((line) => ambiguous.has(line.invoiceNumber)),
    );
  return {
    lines: lines.filter((line) => !ambiguousLines.has(line)),
    invalidLines: [
      ...invalidLines.filter((line) => !ambiguousLines.has(line)),
      ...customerScopeLines
        .filter((line) => ambiguousLines.has(line))
        .map((line) => ({
          ...line,
          invalidReason: `${line.invoiceNumber} memuat lebih dari satu customer`,
        })),
    ],
  };
}

function parseCussonsAccurate(
  buffer: Buffer | Uint8Array,
): { lines: CanonicalReturnLine[]; invalidLines: CanonicalReturnLine[] } {
  const rows = readRows(buffer, "Rincian Faktur Penjualan"),
    required = [
      "NO_NOTA",
      "KODE PELANGGAN INDUK",
      "KODE_BARANG",
      "QTY_SATUANKECIL",
      "DPP",
      "NILAI_PAJAK",
      "JUMLAH",
      "REM",
      "JENIS_TRANSAKSI",
    ],
    header = findHeader(rows, required),
    parsed: CanonicalReturnLine[] = [],
    invalidLines: CanonicalReturnLine[] = [],
    customerScopeLines: CanonicalReturnLine[] = [];
  for (let index = header.rowIndex + 1; index < rows.length; index++) {
    const row = rows[index], sourceRowNumber = index + 1;
    if (!row.some((entry) => text(entry))) continue;
    if (
      !text(cell(row, header.columns, "JENIS_TRANSAKSI")).includes(
        "RETUR PENJUALAN",
      )
    )
      continue;
    const matches =
      text(cell(row, header.columns, "REM")).match(
        /(?<![A-Z0-9])CN\d+(?![A-Z0-9])/g,
      ) ?? [];
    // Confirmed reference for this return only; explicit CN in REM takes precedence.
    if (
      !matches.length &&
      text(cell(row, header.columns, "NO_NOTA")) === "RJN/2610/CS00069"
    ) matches.push("CN023391");
    let invalidReason =
      matches.length > 0
        ? null
        : `REM harus memuat setidaknya satu token CN pada baris ${sourceRowNumber}`;
    const customerCode = text(
        cell(row, header.columns, "KODE PELANGGAN INDUK"),
      ),
      accurateProductCode = text(cell(row, header.columns, "KODE_BARANG"));
    if (!customerCode)
      invalidReason ??= `KODE PELANGGAN INDUK kosong pada baris ${sourceRowNumber}`;
    if (!accurateProductCode)
      invalidReason ??= `KODE_BARANG kosong pada baris ${sourceRowNumber}`;
    let quantity = 0, dpp = 0, tax = 0, total = 0;
    try {
      quantity = cussonsNumber(
        cell(row, header.columns, "QTY_SATUANKECIL"),
        "QTY_SATUANKECIL",
        sourceRowNumber,
      );
      dpp = cussonsNumber(
        cell(row, header.columns, "DPP"),
        "DPP",
        sourceRowNumber,
      );
      tax = cussonsNumber(
        cell(row, header.columns, "NILAI_PAJAK"),
        "NILAI_PAJAK",
        sourceRowNumber,
      );
      total = cussonsNumber(
        cell(row, header.columns, "JUMLAH"),
        "JUMLAH",
        sourceRowNumber,
      );
    } catch (error) {
      invalidReason ??=
        error instanceof Error ? error.message : "Nilai Accurate tidak valid";
    }
    const line: CanonicalReturnLine = {
      source: "ACCURATE",
      sourceRowNumber,
      invoiceNumber:
        (matches.length ? [...new Set(matches)].sort().join(", ") : null) ??
        text(cell(row, header.columns, "NO_NOTA")) ??
        `BARIS-${sourceRowNumber}`,
      customerCode,
      accurateProductCode: accurateProductCode || null,
      principalProductCode: null,
      quantity,
      dpp,
      tax,
      total,
      invalidReason,
    };
    if (matches.length > 0 && customerCode) customerScopeLines.push(line);
    (invalidReason ? invalidLines : parsed).push(line);
  }
  const unique = separateDuplicateCustomers(
    parsed,
    invalidLines,
    customerScopeLines,
  );
  return {
    lines: unique.lines,
    invalidLines: unique.invalidLines,
  };
}

function parseCussonsPrincipal(
  buffer: Buffer | Uint8Array,
  mappings: CussonsMappings,
): {
  lines: CanonicalReturnLine[];
  unmappedLines: CanonicalReturnLine[];
  invalidLines: CanonicalReturnLine[];
} {
  const rows = readRows(buffer, "Sheet1"),
    required = [
      "CREDIT NOTE NO",
      "CUSTOMER CODE",
      "ROUTE CODE",
      "PRODUCT CODE",
      "PRODUCT DESCRIPTION",
      "UOM CODE",
      "SELLING TYPE",
      "PRD QTY",
      "UOM LIST PRICE",
      "GROSS AMOUNT",
      "DISCOUNT AMOUNT",
      "TOTAL AMOUNT AFTER SKU",
      "CUSTOMER DISCOUNT AMOUNT",
      "TOTAL TAX AMOUNT",
      "TOTAL NET AMOUNT",
      "TAX CODE",
      "TAX PERCENTAGE 1",
    ],
    header = findHeader(rows, required),
    parsed: CanonicalReturnLine[] = [],
    invalidLines: CanonicalReturnLine[] = [],
    customerScopeLines: CanonicalReturnLine[] = [];
  for (let index = header.rowIndex + 1; index < rows.length; index++) {
    const row = rows[index], sourceRowNumber = index + 1;
    if (!row.some((entry) => text(entry))) continue;
    const matches =
        text(cell(row, header.columns, "CREDIT NOTE NO")).match(
          /(?<![A-Z0-9])CN\d+(?![A-Z0-9])/g,
        ) ?? [],
      customerCode = text(cell(row, header.columns, "CUSTOMER CODE")),
      principalProductCode = text(cell(row, header.columns, "PRODUCT CODE")),
      mapping = mappings.products.get(principalProductCode);
    let invalidReason =
      matches.length === 1
        ? null
        : `Credit Note No harus memuat tepat satu token pada baris ${sourceRowNumber}`;
    if (!customerCode)
      invalidReason ??= `Customer Code kosong pada baris ${sourceRowNumber}`;
    if (!principalProductCode)
      invalidReason ??= `Product Code kosong pada baris ${sourceRowNumber}`;
    let quantity = 0,
      dpp = 0,
      tax = 0,
      total = 0,
      conversionUnmapped = false;
    try {
      const principalQuantity = cussonsNumber(
          cell(row, header.columns, "PRD QTY"),
          "Prd Qty",
          sourceRowNumber,
        ),
        price = cussonsNumber(
          cell(row, header.columns, "UOM LIST PRICE"),
          "UOM List Price",
          sourceRowNumber,
        ),
        gross = cussonsNumber(
          cell(row, header.columns, "GROSS AMOUNT"),
          "Gross Amount",
          sourceRowNumber,
        ),
        discount = cussonsNumber(
          cell(row, header.columns, "DISCOUNT AMOUNT"),
          "Discount Amount",
          sourceRowNumber,
        ),
        afterSku = cussonsNumber(
          cell(row, header.columns, "TOTAL AMOUNT AFTER SKU"),
          "Total Amount After SKU",
          sourceRowNumber,
        ),
        customerDiscount = cussonsNumber(
          cell(row, header.columns, "CUSTOMER DISCOUNT AMOUNT"),
          "Customer Discount Amount",
          sourceRowNumber,
        ),
        taxPercentage = cussonsNumber(
          cell(row, header.columns, "TAX PERCENTAGE 1"),
          "Tax Percentage 1",
          sourceRowNumber,
        );
      tax = cussonsNumber(
        cell(row, header.columns, "TOTAL TAX AMOUNT"),
        "Total Tax Amount",
        sourceRowNumber,
      );
      total = cussonsNumber(
        cell(row, header.columns, "TOTAL NET AMOUNT"),
        "Total Net Amount",
        sourceRowNumber,
      );
      dpp = afterSku - customerDiscount;
      if (dpp < 0)
        throw new Error(`DPP tidak valid pada baris ${sourceRowNumber}`);
      const formula = (
        actual: number,
        expected: number,
        label: string,
      ) => {
        if (Math.abs(actual - expected) > 1 + 1e-9)
          throw new Error(`${label} tidak konsisten pada baris ${sourceRowNumber}`);
      };
      formula(gross, principalQuantity * price, "Gross Amount");
      formula(afterSku, gross - discount, "Total Amount After SKU");
      formula(tax, (dpp * taxPercentage) / 100, "Total Tax Amount");
      // CUSSONS exports total before customer discount; DPP remains net of it.
      formula(total, afterSku + tax, "Total Net Amount");
      if (text(cell(row, header.columns, "SELLING TYPE")) !== "S")
        throw new Error(`Selling Type harus S pada baris ${sourceRowNumber}`);
      if (text(cell(row, header.columns, "TAX CODE")) !== "PPN_OUTPUT")
        throw new Error(`Tax Code harus PPN_Output pada baris ${sourceRowNumber}`);
      if (Math.abs(taxPercentage - 11) > 1e-9)
        throw new Error(`Tax Percentage 1 harus 11 pada baris ${sourceRowNumber}`);
      const unit = text(cell(row, header.columns, "UOM CODE"));
      if (unit === "EA") quantity = principalQuantity;
      else if (unit === "CS") {
        if (!mapping?.caseSize || mapping.caseSize <= 0) {
          quantity = principalQuantity;
          conversionUnmapped = true;
        } else quantity = principalQuantity * mapping.caseSize;
      } else
        throw new Error(`UOM code harus EA atau CS pada baris ${sourceRowNumber}`);
    } catch (error) {
      invalidReason ??=
        error instanceof Error ? error.message : "Nilai CUSSONS tidak valid";
    }
    const line: CanonicalReturnLine = {
      source: "PRINCIPAL",
      sourceRowNumber,
      invoiceNumber: matches[0] ?? `BARIS-${sourceRowNumber}`,
      customerCode,
      accurateProductCode:
        mapping?.mappingStatus === "OK" && !conversionUnmapped
          ? mapping.productCodeInternal
          : null,
      principalProductCode: principalProductCode || null,
      quantity,
      dpp,
      tax,
      total,
      invalidReason,
    };
    if (matches.length === 1 && customerCode) customerScopeLines.push(line);
    (invalidReason ? invalidLines : parsed).push(line);
  }
  const unique = separateDuplicateCustomers(
      parsed,
      invalidLines,
      customerScopeLines,
    ),
    lines: CanonicalReturnLine[] = [],
    unmappedLines: CanonicalReturnLine[] = [];
  for (const line of unique.lines)
    (line.accurateProductCode ? lines : unmappedLines).push(line);
  return {
    lines,
    unmappedLines,
    invalidLines: unique.invalidLines,
  };
}

function key(
  line: CanonicalReturnLine,
  matchingProductCode?: (line: CanonicalReturnLine) => string | null,
  matchingCustomerCode?: (line: CanonicalReturnLine) => string,
): string {
  return `${line.invoiceNumber}|${
    matchingProductCode?.(line) ??
    line.principalProductCode ??
    line.accurateProductCode
  }|${matchingCustomerCode?.(line) ?? line.customerCode}`;
}

function aggregate(
  lines: CanonicalReturnLine[],
  matchingProductCode?: (line: CanonicalReturnLine) => string | null,
  matchingCustomerCode?: (line: CanonicalReturnLine) => string,
): Map<string, Aggregate> {
  const output = new Map<string, Aggregate>();
  for (const line of lines) {
    const id = key(line, matchingProductCode, matchingCustomerCode),
      existing = output.get(id);
    if (existing) {
      existing.quantity += line.quantity;
      existing.dpp += line.dpp;
      existing.tax += line.tax;
      existing.total += line.total;
      existing.sourceRows.push(line.sourceRowNumber);
      if (
        line.principalProductCode &&
        !existing.principalProductCode
          ?.split(", ")
          .includes(line.principalProductCode)
      )
        existing.principalProductCode = [
          existing.principalProductCode,
          line.principalProductCode,
        ]
          .filter(Boolean)
          .join(", ");
    } else {
      output.set(id, {
        invoiceNumber: line.invoiceNumber,
        customerCode: line.customerCode,
        accurateProductCode: line.accurateProductCode,
        principalProductCode: line.principalProductCode,
        quantity: line.quantity,
        dpp: line.dpp,
        tax: line.tax,
        total: line.total,
        sourceRows: [line.sourceRowNumber],
        invalidReason: line.invalidReason,
      });
    }
  }
  return output;
}

function result(
  accurate: Aggregate | undefined,
  principal: Aggregate | undefined,
  status: ReturnStatus,
): ReturnReconciliationResult {
  const source = accurate ?? principal!;
  return {
    invoiceNumber: source.invoiceNumber,
    customerCode: source.customerCode,
    accurateProductCode: accurate?.accurateProductCode ?? null,
    principalProductCode:
      accurate?.principalProductCode ?? principal?.principalProductCode ?? null,
    accurateQuantity: accurate?.quantity ?? 0,
    principalQuantity: principal?.quantity ?? 0,
    quantityDifference: (accurate?.quantity ?? 0) - (principal?.quantity ?? 0),
    accurateDpp: accurate?.dpp ?? 0,
    principalDpp: principal?.dpp ?? 0,
    dppDifference: (accurate?.dpp ?? 0) - (principal?.dpp ?? 0),
    accurateTax: accurate?.tax ?? 0,
    principalTax: principal?.tax ?? 0,
    accurateTotal: accurate?.total ?? 0,
    principalTotal: principal?.total ?? 0,
    status,
    invalidReason: source.invalidReason ?? null,
    warnings:
      status === "MATCH"
        ? []
        : status === "INVALID_DATA" && source.invalidReason
          ? [source.invalidReason]
          : [status.replaceAll("_", " ")],
    accurateSourceRows: accurate?.sourceRows ?? [],
    principalSourceRows: principal?.sourceRows ?? [],
  };
}

function reconcileParsedReturns({
  accurateLines,
  matchableAccurateLines = accurateLines,
  principalLines,
  matchablePrincipalLines = principalLines,
  invalidAccurateLines = [],
  invalidPrincipalLines = [],
  unmappedPrincipalLines = [],
  dppTolerance,
  unmappedAccurateStatus = () => "UNMAPPED",
  matchingProductCode,
  matchingCustomerCode,
  isAccurateMapped = (line) => line.principalProductCode !== null,
}: {
  accurateLines: CanonicalReturnLine[];
  matchableAccurateLines?: CanonicalReturnLine[];
  principalLines: CanonicalReturnLine[];
  matchablePrincipalLines?: CanonicalReturnLine[];
  invalidAccurateLines?: CanonicalReturnLine[];
  invalidPrincipalLines?: CanonicalReturnLine[];
  unmappedPrincipalLines?: CanonicalReturnLine[];
  dppTolerance: number;
  unmappedAccurateStatus?: (line: Aggregate) => ReturnStatus;
  matchingProductCode?: (line: CanonicalReturnLine) => string | null;
  matchingCustomerCode?: (line: CanonicalReturnLine) => string;
  isAccurateMapped?: (line: CanonicalReturnLine) => boolean;
}): ReturnReconciliationOutput {
  const mappedAccurate = aggregate(
      matchableAccurateLines.filter(isAccurateMapped),
      matchingProductCode,
      matchingCustomerCode,
    ),
    principals = aggregate(
      matchablePrincipalLines,
      matchingProductCode,
      matchingCustomerCode,
    ),
    results: ReturnReconciliationResult[] = [];

  for (const invalid of invalidAccurateLines)
    results.push(
      result(
        { ...invalid, sourceRows: [invalid.sourceRowNumber] },
        undefined,
        "INVALID_DATA",
      ),
    );
  for (const invalid of aggregate(invalidPrincipalLines).values())
    results.push(result(undefined, invalid, "INVALID_DATA"));
  for (const unmapped of aggregate(
    matchableAccurateLines.filter((line) => !isAccurateMapped(line)),
    matchingProductCode,
    matchingCustomerCode,
  ).values())
    results.push(result(unmapped, undefined, unmappedAccurateStatus(unmapped)));
  for (const unmapped of aggregate(unmappedPrincipalLines).values())
    results.push(result(undefined, unmapped, "UNMAPPED"));

  for (const [id, accurate] of mappedAccurate) {
    const principal = principals.get(id);
    if (!principal) {
      results.push(result(accurate, undefined, "MISSING_PRINCIPAL"));
      continue;
    }
    principals.delete(id);
    const quantityMismatch = accurate.quantity !== principal.quantity,
      valueMismatch =
        Math.abs(accurate.dpp - principal.dpp) > dppTolerance + 1e-9,
      status: ReturnStatus = quantityMismatch
        ? valueMismatch
          ? "QTY_AND_VALUE_MISMATCH"
          : "QTY_MISMATCH"
        : valueMismatch
          ? "VALUE_MISMATCH"
          : "MATCH";
    results.push(result(accurate, principal, status));
  }
  for (const principal of principals.values())
    results.push(result(undefined, principal, "MISSING_ACCURATE"));

  const summary = Object.fromEntries(
    STATUSES.map((status) => [status, 0]),
  ) as Record<ReturnStatus, number>;
  for (const row of results) summary[row.status]++;
  return { accurateLines, principalLines, results, summary };
}

export function reconcileShinzuiReturns(
  accurateBuffer: Buffer | Uint8Array,
  principalBuffer: Buffer | Uint8Array,
  mappingBuffer: Buffer | Uint8Array,
  options: { dppTolerance?: number } = {},
): ReturnReconciliationOutput {
  const dppTolerance = options.dppTolerance ?? 1;
  if (!Number.isFinite(dppTolerance) || dppTolerance < 0)
    throw new Error("Toleransi DPP tidak valid");
  const mappings = parseMappings(mappingBuffer),
    principalLines = parsePrincipal(principalBuffer),
    accurateLines = parseAccurate(accurateBuffer, mappings, principalLines);
  return reconcileParsedReturns({
    accurateLines,
    principalLines,
    dppTolerance,
  });
}

export function reconcileKinoReturns(
  accurateBuffer: Buffer | Uint8Array,
  principalBuffer: Buffer | Uint8Array,
  mappingBuffer: Buffer | Uint8Array,
  options: { dppTolerance?: number } = {},
): ReturnReconciliationOutput {
  const dppTolerance = options.dppTolerance ?? 1;
  if (!Number.isFinite(dppTolerance) || dppTolerance < 0)
    throw new Error("Toleransi DPP tidak valid");
  const ignoredLines: IgnoredReturnLine[] = [];
  const correctionLines: CanonicalReturnLine[] = [];
  // User-confirmed reference corrections; scoped to the exact return and INV pair.
  const referenceCorrections: Record<string, [string, string]> = {
    "1671-SRI-260002407": ["INV/2607/KN00580", "INV/2606/KN00580"],
    "1671-SRI-260002408": ["INV/2607/KN00195", "INV/2606/KN00195"],
    "1671-SRI-260002414": ["INV/2608/KN01685", "INV/2606/KN01685"],
    "1671-SRI-260002509": ["INV/2601/KN01040", "INV/2601/KN1040"],
    "1671-SRI-260002351": ["INV/2610/KN00630", "INV/2604/KN00630"],
    "1671-SRI-260002352": ["INV/2610/KN00716", "INV/2606/KN00716"],
    "1671-SRI-260002353": ["INV/2610/KN00732", "INV/2606/KN00732"],
    "1671-SRI-260002355": ["INV/2610/KN00148", "INV/2606/KN00148"],
    "1671-SRI-260002357": ["INV/2607/KN00230", "INV/2606/KN00230"],
  };
  const customerAliases: Record<string, string> = {
    "122120206937": "C-SUK241",
    "322660832363": "C-RAI133",
    "524100473193": "C-M20001",
    "C-IN0050": "C-IN0087",
    "C-AL0063": "C-ALF052",
    "C-HE0027": "C-MIT058",
    "322630771184": "C-CIT780",
    "52410325906": "C-SAT307",
    "923120291495": "C-CIT040",
    "22120007096": "C-PRA004",
    "52330222295": "C-BER030",
    "322510497184": "C-SYA061",
    "52440374771": "C-ABI010",
    "52330224298": "C-TK0006",
    "52430367095": "C-UKM004",
    "322510498179": "C-DIA062",
    "52450393538": "C-YON003",
    "523110269609": "C-NUS001",
    "52310213576": "C-IL0006",
    "322650803073": "C-NAF006",
  };
  const mappings = parseKinoReturnMappings(mappingBuffer),
    parsedAccurate = parseKinoAccurate(accurateBuffer),
    accurateScopes = new Set(parsedAccurate.lines.map(line => `${line.invoiceNumber}|${line.customerCode}`)),
    principalLines = parseKinoPrincipal(principalBuffer, mappings, ignoredLines, correctionLines).map(line => {
      // PERLU PERSETUJUAN PEMILIK sebelum rilis. Alias terkonfirmasi hanya fallback:
      // pasangan kode asli pada invoice yang sama selalu didahulukan.
      const alias = customerAliases[line.customerCode];
      if (alias
        && !accurateScopes.has(`${line.invoiceNumber}|${line.customerCode}`)
        && accurateScopes.has(`${line.invoiceNumber}|${alias}`)) {
        return { ...line, customerCode: alias };
      }
      return line;
    }),
    retainedAccurate = parsedAccurate.lines.filter((line) => {
      // PERLU PERSETUJUAN PEMILIK sebelum rilis. Jangan mengecualikan seluruh invoice:
      // perlu referensi INV eksplisit di REM, invoice KINO, dan mapping produk.
      if (principalLines.some((principal) => principal.invoiceNumber === line.invoiceNumber
        && principal.accurateProductCode === line.accurateProductCode)) return true;
      const excluded = ignoredLines.filter((ignored) => ignored.invoiceNumber === line.invoiceNumber
        && mappings.get(ignored.principalProductCode) === line.accurateProductCode
        && (line.correctionInvoiceReferences?.includes(ignored.taxNumber)
          || (referenceCorrections[line.invoiceNumber]?.[0] === ignored.taxNumber
            && line.correctionInvoiceReferences?.includes(referenceCorrections[line.invoiceNumber][1])
            && correctionLines.some((correction) => correction.sourceRowNumber === ignored.sourceRowNumber
              && (line.customerCode === correction.customerCode
                || line.customerCode === customerAliases[correction.customerCode]
                || (line.invoiceNumber === "1671-SRI-260002509"
                  && line.customerCode === "C-FAT040" && correction.customerCode === "322580649940"))))));
      if (!excluded.length) return true;
      for (const ignored of excluded) {
        (ignored.accurateSourceRows ??= []).push(line.sourceRowNumber);
      }
      return false;
    }),
    accurateLines = [...retainedAccurate, ...parsedAccurate.invalidLines],
    mappedAccurateCodes = new Set(mappings.values()),
    principalScopes = new Set(
      principalLines.map(
        (line) => `${line.invoiceNumber}|${line.customerCode}`,
      ),
    );
  const output = reconcileParsedReturns({
    accurateLines,
    matchableAccurateLines: retainedAccurate,
    principalLines,
    matchablePrincipalLines: principalLines.filter(
      (line) => line.accurateProductCode !== null,
    ),
    invalidAccurateLines: parsedAccurate.invalidLines,
    unmappedPrincipalLines: principalLines.filter(
      (line) => line.accurateProductCode === null,
    ),
    matchingProductCode: (line) => line.accurateProductCode,
    isAccurateMapped: (line) =>
      line.accurateProductCode !== null &&
      mappedAccurateCodes.has(line.accurateProductCode),
    dppTolerance,
    unmappedAccurateStatus: (line) =>
      principalScopes.has(`${line.invoiceNumber}|${line.customerCode}`)
        ? "UNMAPPED"
        : "MISSING_PRINCIPAL",
  });
  const correctionGroups = new Map<string, IgnoredReturnLine[]>();
  for (const ignored of ignoredLines) {
    const line = correctionLines.find((entry) => entry.sourceRowNumber === ignored.sourceRowNumber)!;
    const id = `${line.invoiceNumber}|${line.customerCode}|${line.accurateProductCode ?? line.principalProductCode}|${ignored.taxNumber}`;
    correctionGroups.set(id, [...(correctionGroups.get(id) ?? []), ignored]);
  }
  const assignedAccurateRows = new Set<number>();
  for (const group of correctionGroups.values()) {
    const sourceRows = new Set(group.map((line) => line.sourceRowNumber));
    const pairedRows = new Set(group.flatMap((line) => line.accurateSourceRows ?? []).filter((row) => !assignedAccurateRows.has(row)));
    for (const row of pairedRows) assignedAccurateRows.add(row);
    const principal = [...aggregate(correctionLines.filter((line) => sourceRows.has(line.sourceRowNumber)), () => "KOREKSI").values()][0];
    const accurate = [...aggregate(parsedAccurate.lines.filter((line) => pairedRows.has(line.sourceRowNumber)), () => "KOREKSI", () => "KOREKSI").values()][0];
    const referenceCorrection = referenceCorrections[principal.invoiceNumber];
    const confirmedCorrection = referenceCorrection?.[0] === group[0].taxNumber;
    // Explicit approvals only; never ignore month differences on new returns.
    const matchApproved = ["1671-SRI-260002407", "1671-SRI-260002408", "1671-SRI-260002414"].includes(principal.invoiceNumber);
    const matches = (!confirmedCorrection || matchApproved) && accurate !== undefined && accurate.quantity === principal.quantity
      && Math.abs(accurate.dpp - principal.dpp) <= dppTolerance + 1e-9;
    // User approved pairing this exact return for variance review, not forced MATCH.
    const reviewVariance = confirmedCorrection && principal.invoiceNumber === "1671-SRI-260002509" && accurate !== undefined;
    const qtyDiffers = accurate !== undefined && accurate.quantity !== principal.quantity;
    const valueDiffers = accurate !== undefined && Math.abs(accurate.dpp - principal.dpp) > dppTolerance + 1e-9;
    const status: ReturnStatus = reviewVariance
      ? qtyDiffers ? valueDiffers ? "QTY_AND_VALUE_MISMATCH" : "QTY_MISMATCH"
        : valueDiffers ? "VALUE_MISMATCH" : "MATCH"
      : matches ? "MATCH" : "KOREKSI";
    const correction = result(accurate, principal, status);
    if (!matches) correction.warnings = [`Koreksi — PAJAK_NO ${group[0].taxNumber} berawalan INV.`,
      accurate ? `Pasangan ditemukan tetapi belum cocok. Qty Accurate ${accurate.quantity}, KINO ${principal.quantity}; DPP Accurate ${accurate.dpp}, KINO ${principal.dpp}.` : "Pasangan Accurate belum terverifikasi; tidak dipaksakan cocok."];
    if (confirmedCorrection) correction.warnings = [
      `Koreksi referensi INV dikonfirmasi pengguna: KINO ${referenceCorrection[0]}, Accurate ${referenceCorrection[1]}.`,
      accurate ? `Pasangan tersedia. Qty Accurate ${accurate.quantity}, KINO ${principal.quantity}; DPP Accurate ${accurate.dpp}, KINO ${principal.dpp}.`
        : "Pasangan Accurate belum terverifikasi; periksa mapping produk.",
    ];
    output.results.push(correction);
    output.summary[status] = (output.summary[status] ?? 0) + 1;
  }
  // User-confirmed correction: admin omitted PAJAK_NO for this exact return/product.
  for (const row of output.results) {
    if (row.invoiceNumber !== "1671-SRI-260002453"
      || row.customerCode !== "C-MO0015"
      || row.principalProductCode !== "110064"
      || !["UNMAPPED", "MISSING_ACCURATE"].includes(row.status)) continue;
    output.summary[row.status]!--;
    row.status = "KOREKSI";
    output.summary.KOREKSI = (output.summary.KOREKSI ?? 0) + 1;
    row.warnings = ["Koreksi dikonfirmasi pengguna: admin lupa mengisi kolom koreksi (PAJAK_NO). Nilai sumber tetap ditampilkan; pasangan Accurate belum terverifikasi."];
  }
  return { ...output, ignoredLines: [] };
}

export function reconcileGodrejReturns(
  accurateBuffer: Buffer | Uint8Array,
  principalBuffer: Buffer | Uint8Array,
  mappingBuffer: Buffer | Uint8Array,
  options: { dppTolerance?: number } = {},
): ReturnReconciliationOutput {
  const dppTolerance = options.dppTolerance ?? 1;
  if (!Number.isFinite(dppTolerance) || dppTolerance < 0)
    throw new Error("Toleransi DPP tidak valid");
  const mappings = parseGodrejMappings(mappingBuffer),
    principal = parseGodrejPrincipal(principalBuffer, mappings),
    accurate = parseGodrejAccurate(accurateBuffer),
    accurateScopes = new Set(accurate.lines.map((line) => `${line.invoiceNumber}|${line.customerCode}`));
  // Verified split return: keep source rows once, compare the explicit two-return group.
  const joinedReturn = "RB/BFG-10000006561, RB/BFG-10000006562";
  const joinedReferences = joinedReturn.split(", ");
  const rawAccurate = readRows(accurateBuffer, "Rincian Faktur Penjualan");
  const rawHeader = findHeader(rawAccurate, ["NO_NOTA", "REM"]);
  const combinedRows = accurate.invalidLines.filter(line => {
    const raw = rawAccurate[line.sourceRowNumber - 1];
    const refs = text(cell(raw, rawHeader.columns, "REM")).match(/(?<![A-Z0-9])RB\/BFG-\d+(?![A-Z0-9])/g) ?? [];
    return line.invoiceNumber === "RJN/2611/GD00044" && line.customerCode === "C-CI0014"
      && line.invalidReason === "REM memuat lebih dari satu nomor return GODREJ RB/BFG."
      && refs.length === 2 && [...refs].sort().join(", ") === joinedReturn;
  });
  if (combinedRows.length && joinedReferences.every(ref => principal.lines.some(line => line.invoiceNumber === ref && line.customerCode === "C-CI0014"))) {
    for (const line of combinedRows) {
      line.invoiceNumber = joinedReturn;
      line.invalidReason = null;
      accurate.lines.push(line);
    }
    accurate.invalidLines = accurate.invalidLines.filter(line => !combinedRows.includes(line));
    for (const line of [...principal.lines, ...principal.unmappedLines]) {
      if (joinedReferences.includes(line.invoiceNumber) && line.customerCode === "C-CI0014") line.invoiceNumber = joinedReturn;
    }
  }
  // User-confirmed GODREJ alias; prefer an existing original customer on the same return.
  const customerAliases: Record<string, string> = {
    "C-GI0010": "C-MIT057",
    "C-IN00": "C-IN0081",
    "C-CIT0": "C-CIT002",
    "C-SUR09": "C-SUR097",
    "C-HE0027": "C-MIT058",
    "C-JAS080": "C-JA0011",
    "C-KIN009": "C-KIN012",
    "C-JAN469": "C-ARM013",
  };
  for (const line of [...principal.lines, ...principal.unmappedLines]) {
    const alias = customerAliases[line.customerCode];
    if (alias
      && !accurateScopes.has(`${line.invoiceNumber}|${line.customerCode}`)
      && accurateScopes.has(`${line.invoiceNumber}|${alias}`)) {
      line.customerCodeRaw = line.customerCode;
      line.customerCode = alias;
    }
  }
  const
    accurateLines = [...accurate.lines, ...accurate.invalidLines],
    principalLines = [...principal.lines, ...principal.unmappedLines];
  const output = reconcileParsedReturns({
    accurateLines,
    matchableAccurateLines: accurate.lines,
    principalLines,
    matchablePrincipalLines: principal.lines,
    invalidAccurateLines: accurate.invalidLines,
    unmappedPrincipalLines: principal.unmappedLines,
    matchingProductCode: (line) => line.accurateProductCode,
    isAccurateMapped: () => true,
    dppTolerance,
  });
  const sourceLines = new Map(principalLines.map((line) => [line.sourceRowNumber, line]));
  for (const row of output.results) {
    const sources = row.principalSourceRows.map((number) => sourceLines.get(number));
    // Only fully correction groups qualify; preserve ordinary transactions in mixed groups.
    if (!sources.length || !sources.every((line) => line?.correctionBillNumber)) continue;
    if (row.status === "MATCH" || row.status === "INVALID_DATA") continue;
    const bills = [...new Set(sources.map((line) => line!.correctionBillNumber))];
    output.summary[row.status]!--;
    row.status = "KOREKSI";
    output.summary.KOREKSI = (output.summary.KOREKSI ?? 0) + 1;
    row.warnings = [
      `Koreksi — Bill No ${bills.join(", ")} berawalan FK/BFG-.`,
      ...row.warnings,
      row.accurateSourceRows.length
        ? "Pasangan ditemukan tetapi jumlah atau DPP belum cocok."
        : "Pasangan Accurate belum terverifikasi; tidak dipaksakan cocok.",
    ];
  }
  return output;
}

export function reconcileHeinzReturns(
  accurateBuffer: Buffer | Uint8Array,
  headerBuffer: Buffer | Uint8Array,
  detailBuffer: Buffer | Uint8Array,
  mappingBuffer: Buffer | Uint8Array,
  options: { dppTolerance?: number } = {},
): ReturnReconciliationOutput {
  const dppTolerance = options.dppTolerance ?? 1;
  if (!Number.isFinite(dppTolerance) || dppTolerance < 0)
    throw new Error("Toleransi DPP tidak valid");
  const mappings = parseHeinzMappings(mappingBuffer),
    principal = parseHeinzPrincipal(headerBuffer, detailBuffer, mappings),
    accurate = parseHeinzAccurate(accurateBuffer, headerBuffer),
    accurateLines = [...accurate.lines, ...accurate.invalidLines],
    principalLines = [
      ...principal.lines,
      ...principal.unmappedLines,
      ...principal.invalidLines,
    ];
  // Confirmed split return for HZ01015: pair the missing 270ml line, retain value differences.
  const splitAccurate = accurate.lines.filter(line => line.invoiceNumber === "CN-026166"
    && line.customerCode === "C-SI0056" && line.accurateProductCode === "A1120006027010");
  const splitPrincipal = principal.lines.filter(line => line.invoiceNumber === "CN-026174"
    && line.customerCode === "C-SI0056" && line.accurateProductCode === "A1120006027010");
  if (splitAccurate.length === 1 && splitPrincipal.length === 1
    && splitAccurate[0].quantity === splitPrincipal[0].quantity
    && !principalLines.some(line => line.invoiceNumber === "CN-026166" && line.accurateProductCode === "A1120006027010")) {
    splitAccurate[0].invoiceNumber = "CN-026166, CN-026174";
    splitPrincipal[0].invoiceNumber = "CN-026166, CN-026174";
  }
  // User-approved combined cancellations, scoped to known CN sets and the Accurate customer.
  // Require every product and quantity to agree before reconciling different customer codes.
  const combinedMatches = new Map<string, string>();
  for (const [reference, cns, customer] of [
    ["INV/2609/HZ02652", ["CN-025884", "CN-025885", "CN-025886", "CN-025887", "CN-025888", "CN-025889", "CN-025890", "CN-025891"], "C-RAD007"],
    ["INV/2610/HZ00668", ["CN-026142", "CN-026143", "CN-026144"], "C-BAY002"],
  ] as const) {
    const references = new Set<string>(cns);
    const belongs = (line: CanonicalReturnLine) => line.invoiceNumber.split(", ").some(cn => references.has(cn));
    const a = accurateLines.filter(belongs), p = principalLines.filter(belongs);
    if (!a.length || !cns.every(cn => p.some(line => line.invoiceNumber === cn))
      || a.some(line => line.invalidReason || line.customerCode !== customer || line.invoiceNumber.split(", ").some(cn => !references.has(cn)))
      || p.some(line => line.invalidReason || !line.accurateProductCode)) continue;
    const byProduct = (lines: CanonicalReturnLine[]) => {
      const totals = new Map<string, number[]>();
      for (const line of lines) {
        const values = totals.get(line.accurateProductCode!) ?? [0, 0, 0, 0];
        for (const [i, value] of [line.quantity, line.dpp, line.tax, line.total].entries()) values[i] += value;
        totals.set(line.accurateProductCode!, values);
      }
      return totals;
    };
    const av = byProduct(a), pv = byProduct(p);
    if (av.size !== pv.size || [...av].some(([product, values]) => {
      const other = pv.get(product);
      return !other || values[0] !== other[0] || values.slice(1).some((value, i) => Math.abs(value - other[i + 1]) > dppTolerance + 1e-9);
    })) continue;
    const invoice = cns.join(", ");
    for (const line of [...a, ...p]) {
      line.customerCodeRaw ??= line.customerCode;
      line.customerCode = customer;
      line.invoiceNumber = invoice;
    }
    combinedMatches.set(invoice, `MATCH gabungan ${reference}: seluruh produk, qty, DPP, pajak, dan total cocok dalam toleransi. CN: ${invoice}. Kode pelanggan disamakan hanya untuk kelompok ini.`);
  }
  // Linked references share a comparison group; source rows are never copied.
  const groups = new Map<string, Set<string>>();
  for (const line of accurate.lines) {
    const references = line.invoiceNumber.match(/CN-\d+/g) ?? [];
    const merged = new Set(references.flatMap((cn) => [...(groups.get(cn) ?? [cn])]));
    for (const cn of merged) groups.set(cn, merged);
  }
  for (const line of [...accurateLines, ...principalLines]) {
    const group = groups.get(line.invoiceNumber.split(", ")[0]);
    if (group) line.invoiceNumber = [...group].sort().join(", ");
  }
  // Compare unique remaining invoice/product pairs across customer codes; retain quantity/value differences.
  const productCode = (line: CanonicalReturnLine) => line.accurateProductCode;
  const accurateGroups = aggregate(accurate.lines, productCode);
  const principalGroups = aggregate(principal.lines, productCode);
  const customerAliases = new Map<string, string>();
  // These three CNs split the quantities on Accurate return HZ00307.
  for (const line of principal.lines) {
    if (line.invoiceNumber === "CN-026256, CN-026257, CN-026258" &&
        ["C-DAM008", "C-ARA004"].includes(line.customerCode) &&
        accurateGroups.has(key({ ...line, customerCode: "C-TOK148" }, productCode)))
      customerAliases.set(key(line, productCode), "C-TOK148");
  }
  const remainingAccurate = [...accurateGroups.entries()].filter(([id]) => !principalGroups.has(id));
  const remainingPrincipal = [...principalGroups.entries()].filter(([id]) => !accurateGroups.has(id));
  for (const [principalKey, candidate] of remainingPrincipal) {
    const sameProduct = (line: Aggregate) => line.invoiceNumber === candidate.invoiceNumber &&
      line.accurateProductCode === candidate.accurateProductCode;
    const matches = remainingAccurate.filter(([, line]) => sameProduct(line));
    if (matches.length !== 1 || remainingPrincipal.filter(([, line]) => sameProduct(line)).length !== 1) continue;
    const [, counterpart] = matches[0];
    customerAliases.set(principalKey, counterpart.customerCode);
  }
  const output = reconcileParsedReturns({
    accurateLines,
    matchableAccurateLines: accurate.lines,
    principalLines,
    matchablePrincipalLines: principal.lines,
    invalidAccurateLines: accurate.invalidLines,
    invalidPrincipalLines: principal.invalidLines,
    unmappedPrincipalLines: principal.unmappedLines,
    matchingProductCode: (line) => line.accurateProductCode,
    matchingCustomerCode: (line) => customerAliases.get(key(line, productCode)) ?? line.customerCode,
    isAccurateMapped: () => true,
    dppTolerance,
  });
  // User-confirmed cancellation, scoped to this invoice and cancellation reason.
  const correctionPattern = /^INV\/2610\/HZ01062_INPUT(?:21|24)\/10\/2026_BATAL_DOUBLE\s+NOTA DIK SPV(?: PCH)?$/;
  const headerRows = readRows(headerBuffer, "Sheet1");
  const header = findHeader(headerRows, ["CREDIT_NOTE_NUMBER", "REMARKS", "STATUS"]);
  const leoCancellation = headerRows.slice(header.rowIndex + 1).some(row =>
    text(cell(row, header.columns, "CREDIT_NOTE_NUMBER")) === "CN-025816" &&
    text(cell(row, header.columns, "STATUS")) === "APPROVED" &&
    text(cell(row, header.columns, "REMARKS")) === "INV/2609/HZ02101_INPUT01/10/2026_BATAL_DOUBLE INPUT ACC SPV (SLS) PCH");
  const correctionCns = new Set(headerRows.slice(header.rowIndex + 1)
    .filter(row => text(cell(row, header.columns, "STATUS")) === "APPROVED" &&
      correctionPattern.test(text(cell(row, header.columns, "REMARKS"))))
    .map(row => text(cell(row, header.columns, "CREDIT_NOTE_NUMBER"))));
  const sourceRows = readRows(accurateBuffer, "Rincian Faktur Penjualan");
  const sourceHeader = findHeader(sourceRows, ["NO_NOTA", "REM"]);
  const correctionAccurateRows = new Set<number>();
  sourceRows.forEach((row, index) => {
    if (index > sourceHeader.rowIndex &&
        text(cell(row, sourceHeader.columns, "NO_NOTA")) === "RJN/2610/HZ00333" &&
        correctionPattern.test(text(cell(row, sourceHeader.columns, "REM")))) correctionAccurateRows.add(index + 1);
  });
  const correctionPrincipalRows = new Set(principalLines
    .filter(line => line.invoiceNumber.split(", ").every(cn => correctionCns.has(cn)))
    .map(line => line.sourceRowNumber));
  for (const row of output.results) {
    if (leoCancellation && row.invoiceNumber === "CN-025816" && !row.accurateSourceRows.length &&
        row.status === "INVALID_DATA" && row.invalidReason?.startsWith("Kode pelanggan HEINZ berbeda/ambigu")) {
      output.summary.INVALID_DATA!--;
      row.status = "KOREKSI";
      row.invalidReason = null;
      row.warnings.unshift("Koreksi HEINZ: INV/2609/HZ02101 dibatalkan karena DOUBLE INPUT ACC SPV.");
      output.summary.KOREKSI = (output.summary.KOREKSI ?? 0) + 1;
      continue;
    }
    const hasSources = row.accurateSourceRows.length + row.principalSourceRows.length > 0;
    if (!hasSources || !row.accurateSourceRows.every(n => correctionAccurateRows.has(n)) ||
        !row.principalSourceRows.every(n => correctionPrincipalRows.has(n))) continue;
    if (row.status === "INVALID_DATA" && row.invalidReason !== "REM tidak memuat nomor return HEINZ CN.") continue;
    output.summary[row.status]!--;
    row.status = "KOREKSI";
    row.invalidReason = null;
    row.warnings.unshift("Koreksi pembatalan INV/2610/HZ01062 — DOUBLE NOTA DIK SPV; dikonfirmasi pengguna. Nilai sumber tetap ditampilkan.");
    output.summary.KOREKSI = (output.summary.KOREKSI ?? 0) + 1;
  }
  // User-authorized: differences explicitly marked as cancellations are corrections.
  for (const row of output.results) {
    const verifiedCancellation = row.status === "MATCH" && ["CN-026216", "CN-026366"].includes(row.invoiceNumber);
    if (!verifiedCancellation && !["VALUE_MISMATCH", "QTY_MISMATCH", "QTY_AND_VALUE_MISMATCH"].includes(row.status)) continue;
    const notes = row.accurateSourceRows.map(n => text(cell(sourceRows[n - 1], sourceHeader.columns, "REM")));
    if (!notes.length || !notes.every(note => /(?:^|_)BATAL_/.test(note))) continue;
    output.summary[row.status]!--;
    row.status = "KOREKSI";
    row.warnings.unshift(`Koreksi pembatalan sesuai keterangan Accurate: ${[...new Set(notes)].join("; ")}`);
    output.summary.KOREKSI = (output.summary.KOREKSI ?? 0) + 1;
  }
  // Only unmatched, valid HEINZ lines with an explicit HEADER explanation are not imported.
  const confirmedNotImported = new Set(["CN-026424", "CN-026411", "CN-026085"]);
  const notImported = new Map(headerRows.slice(header.rowIndex + 1)
    .filter(row => (text(cell(row, header.columns, "STATUS")) === "APPROVED" ||
      confirmedNotImported.has(text(cell(row, header.columns, "CREDIT_NOTE_NUMBER")))) &&
      /\bTIDAK\s+IMPOR\b/.test(text(cell(row, header.columns, "REMARKS"))))
    .map(row => [text(cell(row, header.columns, "CREDIT_NOTE_NUMBER")),
      String(cell(row, header.columns, "REMARKS") ?? "").trim()]));
  for (const row of output.results) {
    const cns = row.invoiceNumber.split(", ");
    const confirmedInvalid = row.status === "INVALID_DATA" && cns.every(cn => confirmedNotImported.has(cn)) &&
      /^(Kode pelanggan HEINZ|HEADER Approved tidak ditemukan)/.test(row.invalidReason ?? "");
    if ((row.status !== "MISSING_ACCURATE" && !confirmedInvalid) || row.accurateSourceRows.length ||
        !row.principalSourceRows.length || !cns.every(cn => notImported.has(cn))) continue;
    output.summary[row.status]!--;
    output.summary.TIDAK_IMPOR = (output.summary.TIDAK_IMPOR ?? 0) + 1;
    row.status = "TIDAK_IMPOR";
    const validationNote = row.invalidReason;
    row.invalidReason = null;
    row.warnings = [`Tidak diunggah ke Accurate sesuai remarks HEADER: ${[...new Set(cns.map(cn => notImported.get(cn)))].join("; ")}`];
    if (confirmedInvalid) row.warnings.push(`Dikonfirmasi pengguna sebagai tidak impor. Catatan sumber: ${validationNote}`);
  }
  // User-confirmed motoris rule: linked RSJ/DO returns with zero source values match by qty.
  const motorisRows = new Set(accurate.lines.filter(line => {
    const source = sourceRows[line.sourceRowNumber - 1];
    return /^RSJ\/\d+\/[A-Z0-9]+$/.test(text(cell(source, sourceHeader.columns, "NO_NOTA"))) &&
      /^DO\.\d{4}\.\d{2}\.\d+$/.test(text(cell(source, sourceHeader.columns, "REM"))) &&
      line.dpp === 0 && line.tax === 0 && line.total === 0;
  }).map(line => line.sourceRowNumber));
  for (const row of output.results) {
    if (row.status !== "VALUE_MISMATCH" || row.quantityDifference !== 0 ||
        !row.accurateSourceRows.length || !row.principalSourceRows.length ||
        !row.accurateSourceRows.every(n => motorisRows.has(n))) continue;
    output.summary.VALUE_MISMATCH--;
    output.summary.MATCH++;
    row.status = "MATCH";
    row.warnings = ["MATCH manual HEINZ motoris: produk dan qty sama. Nilai Accurate nol pada retur RSJ/DO; selisih nilai tidak menjadi penentu status. Nilai sumber tetap ditampilkan."];
  }
  for (const row of output.results) {
    const note = combinedMatches.get(row.invoiceNumber);
    if (note && row.status === "MATCH") row.warnings.push(note);
  }
  // Explicit double-input evidence is separate from other cancellation reasons.
  const doubleInput = /(?<![A-Z0-9])DOUBLE[\s_]+(?:INPUT|NOTA)(?![A-Z0-9])/i;
  const doubleInputHeaders = new Map(headerRows.slice(header.rowIndex + 1)
    .filter(row => text(cell(row, header.columns, "STATUS")) === "APPROVED" &&
      doubleInput.test(text(cell(row, header.columns, "REMARKS"))))
    .map(row => [text(cell(row, header.columns, "CREDIT_NOTE_NUMBER")),
      String(cell(row, header.columns, "REMARKS") ?? "").trim()]));
  for (const row of output.results) {
    if (row.status === "INVALID_DATA" || row.status === "UNMAPPED") continue;
    const notes: string[] = [];
    if (row.principalSourceRows.length) {
      const cns = row.invoiceNumber.split(", ");
      if (!cns.every(cn => doubleInputHeaders.has(cn))) continue;
      notes.push(...cns.map(cn => doubleInputHeaders.get(cn)!));
    }
    if (row.accurateSourceRows.length) {
      const accurateNotes = row.accurateSourceRows.map(n =>
        String(cell(sourceRows[n - 1], sourceHeader.columns, "REM") ?? "").trim());
      if (!accurateNotes.every(note => doubleInput.test(note))) continue;
      notes.push(...accurateNotes);
    }
    if (!notes.length) continue;
    output.summary[row.status]!--;
    output.summary.DOUBLE = (output.summary.DOUBLE ?? 0) + 1;
    row.status = "DOUBLE";
    const kinds = [...new Set(notes.flatMap(note => [...note.matchAll(/DOUBLE[\s_]+(INPUT|NOTA)/gi)].map(match => `double ${match[1].toLowerCase()}`)))];
    row.warnings = [`Pembatalan akibat ${kinds.join(" / ")}. Keterangan sumber: ${[...new Set(notes)].join("; ")}`];
  }
  return output;

}

export function reconcileCussonsReturns(
  accurateBuffer: Buffer | Uint8Array,
  principalBuffer: Buffer | Uint8Array,
  mappingBuffer: Buffer | Uint8Array,
  options: { dppTolerance?: number } = {},
): ReturnReconciliationOutput {
  const dppTolerance = options.dppTolerance ?? 1;
  if (!Number.isFinite(dppTolerance) || dppTolerance < 0)
    throw new Error("Toleransi DPP tidak valid");
  const mappings = parseCussonsMappings(mappingBuffer),
    accurate = parseCussonsAccurate(accurateBuffer),
    principal = parseCussonsPrincipal(principalBuffer, mappings),
    accurateLines = [...accurate.lines, ...accurate.invalidLines],
    principalLines = [
      ...principal.lines,
      ...principal.unmappedLines,
      ...principal.invalidLines,
    ];
  // Group linked CN references once; never copy an Accurate quantity to each CN.
  const groups = new Map<string, Set<string>>();
  for (const line of accurateLines) {
    const references = line.invoiceNumber.match(/CN\d+/g) ?? [];
    const merged = new Set(references.flatMap((cn) => [...(groups.get(cn) ?? [cn])]));
    for (const cn of merged) groups.set(cn, merged);
  }
  for (const line of [...accurateLines, ...principalLines]) {
    const group = groups.get(line.invoiceNumber.split(", ")[0]);
    if (group) line.invoiceNumber = [...group].sort().join(", ");
  }
  // Recheck customers across the whole CN group, including invalid source rows.
  const groupedAccurate = separateDuplicateCustomers(
    accurate.lines, accurate.invalidLines, accurateLines,
  );
  const groupedPrincipal = separateDuplicateCustomers(
    principal.lines, principal.invalidLines, principalLines,
  );
  const invalidPrincipalRows = new Set(
    groupedPrincipal.invalidLines.map((line) => line.sourceRowNumber),
  );
  return reconcileParsedReturns({
    accurateLines,
    matchableAccurateLines: groupedAccurate.lines,
    principalLines,
    matchablePrincipalLines: groupedPrincipal.lines,
    invalidAccurateLines: groupedAccurate.invalidLines,
    invalidPrincipalLines: groupedPrincipal.invalidLines,
    unmappedPrincipalLines: principal.unmappedLines.filter(
      (line) => !invalidPrincipalRows.has(line.sourceRowNumber),
    ),
    matchingProductCode: (line) => line.accurateProductCode,
    matchingCustomerCode: () => "",
    isAccurateMapped: () => true,
    dppTolerance,
  });
}
