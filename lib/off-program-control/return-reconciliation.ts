import * as XLSX from "xlsx";

export type ReturnStatus =
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
  accurateProductCode: string | null;
  principalProductCode: string | null;
  quantity: number;
  dpp: number;
  tax: number;
  total: number;
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
  warnings: string[];
  accurateSourceRows: number[];
  principalSourceRows: number[];
}

export interface ReturnReconciliationOutput {
  accurateLines: CanonicalReturnLine[];
  principalLines: CanonicalReturnLine[];
  results: ReturnReconciliationResult[];
  summary: Record<ReturnStatus, number>;
}

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

function readRows(buffer: Buffer | Uint8Array, sheetName: string): Row[] {
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
    blankrows: false,
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

function parseMappings(buffer: Buffer | Uint8Array): Map<string, string[]> {
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

function key(line: CanonicalReturnLine): string {
  return `${line.invoiceNumber}|${line.principalProductCode ?? line.accurateProductCode}|${line.customerCode}`;
}

function aggregate(lines: CanonicalReturnLine[]): Map<string, Aggregate> {
  const output = new Map<string, Aggregate>();
  for (const line of lines) {
    const id = key(line), existing = output.get(id);
    if (existing) {
      existing.quantity += line.quantity;
      existing.dpp += line.dpp;
      existing.tax += line.tax;
      existing.total += line.total;
      existing.sourceRows.push(line.sourceRowNumber);
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
    warnings: status === "MATCH" ? [] : [status.replaceAll("_", " ")],
    accurateSourceRows: accurate?.sourceRows ?? [],
    principalSourceRows: principal?.sourceRows ?? [],
  };
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
    accurateLines = parseAccurate(accurateBuffer, mappings, principalLines),
    mappedAccurate = aggregate(
      accurateLines.filter((line) => line.principalProductCode !== null),
    ),
    principals = aggregate(principalLines),
    results: ReturnReconciliationResult[] = [];

  for (const unmapped of aggregate(
    accurateLines.filter((entry) => entry.principalProductCode === null),
  ).values())
    results.push(result(unmapped, undefined, "UNMAPPED"));

  for (const [id, accurate] of mappedAccurate) {
    const principal = principals.get(id);
    if (!principal) {
      results.push(result(accurate, undefined, "MISSING_PRINCIPAL"));
      continue;
    }
    principals.delete(id);
    const quantityMismatch = accurate.quantity !== principal.quantity,
      valueMismatch = Math.abs(accurate.dpp - principal.dpp) > dppTolerance,
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

  const summary = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<ReturnStatus, number>;
  for (const row of results) summary[row.status]++;
  return { accurateLines, principalLines, results, summary };
}
