import * as XLSX from "xlsx";
import type {
  CanonicalReturnLine,
  ReturnReconciliationOutput,
  ReturnReconciliationResult,
  ReturnStatus,
} from "./return-reconciliation.ts";
import {
  parseCussonsMappings,
  type CussonsMappings,
} from "./sales-reconciliation.ts";

type Row = unknown[];
type Mapping = {
  code: string;
  unitsPerCase: number;
  name: string;
  invalidReason?: string;
};
type Mappings = {
  byName: Map<string, Mapping[]>;
  byCode: Map<string, Mapping>;
};
type ReckittMappings = {
  byPrincipalCode: Map<string, Mapping[]>;
  byWinCode: Map<string, Mapping>;
};
type KinoPurchaseMapping = {
  code: string;
  principalCode: string;
  unitsPerCase: number;
};
type KinoPurchaseMappings = {
  byWinCode: Map<string, KinoPurchaseMapping>;
  byPrincipalCode: Map<string, KinoPurchaseMapping[]>;
};
type ForisaMapping = {
  code: string;
  principalCode: string;
  name: string;
};
type ForisaMappings = {
  byWinCode: Map<string, ForisaMapping[]>;
  byPrincipalCode: Map<string, ForisaMapping[]>;
  byExactName: Map<string, ForisaMapping[]>;
  byLooseName: Map<string, ForisaMapping[]>;
};
type CodeMappedPurchaseOptions = {
  accurateInvoicePattern: RegExp;
  accurateInvoiceLabel: string;
  principalInvoicePattern: RegExp;
  allowedUoms: string[];
  allowedUomsLabel: string;
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
const reckittOptions: CodeMappedPurchaseOptions = {
  accurateInvoicePattern: /\b210\d{7}\b/g,
  accurateInvoiceLabel: "nomor 210",
  principalInvoicePattern: /^210\d{7}$/,
  allowedUoms: ["CAR", "PAC"],
  allowedUomsLabel: "CAR atau PAC",
};
const cussonsOptions: CodeMappedPurchaseOptions = {
  accurateInvoicePattern: /\b1\d{8}\b/g,
  accurateInvoiceLabel: "nomor invoice CUSSONS",
  principalInvoicePattern: /^1\d{8}$/,
  allowedUoms: ["CS"],
  allowedUomsLabel: "CS",
};
const kinoPurchasePrincipalDppDivisor = 1.0989;

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

function optionalNumber(value: unknown, label: string, row: number): number {
  return text(value) === "" ? 0 : number(value, label, row);
}

function rows(buffer: Buffer | Uint8Array, preferredSheet?: string): Row[] {
  if (!buffer?.byteLength) throw new Error("File kosong");
  let book: XLSX.WorkBook;
  try {
    book = XLSX.read(buffer, {
      type: "buffer",
      raw: true,
      cellFormula: false,
      ...(Buffer.from(buffer).subarray(0, 200).includes(124)
        ? { FS: "|" }
        : {}),
    });
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
    unitsByCode = new Map<string, number>(),
    byName = new Map<string, Mapping[]>(),
    byCode = new Map<string, Mapping>();
  for (let index = headerRow + 1; index < allRows.length; index++) {
    const row = allRows[index],
      name = normalized(row[indexes["Nama Barang Principle"]]);
    if (!name) continue;
    const code = text(row[indexes["Kode BARANG Win2"]]).toUpperCase(),
      rawUnits = row[indexes["ISI/CTN"]];
    if (!code) throw new Error(`Mapping parsial pada baris ${index + 1}`);
    if (text(rawUnits) === "") continue;
    const units = number(rawUnits, "ISI/CTN", index + 1),
      existing = unitsByCode.get(code);
    if (!units)
      throw new Error(`ISI/CTN harus lebih dari nol pada baris ${index + 1}`);
    if (existing && existing !== units)
      throw new Error(`ISI/CTN ambigu untuk ${code}: ${existing}, ${units}`);
    unitsByCode.set(code, units);
  }
  for (let index = headerRow + 1; index < allRows.length; index++) {
    const row = allRows[index],
      name = normalized(row[indexes["Nama Barang Principle"]]),
      code = text(row[indexes["Kode BARANG Win2"]]).toUpperCase(),
      unitsPerCase = unitsByCode.get(code);
    if (!name) continue;
    if (!code || !unitsPerCase)
      throw new Error(`Mapping parsial pada baris ${index + 1}`);
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
      "Quantity_in_Cases",
      "Quantity_Uploaded",
      "Qty_Approved",
      "Sku_Name",
    ],
    { headerRow, indexes } = table(allRows, required),
    lines: CanonicalReturnLine[] = [];
  for (let index = headerRow + 1; index < allRows.length; index++) {
    const row = allRows[index];
    if (row.every((value) => text(value) === "")) continue;
    const sourceRowNumber = index + 1,
      invoice = text(row[indexes.Invoice_Number]),
      bill = text(row[indexes.Bill_No]),
      name = normalized(row[indexes.Sku_Name]),
      namedMappings = mappings.byName.get(name) ?? [];
    const mapping = namedMappings.length === 1 ? namedMappings[0] : undefined,
      mappingReason =
        namedMappings.length > 1
          ? `Mapping nama ambigu ${name}: ${namedMappings.map((item) => item.code).join(", ")}`
          : mapping
            ? null
            : `Produk tidak terpetakan: ${name}`;
    let approved = 0,
      total = 0,
      invalidReason =
        text(row[indexes.Approved]).toUpperCase() !== "APPROVED"
          ? `Status GRN harus Approved pada baris ${sourceRowNumber}`
          : !invoice || invoice !== bill
            ? `Invoice_Number dan Bill_No tidak konsisten pada baris ${sourceRowNumber}`
            : mappingReason;
    try {
      approved = number(row[indexes.Qty_Approved], "Qty_Approved", sourceRowNumber);
      const inUnits = number(row[indexes.Quantity_in_Units], "Quantity_in_Units", sourceRowNumber),
        inCases = number(row[indexes.Quantity_in_Cases], "Quantity_in_Cases", sourceRowNumber),
        uploaded = number(row[indexes.Quantity_Uploaded], "Quantity_Uploaded", sourceRowNumber);
      total = number(row[indexes.Amount_Uploaded], "Amount_Uploaded", sourceRowNumber);
      if (!invalidReason && mapping && Math.abs(inCases * mapping.unitsPerCase - approved) > 1e-9)
        invalidReason = `Quantity_in_Cases × ISI/CTN tidak konsisten pada baris ${sourceRowNumber}`;
      else if (!invalidReason && (approved !== inUnits || approved !== uploaded))
        invalidReason = `Quantity_in_Units, Quantity_Uploaded, dan Qty_Approved tidak konsisten pada baris ${sourceRowNumber}`;
    } catch (error) {
      if (!invalidReason)
        invalidReason = error instanceof Error ? error.message : `Kuantitas tidak konsisten pada baris ${sourceRowNumber}`;
    }
    const dpp = total / 1.11;
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

function parseReckittMappings(buffer: Buffer | Uint8Array): ReckittMappings {
  const allRows = rows(buffer, "Pvt Map 1"),
    required = ["Kode BARANG Win2", "Kode Pcpl", "ISI/CTN"],
    { headerRow, indexes } = table(allRows, required),
    unitsByWinCode = new Map<string, number>(),
    byPrincipalCode = new Map<string, Mapping[]>(),
    byWinCode = new Map<string, Mapping>();
  for (let index = headerRow + 1; index < allRows.length; index++) {
    const row = allRows[index],
      code = text(row[indexes["Kode BARANG Win2"]]).toUpperCase(),
      rawUnits = row[indexes["ISI/CTN"]];
    if (!code || !rawUnits || text(rawUnits).toUpperCase() === "(BLANK)") continue;
    const units = number(rawUnits, "ISI/CTN", index + 1);
    if (!units)
      throw new Error(`ISI/CTN harus lebih dari nol pada baris ${index + 1}`);
    if (!unitsByWinCode.has(code)) unitsByWinCode.set(code, units);
  }
  for (let index = headerRow + 1; index < allRows.length; index++) {
    const row = allRows[index],
      code = text(row[indexes["Kode BARANG Win2"]]).toUpperCase(),
      principalCode = text(row[indexes["Kode Pcpl"]]).toUpperCase();
    if (!code && !principalCode) continue;
    if (!code || !principalCode)
      throw new Error(`Mapping parsial pada baris ${index + 1}`);
    const rawUnits = row[indexes["ISI/CTN"]],
      unitsPerCase =
        rawUnits && text(rawUnits).toUpperCase() !== "(BLANK)"
          ? number(rawUnits, "ISI/CTN", index + 1)
          : unitsByWinCode.get(code);
    if (!unitsPerCase)
      throw new Error(`Mapping parsial pada baris ${index + 1}`);
    const mapping = { code, unitsPerCase, name: principalCode },
      principalMappings = byPrincipalCode.get(principalCode) ?? [];
    if (!principalMappings.some((item) => item.code === code))
      principalMappings.push(mapping);
    byPrincipalCode.set(principalCode, principalMappings);
    byWinCode.set(code, mapping);
  }
  return { byPrincipalCode, byWinCode };
}

function parseKinoPurchaseMappings(buffer: Buffer | Uint8Array): KinoPurchaseMappings {
  const allRows = rows(buffer, "Table Pvt 1"),
    required = ["Kode Barang Win", "Kode Pcpl", "ISI/CTN"],
    { headerRow, indexes } = table(allRows, required),
    byWinCode = new Map<string, KinoPurchaseMapping>(),
    byPrincipalCode = new Map<string, KinoPurchaseMapping[]>();
  for (let index = headerRow + 1; index < allRows.length; index++) {
    const row = allRows[index],
      code = text(row[indexes["Kode Barang Win"]]).toUpperCase(),
      principalCode = text(row[indexes["Kode Pcpl"]]).toUpperCase();
    if (!code || !principalCode) continue;
    const unitsPerCase = number(row[indexes["ISI/CTN"]], "ISI/CTN", index + 1);
    if (!unitsPerCase)
      throw new Error(`ISI/CTN harus lebih dari nol pada baris ${index + 1}`);
    const mapping = { code, principalCode, unitsPerCase },
      principalMappings = byPrincipalCode.get(principalCode) ?? [];
    if (!principalMappings.some((item) => item.code === code))
      principalMappings.push(mapping);
    byPrincipalCode.set(principalCode, principalMappings);
    byWinCode.set(code, mapping);
  }
  return { byWinCode, byPrincipalCode };
}

function parseKinoPurchaseDocument(value: unknown, row: number) {
  const rem = text(value),
    order = /No\.\s*Order:\s*([^\s|]+)/i.exec(rem)?.[1] ??
      /\b(1671-PRO-\d+)\b/i.exec(rem)?.[1],
    sj = /No\.\s*SJ:\s*(\d+)/i.exec(rem)?.[1] ??
      /\((\d+)\)/.exec(rem)?.[1];
  if (!order || !sj)
    throw new Error(`REM harus memuat No. SJ dan No. Order pada baris ${row}`);
  return { invoiceNumber: `${order}|${sj}`, order, sj };
}

function parseKinoPurchaseAccurate(
  buffer: Buffer | Uint8Array,
  mappings: KinoPurchaseMappings,
): CanonicalReturnLine[] {
  const allRows = rows(buffer, "Rincian Faktur Pembelian"),
    required = ["NO. PEMBELIAN", "KODE BARANG", "QTY", "SATUAN", "DPP", "PPN", "REM"],
    { headerRow, indexes } = table(allRows, required),
    lines: CanonicalReturnLine[] = [];
  for (let index = headerRow + 1; index < allRows.length; index++) {
    const row = allRows[index];
    if (row.every((value) => text(value) === "")) continue;
    const sourceRowNumber = index + 1,
      productCode = text(row[indexes["KODE BARANG"]]).toUpperCase(),
      mapping = mappings.byWinCode.get(productCode),
      quantity = number(row[indexes.QTY], "QTY", sourceRowNumber),
      dpp = number(row[indexes.DPP], "DPP", sourceRowNumber),
      tax = number(row[indexes.PPN], "PPN", sourceRowNumber);
    let invalidReason: string | null = null,
      invoiceNumber = text(row[indexes["NO. PEMBELIAN"]]).toUpperCase();
    try {
      invoiceNumber = parseKinoPurchaseDocument(row[indexes.REM], sourceRowNumber).invoiceNumber;
    } catch (error) {
      invalidReason = error instanceof Error ? error.message : `REM tidak valid pada baris ${sourceRowNumber}`;
    }
    if (!invalidReason && text(row[indexes.SATUAN]).toUpperCase() !== "KRT")
      invalidReason = `SATUAN harus KRT pada baris ${sourceRowNumber}`;
    if (!invalidReason && !mapping)
      invalidReason = `KODE BARANG tidak ada di mapping KINO Purchase pada baris ${sourceRowNumber}: ${productCode}`;
    lines.push({
      source: "ACCURATE",
      sourceRowNumber,
      invoiceNumber,
      customerCode: "",
      accurateProductCode: productCode || null,
      principalProductCode: mapping?.principalCode ?? null,
      quantity: mapping ? quantity * mapping.unitsPerCase : quantity,
      dpp,
      tax,
      total: dpp + tax,
      invalidReason,
    });
  }
  return lines;
}

function parseKinoPurchasePrincipal(
  buffer: Buffer | Uint8Array,
  mappings: KinoPurchaseMappings,
): CanonicalReturnLine[] {
  const allRows = rows(buffer),
    required = ["No. Order", "No. SJ", "No. Item", "Kirim", "Price", "Total"],
    { headerRow, indexes } = table(allRows, required),
    lines: CanonicalReturnLine[] = [];
  for (let index = headerRow + 1; index < allRows.length; index++) {
    const row = allRows[index];
    if (row.every((value) => text(value) === "")) continue;
    const sourceRowNumber = index + 1,
      order = text(row[indexes["No. Order"]]),
      sj = text(row[indexes["No. SJ"]]),
      principalCode = text(row[indexes["No. Item"]]).toUpperCase(),
      namedMappings = mappings.byPrincipalCode.get(principalCode) ?? [],
      mapping = namedMappings.length === 1 ? namedMappings[0] : undefined;
    let quantity = 0,
      total = 0,
      invalidReason =
        !order || !sj
          ? `No. Order dan No. SJ wajib pada baris ${sourceRowNumber}`
          : namedMappings.length > 1
            ? `Mapping KINO Purchase ambigu ${principalCode}: ${namedMappings.map((item) => item.code).join(", ")}`
            : mapping
              ? null
              : `Produk tidak terpetakan: ${principalCode}`;
    try {
      quantity = number(row[indexes.Kirim], "Kirim", sourceRowNumber);
      number(row[indexes.Price], "Price", sourceRowNumber);
      total = number(row[indexes.Total], "Total", sourceRowNumber);
    } catch (error) {
      if (!invalidReason)
        invalidReason = error instanceof Error ? error.message : `Data KINO Purchase tidak valid pada baris ${sourceRowNumber}`;
    }
    const dpp = total / kinoPurchasePrincipalDppDivisor,
      tax = total - dpp;
    lines.push({
      source: "PRINCIPAL",
      sourceRowNumber,
      invoiceNumber: `${order}|${sj}`,
      customerCode: "",
      accurateProductCode: mapping?.code ?? null,
      principalProductCode: principalCode || null,
      quantity,
      dpp,
      tax,
      total,
      invalidReason,
    });
  }
  return lines;
}

export function reconcileKinoPurchases(
  accurateBuffer: Buffer | Uint8Array,
  principalBuffer: Buffer | Uint8Array,
  mappingBuffer: Buffer | Uint8Array,
  options: { dppTolerance?: number } = {},
): ReturnReconciliationOutput {
  const dppTolerance = options.dppTolerance ?? 250;
  if (!Number.isFinite(dppTolerance) || dppTolerance < 0)
    throw new Error("Toleransi DPP tidak valid");
  const mappings = parseKinoPurchaseMappings(mappingBuffer);
  return reconcile(
    parseKinoPurchaseAccurate(accurateBuffer, mappings),
    parseKinoPurchasePrincipal(principalBuffer, mappings),
    dppTolerance,
  );
}

function forisaName(value: unknown, loose = false): string {
  const aliases: Record<string, string[]> = {
    COKLAT: ["CHOCOLATE"],
    CKLT: ["CHOCO"],
    BISKUIT: ["BISCUIT"],
    CAPCINO: ["CAPPUCINO"],
    VANILALATTE: ["VANILLA", "LATTE"],
    AVOCADO: ["ALPUKAT"],
    MANGO: ["MANGGA"],
  };
  return normalized(value)
    .split(" ")
    .flatMap((token) => aliases[token] ?? [token])
    .filter(
      (token) =>
        token &&
        !["FS", "MT", "X", "REG", "RENCENG"].includes(token) &&
        !/^(?:PI|TI|TS)\d+$/.test(token) &&
        (!loose ||
          (!["ES", "L"].includes(token) &&
            !/^(?:\d+(?:GR|G|PCS|PCH|ML)?|(?:PCS|PCH)X\d+(?:GR|G|ML)|GR|G|PCS|PCH|ML)$/.test(token))),
    )
    .join(" ");
}

function addForisaMapping(
  map: Map<string, ForisaMapping[]>,
  key: string,
  mapping: ForisaMapping,
) {
  const values = map.get(key) ?? [];
  if (!values.some((value) => value.code === mapping.code && value.principalCode === mapping.principalCode))
    values.push(mapping);
  map.set(key, values);
}

function parseForisaMappings(buffer: Buffer | Uint8Array): ForisaMappings {
  const allRows = rows(buffer, "Upload To Win"),
    required = ["Kode Pcpl", "Kode BARANG Win2", "Nama Win", "ISI/CTN"],
    { headerRow, indexes } = table(allRows, required),
    mappings: ForisaMappings = {
      byWinCode: new Map(),
      byPrincipalCode: new Map(),
      byExactName: new Map(),
      byLooseName: new Map(),
    };
  for (let index = headerRow + 1; index < allRows.length; index++) {
    const row = allRows[index],
      principalCode = text(row[indexes["Kode Pcpl"]]).toUpperCase(),
      code = text(row[indexes["Kode BARANG Win2"]]).toUpperCase(),
      name = text(row[indexes["Nama Win"]]);
    if (!principalCode && !code && !name) continue;
    if (!principalCode || !code || !name)
      throw new Error(`Mapping FORISA tidak lengkap pada baris ${index + 1}`);
    const units = number(row[indexes["ISI/CTN"]], "ISI/CTN", index + 1);
    if (!units) throw new Error(`ISI/CTN harus lebih dari nol pada baris ${index + 1}`);
    const mapping = { principalCode, code, name },
      exactName = forisaName(name),
      looseName = forisaName(name, true);
    addForisaMapping(mappings.byWinCode, code, mapping);
    addForisaMapping(mappings.byPrincipalCode, principalCode, mapping);
    addForisaMapping(mappings.byExactName, exactName, mapping);
    addForisaMapping(mappings.byLooseName, looseName, mapping);
  }
  return mappings;
}

function uniqueForisaMapping(
  candidates: ForisaMapping[],
  label: string,
): { mapping?: ForisaMapping; invalidReason?: string } {
  return candidates.length === 1
    ? { mapping: candidates[0] }
    : candidates.length > 1
      ? { invalidReason: `Mapping FORISA ambigu untuk ${label}` }
      : {};
}

function resolveForisaAccurate(
  productCode: string,
  productName: string,
  mappings: ForisaMappings,
) {
  const direct = uniqueForisaMapping(mappings.byWinCode.get(productCode) ?? [], productCode);
  if (direct.mapping || direct.invalidReason) return direct;
  const exactName = forisaName(productName),
    exact = uniqueForisaMapping(mappings.byExactName.get(exactName) ?? [], productName);
  if (exact.mapping || exact.invalidReason) return exact;
  const looseName = forisaName(productName, true),
    loose = uniqueForisaMapping(mappings.byLooseName.get(looseName) ?? [], productName);
  return loose.mapping || loose.invalidReason
    ? loose
    : { invalidReason: `Produk Accurate tidak terpetakan: ${productCode || productName}` };
}

function forisaDocumentNumber(filename: string): string {
  const matches = filename.match(/\b401\d{7}\b/g) ?? [];
  if (matches.length !== 1)
    throw new Error("Nama file principal harus memuat tepat satu nomor DO FORISA (format 401 + 7 digit)");
  return matches[0];
}

function parseForisaAccurate(
  buffer: Buffer | Uint8Array,
  mappings: ForisaMappings,
  documentNumber: string,
): { lines: CanonicalReturnLine[]; actualCodes: Map<string, Set<string>> } {
  const allRows = rows(buffer, "Rincian Faktur Pembelian"),
    required = ["NO. PEMBELIAN", "KODE BARANG", "NAMA BARANG", "QTY", "SATUAN", "DPP", "PPN", "REM"],
    { headerRow, indexes } = table(allRows, required),
    lines: CanonicalReturnLine[] = [],
    actualCodes = new Map<string, Set<string>>();
  for (let index = headerRow + 1; index < allRows.length; index++) {
    const row = allRows[index];
    if (row.every((value) => text(value) === "")) continue;
    const remDocuments: string[] = text(row[indexes.REM]).match(/\b401\d{7}\b/g) ?? [];
    if (!remDocuments.includes(documentNumber)) continue;
    const sourceRowNumber = index + 1,
      productCode = text(row[indexes["KODE BARANG"]]).toUpperCase(),
      productName = text(row[indexes["NAMA BARANG"]]),
      resolved = resolveForisaAccurate(productCode, productName, mappings),
      quantity = number(row[indexes.QTY], "QTY", sourceRowNumber),
      dpp = number(row[indexes.DPP], "DPP", sourceRowNumber);
    number(row[indexes.PPN], "PPN", sourceRowNumber);
    let invalidReason =
      remDocuments.length === 1
        ? (resolved.invalidReason ?? null)
        : `REM harus memuat tepat satu nomor DO FORISA pada baris ${sourceRowNumber}`;
    if (!invalidReason && text(row[indexes.SATUAN]).toUpperCase() !== "KRT")
      invalidReason = `SATUAN harus KRT pada baris ${sourceRowNumber}`;
    if (resolved.mapping) {
      const codes = actualCodes.get(resolved.mapping.principalCode) ?? new Set<string>();
      codes.add(productCode);
      actualCodes.set(resolved.mapping.principalCode, codes);
    }
    const tax = Math.round(dpp * 0.11);
    lines.push({
      source: "ACCURATE",
      sourceRowNumber,
      invoiceNumber: documentNumber,
      customerCode: "",
      accurateProductCode: productCode || null,
      principalProductCode: resolved.mapping?.principalCode ?? null,
      quantity,
      dpp,
      tax,
      total: dpp + tax,
      invalidReason,
    });
  }
  return { lines, actualCodes };
}

function parseForisaPrincipal(
  buffer: Buffer | Uint8Array,
  mappings: ForisaMappings,
  documentNumber: string,
  actualCodes: Map<string, Set<string>>,
): CanonicalReturnLine[] {
  const allRows = rows(buffer),
    required = ["Product Code", "Product Name", "Brand Name", "Qty (CB)", "Price", "Amount", "Discount", "Amount After Discount", "PPN", "Total Amount"],
    { headerRow, indexes } = table(allRows, required),
    lines: CanonicalReturnLine[] = [];
  for (let index = headerRow + 1; index < allRows.length; index++) {
    const row = allRows[index];
    if (row.every((value) => text(value) === "")) continue;
    const sourceRowNumber = index + 1,
      principalCode = text(row[indexes["Product Code"]]).toUpperCase(),
      mapped = uniqueForisaMapping(mappings.byPrincipalCode.get(principalCode) ?? [], principalCode),
      actual = [...(actualCodes.get(principalCode) ?? [])],
      accurateProductCode = actual.length === 1 ? actual[0] : mapped.mapping?.code ?? null;
    let quantity = 0,
      dpp = 0,
      tax = 0,
      total = 0,
      invalidReason = mapped.invalidReason ?? (mapped.mapping ? null : `Produk tidak terpetakan: ${principalCode}`);
    if (!invalidReason && actual.length > 1)
      invalidReason = `Mapping FORISA ambigu untuk kode Accurate ${principalCode}`;
    try {
      quantity = number(row[indexes["Qty (CB)"]], "Qty (CB)", sourceRowNumber);
      const price = number(row[indexes.Price], "Price", sourceRowNumber),
        amount = number(row[indexes.Amount], "Amount", sourceRowNumber),
        discount = number(row[indexes.Discount], "Discount", sourceRowNumber);
      dpp = number(row[indexes["Amount After Discount"]], "Amount After Discount", sourceRowNumber);
      tax = number(row[indexes.PPN], "PPN", sourceRowNumber);
      total = number(row[indexes["Total Amount"]], "Total Amount", sourceRowNumber);
      if (!invalidReason && Math.abs(quantity * price - amount) > 1 + 1e-9)
        invalidReason = `Formula Amount tidak konsisten pada baris ${sourceRowNumber}`;
      else if (!invalidReason && Math.abs(amount - discount - dpp) > 1 + 1e-9)
        invalidReason = `Formula Amount After Discount tidak konsisten pada baris ${sourceRowNumber}`;
      else if (!invalidReason && Math.abs(dpp + tax - total) > 1 + 1e-9)
        invalidReason = `Formula Total Amount tidak konsisten pada baris ${sourceRowNumber}`;
      else if (!invalidReason && Math.abs(Math.round(dpp * 0.11) - tax) > 1 + 1e-9)
        invalidReason = `Formula PPN tidak konsisten pada baris ${sourceRowNumber}`;
    } catch (error) {
      if (!invalidReason)
        invalidReason = error instanceof Error ? error.message : `Data FORISA tidak valid pada baris ${sourceRowNumber}`;
    }
    lines.push({
      source: "PRINCIPAL",
      sourceRowNumber,
      invoiceNumber: documentNumber,
      customerCode: "",
      accurateProductCode,
      principalProductCode: principalCode || null,
      quantity,
      dpp,
      tax,
      total,
      invalidReason,
    });
  }
  return lines;
}

export function reconcileForisaPurchases(
  accurateBuffer: Buffer | Uint8Array,
  principalBuffer: Buffer | Uint8Array,
  mappingBuffer: Buffer | Uint8Array,
  principalFilename: string,
  options: { dppTolerance?: number } = {},
): ReturnReconciliationOutput {
  const dppTolerance = options.dppTolerance ?? 1;
  if (!Number.isFinite(dppTolerance) || dppTolerance < 0)
    throw new Error("Toleransi DPP tidak valid");
  const documentNumber = forisaDocumentNumber(principalFilename),
    mappings = parseForisaMappings(mappingBuffer),
    accurate = parseForisaAccurate(accurateBuffer, mappings, documentNumber);
  return reconcile(
    accurate.lines,
    parseForisaPrincipal(principalBuffer, mappings, documentNumber, accurate.actualCodes),
    dppTolerance,
  );
}

function parseReckittAccurate(
  buffer: Buffer | Uint8Array,
  mappings: ReckittMappings,
  options: CodeMappedPurchaseOptions = reckittOptions,
): CanonicalReturnLine[] {
  const allRows = rows(buffer, "Rincian Faktur Pembelian"),
    required = ["NO. PEMBELIAN", "KODE BARANG", "QTY", "SATUAN", "DPP", "PPN", "REM"],
    { headerRow, indexes } = table(allRows, required),
    lines: CanonicalReturnLine[] = [],
    documents = new Map<string, CanonicalReturnLine[]>();
  for (let index = headerRow + 1; index < allRows.length; index++) {
    const row = allRows[index];
    if (row.every((value) => text(value) === "")) continue;
    const sourceRowNumber = index + 1,
      productCode = text(row[indexes["KODE BARANG"]]).toUpperCase(),
      invoiceMatches = [
        ...text(row[indexes.REM]).matchAll(options.accurateInvoicePattern),
      ].map((match) => match[0]),
      mapping = mappings.byWinCode.get(productCode),
      quantity = number(row[indexes.QTY], "QTY", sourceRowNumber),
      dpp = number(row[indexes.DPP], "DPP", sourceRowNumber),
      documentTax = number(row[indexes.PPN], "PPN", sourceRowNumber);
    let invalidReason =
      invoiceMatches.length === 1
        ? null
        : `REM harus memuat tepat satu ${options.accurateInvoiceLabel} pada baris ${sourceRowNumber}`;
    if (!invalidReason && text(row[indexes.SATUAN]).toUpperCase() !== "KRT")
      invalidReason = `SATUAN harus KRT pada baris ${sourceRowNumber}`;
    if (!invalidReason && !mapping)
      invalidReason = `KODE BARANG tidak ada di mapping pada baris ${sourceRowNumber}: ${productCode}`;
    const line: CanonicalReturnLine = {
      source: "ACCURATE",
      sourceRowNumber,
      invoiceNumber:
        invoiceMatches.length === 1
          ? invoiceMatches[0]
          : text(row[indexes["NO. PEMBELIAN"]]).toUpperCase(),
      customerCode: "",
      accurateProductCode: productCode || null,
      principalProductCode: mapping?.name ?? null,
      quantity,
      dpp,
      tax: documentTax,
      total: dpp + documentTax,
      invalidReason,
    };
    lines.push(line);
    const documentNumber = text(row[indexes["NO. PEMBELIAN"]]).toUpperCase(),
      document = documents.get(documentNumber) ?? [];
    document.push(line);
    documents.set(documentNumber, document);
  }
  for (const document of documents.values()) {
    const dpp = document.reduce((sum, line) => sum + line.dpp, 0),
      taxes = new Set(document.map((line) => line.tax));
    if (taxes.size !== 1) {
      for (const line of document)
        line.invalidReason ??= `PPN dokumen tidak konsisten untuk ${line.invoiceNumber}`;
      continue;
    }
    const documentTax = document[0].tax;
    for (const line of document) {
      line.tax = dpp ? documentTax * line.dpp / dpp : 0;
      line.total = line.dpp + line.tax;
    }
  }
  return lines;
}

function parseReckittPrincipal(
  buffer: Buffer | Uint8Array,
  mappings: ReckittMappings,
  options: CodeMappedPurchaseOptions = reckittOptions,
): CanonicalReturnLine[] {
  const allRows = rows(buffer),
    required = [
      "Invoice No",
      "Product Code",
      "UOM Code",
      "Default UOM",
      "Received Product Quantity",
      "Invoice Quantity UOM",
      "Product List Price",
      "Customer Discount Amount",
      "Purchase Discount Amount",
      "No Return Discount Amount",
      "Discount Allowance Amount",
      "Net Amount",
      "Tax Percentage",
      "Total Tax Amount",
    ],
    { headerRow, indexes } = table(allRows, required),
    lines: CanonicalReturnLine[] = [];
  for (let index = headerRow + 1; index < allRows.length; index++) {
    const row = allRows[index];
    if (row.every((value) => text(value) === "")) continue;
    const sourceRowNumber = index + 1,
      invoiceNumber = text(row[indexes["Invoice No"]]),
      principalProductCode = text(row[indexes["Product Code"]]).toUpperCase(),
      namedMappings = mappings.byPrincipalCode.get(principalProductCode) ?? [],
      mapping = namedMappings.length === 1 ? namedMappings[0] : undefined;
    let quantity = 0,
      dpp = 0,
      tax = 0,
      invalidReason =
        !options.principalInvoicePattern.test(invoiceNumber)
          ? `Invoice No tidak valid pada baris ${sourceRowNumber}`
          : namedMappings.length > 1
            ? `Mapping kode ambigu ${principalProductCode}: ${namedMappings.map((item) => item.code).join(", ")}`
            : mapping
              ? mapping.invalidReason ?? null
              : `Produk tidak terpetakan: ${principalProductCode}`;
    const uom = text(row[indexes["UOM Code"]]).toUpperCase(),
      defaultUom = text(row[indexes["Default UOM"]]).toUpperCase();
    if (!invalidReason && !options.allowedUoms.includes(uom))
      invalidReason = `UOM Code harus ${options.allowedUomsLabel} pada baris ${sourceRowNumber}`;
    if (!invalidReason && defaultUom !== "EA")
      invalidReason = `Default UOM harus EA pada baris ${sourceRowNumber}`;
    try {
      const received = number(
          row[indexes["Received Product Quantity"]],
          "Received Product Quantity",
          sourceRowNumber,
        ),
        listPrice = number(
          row[indexes["Product List Price"]],
          "Product List Price",
          sourceRowNumber,
        ),
        discounts = [
          "Customer Discount Amount",
          "Purchase Discount Amount",
          "No Return Discount Amount",
          "Discount Allowance Amount",
        ].reduce(
          (sum, header) =>
            sum + optionalNumber(row[indexes[header]], header, sourceRowNumber),
          0,
        ),
        taxPercentage = optionalNumber(
          row[indexes["Tax Percentage"]],
          "Tax Percentage",
          sourceRowNumber,
        ),
        invoiceQuantity = number(
        row[indexes["Invoice Quantity UOM"]],
        "Invoice Quantity UOM",
        sourceRowNumber,
      );
      quantity = received;
      dpp = number(row[indexes["Net Amount"]], "Net Amount", sourceRowNumber);
      tax = optionalNumber(
        row[indexes["Total Tax Amount"]],
        "Total Tax Amount",
        sourceRowNumber,
      );
      if (!invalidReason && received !== invoiceQuantity)
        invalidReason = `Received Product Quantity dan Invoice Quantity UOM tidak konsisten pada baris ${sourceRowNumber}`;
      else if (
        !invalidReason &&
        Math.abs(quantity * listPrice - discounts - dpp) > 1 + 1e-9
      )
        invalidReason = `Formula Net Amount tidak konsisten pada baris ${sourceRowNumber}`;
      else if (
        !invalidReason &&
        Math.abs(dpp * taxPercentage / 100 - tax) > 1 + 1e-9
      )
        invalidReason = `Formula pajak tidak konsisten pada baris ${sourceRowNumber}`;
    } catch (error) {
      if (!invalidReason)
        invalidReason =
          error instanceof Error
            ? error.message
            : `Data tidak valid pada baris ${sourceRowNumber}`;
    }
    lines.push({
      source: "PRINCIPAL",
      sourceRowNumber,
      invoiceNumber,
      customerCode: "",
      accurateProductCode: mapping?.code ?? null,
      principalProductCode: principalProductCode || null,
      quantity,
      dpp,
      tax,
      total: dpp + tax,
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
    principalLines.filter(
      (line) => line.invalidReason && !line.invalidReason.startsWith("Produk tidak terpetakan"),
    ),
  ).values())
    results.push(result(undefined, invalid, "INVALID_DATA"));
  for (const unmapped of aggregate(
    principalLines.filter(
      (line) =>
        !line.accurateProductCode &&
        line.invalidReason?.startsWith("Produk tidak terpetakan"),
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

export function reconcileReckittPurchases(
  accurateBuffer: Buffer | Uint8Array,
  principalBuffer: Buffer | Uint8Array,
  mappingBuffer: Buffer | Uint8Array,
  options: { dppTolerance?: number } = {},
): ReturnReconciliationOutput {
  const dppTolerance = options.dppTolerance ?? 1;
  if (!Number.isFinite(dppTolerance) || dppTolerance < 0)
    throw new Error("Toleransi DPP tidak valid");
  const mappings = parseReckittMappings(mappingBuffer);
  return reconcile(
    parseReckittAccurate(accurateBuffer, mappings),
    parseReckittPrincipal(principalBuffer, mappings),
    dppTolerance,
  );
}

function cussonsCodeMappings(mappings: CussonsMappings): ReckittMappings {
  const byPrincipalCode = new Map<string, Mapping[]>(),
    byWinCode = new Map<string, Mapping>();
  for (const [principalCode, mapped] of mappings.products) {
    const mapping: Mapping = {
      code: mapped.productCodeInternal,
      unitsPerCase: mapped.caseSize ?? 1,
      name: principalCode,
      ...(mapped.mappingStatus === "OK"
        ? {}
        : {
            invalidReason: `Mapping kode konflik atau invalid ${principalCode}`,
          }),
    };
    byPrincipalCode.set(principalCode, [mapping]);
    if (mapping.code && !byWinCode.has(mapping.code))
      byWinCode.set(mapping.code, mapping);
  }
  return { byPrincipalCode, byWinCode };
}

export function reconcileCussonsPurchases(
  accurateBuffer: Buffer | Uint8Array,
  principalBuffer: Buffer | Uint8Array,
  mappingBuffer: Buffer | Uint8Array,
  options: { dppTolerance?: number } = {},
): ReturnReconciliationOutput {
  const dppTolerance = options.dppTolerance ?? 1;
  if (!Number.isFinite(dppTolerance) || dppTolerance < 0)
    throw new Error("Toleransi DPP tidak valid");
  const mappings = cussonsCodeMappings(parseCussonsMappings(mappingBuffer));
  return reconcile(
    parseReckittAccurate(accurateBuffer, mappings, cussonsOptions),
    parseReckittPrincipal(principalBuffer, mappings, cussonsOptions),
    dppTolerance,
  );
}
