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

function parseKinoReturnMappings(
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

function parseGodrejMappings(buffer: Buffer | Uint8Array): {
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

function parseHeinzMappings(
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

function godrejAccurateCustomer(value: unknown, row: number): string {
  const customer = text(value),
    suffixed = customer.match(/^(C-[A-Z0-9]+)-GD$/);
  if (suffixed) return suffixed[1];
  if (/^C-[A-Z0-9]+$/.test(customer)) return customer;
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
): CanonicalReturnLine[] {
  const rows = readRows(buffer, "Sheet1"),
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
    lines.push({
      source: "PRINCIPAL",
      sourceRowNumber,
      invoiceNumber: requiredText(
        row,
        header.columns,
        "INVOICE_NO",
        sourceRowNumber,
      ),
      customerCode: requiredText(
        row,
        header.columns,
        "CUSTCODE2",
        sourceRowNumber,
      ),
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
        invoiceNumber: exactlyOneToken(
          cell(row, header.columns, "SALE RETURN NO."),
          /(?<![A-Z0-9])RB\/BFG-\d+(?![A-Z0-9])/g,
          "SALE RETURN NO.",
          sourceRowNumber,
        ),
        customerCode: exactlyOneToken(
          cell(row, header.columns, "CUSTOMER"),
          /(?<![A-Z0-9])C-[A-Z0-9]+(?![A-Z0-9-])/g,
          "CUSTOMER",
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
    const matches =
        text(cell(row, header.columns, "REM")).match(
          /(?<![A-Z0-9])CN-\d+(?![A-Z0-9-])/g,
        ) ?? [],
      line: CanonicalReturnLine = {
        source: "ACCURATE",
        sourceRowNumber,
        invoiceNumber:
          matches.length === 1
            ? matches[0]
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
            : matches.length > 1
              ? "REM memuat lebih dari satu nomor return HEINZ CN."
              : null,
      };
    (matches.length === 1 ? lines : invalidLines).push(line);
  }
  return { lines, invalidLines };
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
      { customerCode: string; lineCount: number }
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
    const customerCode = exactlyOneToken(
      cell(row, header.columns, "RETAILER_NAME"),
      /(?<![A-Z0-9])C-[A-Z0-9]+$/g,
      "retailer_name",
      sourceRowNumber,
    );
    approved.set(creditNote, {
      customerCode,
      lineCount: requiredFinite(
        cell(row, header.columns, "LINE_COUNT"),
        "line_count",
        sourceRowNumber,
      ),
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
      principalProductCode = requiredText(
        row,
        detail.columns,
        "DISTRIBUTOR_STOCK_KEEPING_UNIT",
        sourceRowNumber,
      ),
      accurateProductCode = mappings.get(principalProductCode) ?? null,
      headerRow = approved.get(creditNote),
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
          ? null
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
  for (const [creditNote, creditNoteLines] of grouped) {
    const expected = approved.get(creditNote)!.lineCount;
    if (creditNoteLines.length !== expected) {
      for (const line of creditNoteLines)
        invalidLines.push({
          ...line,
          invalidReason: `line_count ${expected} tidak sama dengan ${creditNoteLines.length} detail untuk ${creditNote}`,
        });
      continue;
    }
    for (const line of creditNoteLines)
      (line.accurateProductCode ? lines : unmappedLines).push(line);
  }
  return { lines, unmappedLines, invalidLines };
}

function key(
  line: CanonicalReturnLine,
  matchingProductCode?: (line: CanonicalReturnLine) => string | null,
): string {
  return `${line.invoiceNumber}|${
    matchingProductCode?.(line) ??
    line.principalProductCode ??
    line.accurateProductCode
  }|${line.customerCode}`;
}

function aggregate(
  lines: CanonicalReturnLine[],
  matchingProductCode?: (line: CanonicalReturnLine) => string | null,
): Map<string, Aggregate> {
  const output = new Map<string, Aggregate>();
  for (const line of lines) {
    const id = key(line, matchingProductCode), existing = output.get(id);
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
  isAccurateMapped?: (line: CanonicalReturnLine) => boolean;
}): ReturnReconciliationOutput {
  const mappedAccurate = aggregate(
      matchableAccurateLines.filter(isAccurateMapped),
      matchingProductCode,
    ),
    principals = aggregate(matchablePrincipalLines, matchingProductCode),
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
  const mappings = parseKinoReturnMappings(mappingBuffer),
    principalLines = parseKinoPrincipal(principalBuffer, mappings),
    parsedAccurate = parseKinoAccurate(accurateBuffer),
    accurateLines = [...parsedAccurate.lines, ...parsedAccurate.invalidLines],
    mappedAccurateCodes = new Set(mappings.values()),
    principalScopes = new Set(
      principalLines.map(
        (line) => `${line.invoiceNumber}|${line.customerCode}`,
      ),
    );
  return reconcileParsedReturns({
    accurateLines,
    matchableAccurateLines: parsedAccurate.lines,
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
    accurateLines = [...accurate.lines, ...accurate.invalidLines],
    principalLines = [...principal.lines, ...principal.unmappedLines];
  return reconcileParsedReturns({
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
    accurate = parseHeinzAccurate(accurateBuffer),
    accurateLines = [...accurate.lines, ...accurate.invalidLines],
    principalLines = [
      ...principal.lines,
      ...principal.unmappedLines,
      ...principal.invalidLines,
    ];
  return reconcileParsedReturns({
    accurateLines,
    matchableAccurateLines: accurate.lines,
    principalLines,
    matchablePrincipalLines: principal.lines,
    invalidAccurateLines: accurate.invalidLines,
    invalidPrincipalLines: principal.invalidLines,
    unmappedPrincipalLines: principal.unmappedLines,
    matchingProductCode: (line) => line.accurateProductCode,
    isAccurateMapped: () => true,
    dppTolerance,
  });
}
