import * as XLSX from "xlsx";
import type {
  CanonicalReturnLine,
  ReturnReconciliationOutput,
  ReturnReconciliationResult,
  ReturnStatus,
} from "./return-reconciliation";

type Row = unknown[];
type Mapping = { code: string; unitsPerCase: number; name: string };
type Mappings = {
  byName: Map<string, Mapping[]>;
  byCode: Map<string, Mapping>;
};
type Aggregate = {
  invoiceNumber: string;
  productCode: string | null;
  principalProductCode: string | null;
  quantity: number;
  dpp: number;
  tax: number;
  total: number;
  sourceRows: number[];
  invalidReason: string | null;
};

const statuses: ReturnStatus[] = [
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
  return String(value ?? "").replace(/\u00a0/g, " ").trim();
}

function normalized(value: unknown): string {
  return text(value)
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/(?:^|\s)(?:\d+\s*)+$/u, "")
    .trim();
}

function number(value: unknown, label: string, row: number): number {
  if (text(value) === "") throw new Error(`${label} kosong pada baris ${row}`);
  const parsed =
    typeof value === "number" ? value : Number(text(value).replace(/,/g, ""));
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`${label} harus angka finite non-negatif pada baris ${row}`);
  return parsed;
}

function rows(buffer: Buffer | Uint8Array, preferredSheet?: string): Row[] {
  if (!buffer?.byteLength) throw new Error("File kosong");
  let book: XLSX.WorkBook;
  try {
    book = XLSX.read(buffer, { type: "buffer", raw: true, cellFormula: false });
  } catch {
    throw new Error("File rusak atau tidak valid");
  }
  const sheetName =
      (preferredSheet && book.Sheets[preferredSheet] && preferredSheet) ||
      book.SheetNames[0],
    sheet = book.Sheets[sheetName];
  if (!sheet?.["!ref"]) throw new Error("Sheet tidak ditemukan atau kosong");
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
  });
}

function table(
  allRows: Row[],
  required: string[],
): { headerRow: number; indexes: Record<string, number> } {
  for (let row = 0; row < allRows.length; row++) {
    const headers = allRows[row].map((value) => text(value));
    if (required.every((header) => headers.includes(header))) {
      const duplicate = required.find(
        (header) => headers.filter((value) => value === header).length > 1,
      );
      if (duplicate) throw new Error(`Header duplikat: ${duplicate}`);
      return {
        headerRow: row,
        indexes: Object.fromEntries(
          required.map((header) => [header, headers.indexOf(header)]),
        ),
      };
    }
  }
  throw new Error(`Header wajib tidak ditemukan: ${required.join(", ")}`);
}

function parseMappings(buffer: Buffer | Uint8Array): Mappings {
  const allRows = rows(buffer, "Form Fix"),
    required = ["Nama Barang Principle", "Kode BARANG Win2", "ISI/CTN"],
    { headerRow, indexes } = table(allRows, required),
    byName = new Map<string, Mapping[]>(),
    byCode = new Map<string, Mapping>();
  for (let index = headerRow + 1; index < allRows.length; index++) {
    const row = allRows[index],
      name = normalized(row[indexes["Nama Barang Principle"]]),
      code = text(row[indexes["Kode BARANG Win2"]]).toUpperCase(),
      rawUnits = row[indexes["ISI/CTN"]];
    if (!name && !code && text(rawUnits) === "") continue;
    if (!name || !code || text(rawUnits) === "")
      throw new Error(`Mapping parsial pada baris ${index + 1}`);
    const unitsPerCase = number(rawUnits, "ISI/CTN", index + 1);
    if (!unitsPerCase)
      throw new Error(`ISI/CTN harus lebih dari nol pada baris ${index + 1}`);
    const mapping = { code, unitsPerCase, name },
      named = byName.get(name) ?? [];
    if (!named.some((item) => item.code === code)) named.push(mapping);
    byName.set(name, named);
    byCode.set(code, mapping);
  }
  return { byName, byCode };
}

function parseAccurate(
  buffer: Buffer | Uint8Array,
  mappings: Mappings,
): CanonicalReturnLine[] {
  const allRows = rows(buffer, "Rincian Faktur Pembelian"),
    required = [
      "NO. PEMBELIAN",
      "KODE BARANG",
      "QTY",
      "SATUAN",
      "DPP",
      "REM",
    ],
    { headerRow, indexes } = table(allRows, required),
    lines: CanonicalReturnLine[] = [];
  for (let index = headerRow + 1; index < allRows.length; index++) {
    const row = allRows[index];
    if (row.every((value) => text(value) === "")) continue;
    const sourceRowNumber = index + 1,
      cases = number(row[indexes.QTY], "QTY", sourceRowNumber),
      unit = text(row[indexes.SATUAN]).toUpperCase(),
      dpp = number(row[indexes.DPP], "DPP", sourceRowNumber),
      productCode = text(row[indexes["KODE BARANG"]]).toUpperCase(),
      mapping = mappings.byCode.get(productCode),
      invoices = [
        ...text(row[indexes.REM]).matchAll(/\bDMS\s+Bill\s+(\d+)\b/gi),
      ].map((match) => match[1]),
      invalidReason =
        invoices.length === 1
          ? null
          : `REM harus memuat tepat satu DMS Bill pada baris ${sourceRowNumber}`;
    if (unit !== "KRT")
      throw new Error(`SATUAN harus KRT pada baris ${sourceRowNumber}`);
    if (!mapping)
      throw new Error(
        `KODE BARANG tidak ada di mapping pada baris ${sourceRowNumber}: ${productCode}`,
      );
    lines.push({
      source: "ACCURATE",
      sourceRowNumber,
      invoiceNumber:
        invoices.length === 1
          ? invoices[0]
          : text(row[indexes["NO. PEMBELIAN"]]).toUpperCase(),
      customerCode: "",
      accurateProductCode: productCode,
      principalProductCode: null,
      quantity: cases * mapping.unitsPerCase,
      dpp,
      tax: dpp * 0.11,
      total: dpp * 1.11,
      invalidReason,
    });
  }
  return lines;
}

function parsePrincipal(
  buffer: Buffer | Uint8Array,
  mappings: Mappings,
): CanonicalReturnLine[] {
  const allRows = rows(buffer),
    required = [
      "Invoice_Number",
      "Bill_No",
      "Approved",
      "Amount_Uploaded",
      "Quantity_in_Units",
      "Quantity_Uploaded",
      "Qty_Approved",
      "Sku_Name",
    ],
    { headerRow, indexes } = table(allRows, required),
    lines: CanonicalReturnLine[] = [];
  for (let index = headerRow + 1; index < allRows.length; index++) {
    const row = allRows[index];
    if (row.every((value) => text(value) === "")) continue;
    if (text(row[indexes.Approved]).toUpperCase() !== "APPROVED") continue;
    const sourceRowNumber = index + 1,
      invoice = text(row[indexes.Invoice_Number]),
      bill = text(row[indexes.Bill_No]);
    if (!invoice || invoice !== bill)
      throw new Error(
        `Invoice_Number dan Bill_No tidak konsisten pada baris ${sourceRowNumber}`,
      );
    const approved = number(
        row[indexes.Qty_Approved],
        "Qty_Approved",
        sourceRowNumber,
      ),
      inUnits = number(
        row[indexes.Quantity_in_Units],
        "Quantity_in_Units",
        sourceRowNumber,
      ),
      uploaded = number(
        row[indexes.Quantity_Uploaded],
        "Quantity_Uploaded",
        sourceRowNumber,
      );
    if (approved !== inUnits || approved !== uploaded)
      throw new Error(`Kuantitas tidak konsisten pada baris ${sourceRowNumber}`);
    const total = number(
        row[indexes.Amount_Uploaded],
        "Amount_Uploaded",
        sourceRowNumber,
      ),
      name = normalized(row[indexes.Sku_Name]),
      namedMappings = mappings.byName.get(name) ?? [],
      dpp = total / 1.11;
    const mapping = namedMappings.length === 1 ? namedMappings[0] : undefined,
      invalidReason =
        namedMappings.length > 1
          ? `Mapping nama ambigu ${name}: ${namedMappings.map((item) => item.code).join(", ")}`
          : mapping
            ? null
            : `Produk tidak terpetakan: ${name}`;
    lines.push({
      source: "PRINCIPAL",
      sourceRowNumber,
      invoiceNumber: invoice,
      customerCode: "",
      accurateProductCode: mapping?.code ?? null,
      principalProductCode: name || null,
      quantity: approved,
      dpp,
      tax: total - dpp,
      total,
      invalidReason,
    });
  }
  return lines;
}

function aggregate(lines: CanonicalReturnLine[]): Map<string, Aggregate> {
  const output = new Map<string, Aggregate>();
  for (const line of lines) {
    const key = `${line.invoiceNumber}|${line.accurateProductCode ?? line.principalProductCode ?? ""}`,
      current = output.get(key) ?? {
        invoiceNumber: line.invoiceNumber,
        productCode: line.accurateProductCode,
        principalProductCode: line.principalProductCode,
        quantity: 0,
        dpp: 0,
        tax: 0,
        total: 0,
        sourceRows: [],
        invalidReason: line.invalidReason ?? null,
      };
    current.quantity += line.quantity;
    current.dpp += line.dpp;
    current.tax += line.tax;
    current.total += line.total;
    current.sourceRows.push(line.sourceRowNumber);
    output.set(key, current);
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
    customerCode: "",
    accurateProductCode: accurate?.productCode ?? principal?.productCode ?? null,
    principalProductCode:
      principal?.principalProductCode ??
      accurate?.principalProductCode ??
      null,
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
    invalidReason: source.invalidReason,
    warnings:
      status === "MATCH"
        ? []
        : [source.invalidReason ?? status.replaceAll("_", " ")],
    accurateSourceRows: accurate?.sourceRows ?? [],
    principalSourceRows: principal?.sourceRows ?? [],
  };
}

function reconcile(
  accurateLines: CanonicalReturnLine[],
  principalLines: CanonicalReturnLine[],
  dppTolerance: number,
): ReturnReconciliationOutput {
  const accurate = aggregate(
      accurateLines.filter((line) => !line.invalidReason),
    ),
    principal = aggregate(
      principalLines.filter(
        (line) => line.accurateProductCode && !line.invalidReason,
      ),
    ),
    results: ReturnReconciliationResult[] = [];

  for (const line of accurateLines.filter((item) => item.invalidReason))
    results.push(
      result(
        {
          invoiceNumber: line.invoiceNumber,
          productCode: line.accurateProductCode,
          principalProductCode: null,
          quantity: line.quantity,
          dpp: line.dpp,
          tax: line.tax,
          total: line.total,
          sourceRows: [line.sourceRowNumber],
          invalidReason: line.invalidReason ?? null,
        },
        undefined,
        "INVALID_DATA",
      ),
    );
  for (const invalid of aggregate(
    principalLines.filter((line) => line.invalidReason?.startsWith("Mapping nama ambigu")),
  ).values())
    results.push(result(undefined, invalid, "INVALID_DATA"));
  for (const unmapped of aggregate(
    principalLines.filter(
      (line) =>
        !line.accurateProductCode &&
        !line.invalidReason?.startsWith("Mapping nama ambigu"),
    ),
  ).values())
    results.push(result(undefined, unmapped, "UNMAPPED"));

  for (const [key, accurateRow] of accurate) {
    const principalRow = principal.get(key);
    if (!principalRow) {
      results.push(result(accurateRow, undefined, "MISSING_PRINCIPAL"));
      continue;
    }
    principal.delete(key);
    const quantityMismatch = accurateRow.quantity !== principalRow.quantity,
      valueMismatch =
        Math.abs(accurateRow.dpp - principalRow.dpp) > dppTolerance + 1e-9;
    results.push(
      result(
        accurateRow,
        principalRow,
        quantityMismatch
          ? valueMismatch
            ? "QTY_AND_VALUE_MISMATCH"
            : "QTY_MISMATCH"
          : valueMismatch
            ? "VALUE_MISMATCH"
            : "MATCH",
      ),
    );
  }
  for (const principalRow of principal.values())
    results.push(result(undefined, principalRow, "MISSING_ACCURATE"));

  const summary = Object.fromEntries(
    statuses.map((status) => [status, 0]),
  ) as Record<ReturnStatus, number>;
  for (const row of results) summary[row.status]++;
  return { accurateLines, principalLines, results, summary };
}

export function reconcileGodrejPurchases(
  accurateBuffer: Buffer | Uint8Array,
  principalBuffer: Buffer | Uint8Array,
  mappingBuffer: Buffer | Uint8Array,
  options: { dppTolerance?: number } = {},
): ReturnReconciliationOutput {
  const dppTolerance = options.dppTolerance ?? 1;
  if (!Number.isFinite(dppTolerance) || dppTolerance < 0)
    throw new Error("Toleransi DPP tidak valid");
  const mappings = parseMappings(mappingBuffer),
    accurateLines = parseAccurate(accurateBuffer, mappings),
    principalLines = parsePrincipal(principalBuffer, mappings);
  return reconcile(accurateLines, principalLines, dppTolerance);
}
