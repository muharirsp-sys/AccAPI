import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import {
  type CanonicalSalesLine,
  parseAccurateSales,
  parseShinzuiMappings,
  parseShinzuiSales,
  reconcileShinzuiSales,
} from "./sales-reconciliation.ts";

function workbook(sheets: Record<string, unknown[][]>): Buffer {
  const value = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(value, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(value, { type: "buffer", bookType: "xlsx" });
}

const mapping = workbook({
  "Pvt Map 1": [
    ["Kode Pcpl", "Kode BARANG Win2", "SATUAN Fix Win", "ISI/CTN"],
    ["050703100", "F4031101040010", "PCS", 48],
    ["050703100", "F4031101040010", "PCS", 48],
    [null, "(blank)", 0, ""],
  ],
});
const parsed = parseShinzuiMappings(mapping);
assert.deepEqual(parsed.products.get("050703100"), [
  {
    internal: "F4031101040010",
    unit: "PCS",
    caseSize: 48,
    caseSizeError: null,
    sourceRowNumber: 2,
  },
]);

const accurate = workbook({
  "Rincian Faktur Penjualan": [
    [
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
    ],
    [
      "A-1",
      46216,
      "C-1",
      "S-1",
      "F4031101040010",
      2,
      "PCS",
      1000,
      0,
      1000,
      110,
      1110,
      "catatan INVGTS2607-010441-01 tambahan",
      "JUAL",
    ],
  ],
});
assert.equal(
  parseAccurateSales(accurate)[0]?.orderNumber,
  "INVGTS2607-010441-01",
);

const incompleteMapping = workbook({
  "Pvt Map 1": [
    ["Kode Pcpl", "Kode BARANG Win2", "SATUAN Fix Win", "ISI/CTN"],
    ["050703100", "F4031101040010", "PCS", null],
  ],
});
assert.throws(
  () => parseShinzuiMappings(incompleteMapping),
  /Pvt Map 1 tidak lengkap pada baris 2/,
);
assert.throws(
  () =>
    parseShinzuiMappings(
      workbook({
        "Pvt Map 1": [
          ["Kode Pcpl", "Kode BARANG Win2", "SATUAN Fix Win", "ISI/CTN"],
          ["050703100", "(blank)", "PCS", 48],
        ],
      }),
    ),
  /Pvt Map 1 tidak lengkap pada baris 2/,
);

const textIsiMapping = workbook({
  "Pvt Map 1": [
    ["Kode Pcpl", "Kode BARANG Win2", "SATUAN Fix Win", "ISI/CTN"],
    ["070702000", "ITEM-TEXT", "PCSX10", "48 RCG"],
  ],
});
assert.equal(
  parseShinzuiMappings(textIsiMapping).products.get("070702000")?.[0]
    ?.caseSizeError,
  "ISI/CTN tidak valid pada baris 2",
);

const zeroIsiMapping = workbook({
  "Pvt Map 1": [
    ["Kode Pcpl", "Kode BARANG Win2", "SATUAN Fix Win", "ISI/CTN"],
    ["070702000", "ITEM-ZERO", "PCS", 0],
  ],
});
assert.equal(
  parseShinzuiMappings(zeroIsiMapping).products.get("070702000")?.[0]
    ?.caseSizeError,
  "ISI/CTN harus positif pada baris 2",
);

const PRINCIPAL_HEADERS = [
  "INV Num",
  "INV Date",
  "ID Produk",
  "ID Pelanggan",
  "ID Sales",
  "Tipe Penjualan",
  "Qty Trx-Inv",
  "Qty Small",
  "Harga",
  "Value Excl Disc",
  "Disc 1 Inv",
  "Disc 2A Inv",
  "Disc 2B (Promo Dist.) Inv",
  "Disc 2B (Manual) Inv",
  "Disc 3 Inv",
  "Disc 4 (Promo Dist.) Inv",
  "Disc 4 (Manual) Inv",
  "Disc 5 Inv",
  "Total Disc Inv",
  "DPP Inv",
  "PPN Inv",
  "Total Inv",
] as const;
type PrincipalValues = Record<(typeof PRINCIPAL_HEADERS)[number], unknown>;
function principalRow(overrides: Partial<PrincipalValues> = {}): unknown[] {
  const values: PrincipalValues = {
    "INV Num": "INVGTS2607-010441-01",
    "INV Date": 46216,
    "ID Produk": "050703100",
    "ID Pelanggan": "CUSTOMER-1",
    "ID Sales": "SALES-1",
    "Tipe Penjualan": "JUAL",
    "Qty Trx-Inv": 2,
    "Qty Small": 2,
    Harga: 500,
    "Value Excl Disc": 1000,
    "Disc 1 Inv": 0,
    "Disc 2A Inv": 0,
    "Disc 2B (Promo Dist.) Inv": 0,
    "Disc 2B (Manual) Inv": 0,
    "Disc 3 Inv": 0,
    "Disc 4 (Promo Dist.) Inv": 0,
    "Disc 4 (Manual) Inv": 0,
    "Disc 5 Inv": 0,
    "Total Disc Inv": 0,
    "DPP Inv": 1000,
    "PPN Inv": 110,
    "Total Inv": 1110,
    ...overrides,
  };
  return PRINCIPAL_HEADERS.map((header) => values[header]);
}
function principal(...rows: unknown[][]): Buffer {
  return workbook({
    PenjualanInvoice: [
      ["LAPORAN PENJUALAN"],
      ["PERIODE"],
      ["CABANG"],
      [...PRINCIPAL_HEADERS],
      ...rows,
    ],
  });
}
function accurateLine(
  productCodeInternal: string,
  unitSmallest = "PCS",
  order = "INVGTS2607-010441-01",
): CanonicalSalesLine {
  return {
    source: "ACCURATE",
    sourceRowNumber: 2,
    documentNumber: "A-1",
    orderNumber: order,
    transactionDate: "2026-07-13",
    customerCodeRaw: "CUSTOMER-1",
    customerCodeInternal: "CUSTOMER-1",
    salesmanCodeRaw: "SALES-1",
    salesmanCodeInternal: "SALES-1",
    productCodeRaw: productCodeInternal,
    productCodeInternal,
    transactionClass: "NORMAL",
    quantitySmallest: 2,
    unitSmallest,
    grossAmount: 10_000_000,
    discountAmount: 0,
    dppAmount: 10_000_000,
    taxAmount: 1_100_000,
    netAmount: 11_100_000,
    mappingStatus: "OK",
  };
}

const accurateLines = [accurateLine("F4031101040010")];
const sales = parseShinzuiSales(
  principal(
    principalRow(),
    principalRow({
      "INV Num": "INVGTS2607-010442-01",
      "Tipe Penjualan": "PROMO",
      Harga: 0,
      "Value Excl Disc": 0,
      "DPP Inv": 0,
      "PPN Inv": 0,
      "Total Inv": 0,
    }),
    principalRow({
      "INV Num": "INVGTS2607-010443-01",
      "Tipe Penjualan": "RETUR",
      "Qty Trx-Inv": -2,
      "Qty Small": -2,
      "Value Excl Disc": -1000,
      "DPP Inv": -1000,
      "PPN Inv": -110,
      "Total Inv": -1110,
    }),
  ),
  parsed,
  accurateLines,
);
const [jual, promo, retur] = sales;
assert.equal(jual?.transactionClass, "NORMAL");
assert.equal(jual?.quantitySmallest, 2);
assert.equal(jual?.unitSmallest, "PCS");
assert.equal(jual?.orderNumber, "INVGTS2607-010441-01");
assert.equal(jual?.grossAmount, 10_000_000);
assert.equal(jual?.discountAmount, 0);
assert.equal(jual?.dppAmount, 10_000_000);
assert.equal(jual?.taxAmount, 1_100_000);
assert.equal(jual?.netAmount, 11_100_000);
assert.equal(jual?.customerCodeInternal, jual?.customerCodeRaw);
assert.equal(jual?.salesmanCodeInternal, jual?.salesmanCodeRaw);
assert.equal(promo?.transactionClass, "NORMAL");
assert.equal(promo?.quantitySmallest, 2);
assert.equal(promo?.netAmount, 0);
assert.equal(retur?.transactionClass, "RETURN");
assert.equal(retur?.quantitySmallest, -2);
assert.equal(retur?.netAmount, -11_100_000);

for (const [column, value, message] of [
  ["Value Excl Disc", 999, /Value Excl Disc tidak konsisten pada baris 5/],
  ["Total Disc Inv", 1, /Total Disc Inv tidak konsisten pada baris 5/],
  ["DPP Inv", 999, /DPP Inv tidak konsisten pada baris 5/],
  ["PPN Inv", 109, /PPN Inv tidak konsisten pada baris 5/],
  ["Total Inv", 1109, /Total Inv tidak konsisten pada baris 5/],
] as const)
  assert.throws(
    () =>
      parseShinzuiSales(
        principal(principalRow({ [column]: value })),
        parsed,
        accurateLines,
      ),
    message,
  );
assert.throws(
  () =>
    parseShinzuiSales(
      principal(principalRow({ "Qty Small": -2 })),
      parsed,
      accurateLines,
    ),
  /Tanda transaksi JUAL tidak valid pada baris 5/,
);
assert.throws(
  () =>
    parseShinzuiSales(
      principal(principalRow({ "Tipe Penjualan": "LAINNYA" })),
      parsed,
      accurateLines,
    ),
  /TIPE PENJUALAN tidak valid pada baris 5/,
);
assert.throws(
  () =>
    parseShinzuiSales(
      principal(principalRow({ "INV Num": "INVALID" })),
      parsed,
      accurateLines,
    ),
  /INV NUM harus memuat tepat satu nomor invoice pada baris 5/,
);

const multiMapping = parseShinzuiMappings(
  workbook({
    "Pvt Map 1": [
      ["Kode Pcpl", "Kode BARANG Win2", "SATUAN Fix Win", "ISI/CTN"],
      ["050703100", "F4031101040010", "PCS", 48],
      ["050703100", "OTHER", "PCS", 48],
    ],
  }),
);
assert.equal(
  parseShinzuiSales(principal(principalRow()), multiMapping, accurateLines)[0]
    ?.mappingStatus,
  "OK",
);
assert.equal(
  parseShinzuiSales(principal(principalRow()), multiMapping, [
    accurateLine("NO-MATCH"),
  ])[0]?.mappingStatus,
  "INVALID_DATA",
);
assert.equal(
  parseShinzuiSales(principal(principalRow()), multiMapping, [
    accurateLine("F4031101040010"),
    accurateLine("OTHER"),
  ])[0]?.mappingStatus,
  "INVALID_DATA",
);

const dirtyAlternativeMapping = parseShinzuiMappings(
  workbook({
    "Pvt Map 1": [
      ["Kode Pcpl", "Kode BARANG Win2", "SATUAN Fix Win", "ISI/CTN"],
      ["050703100", "F4031101040010", "PCS", 48],
      ["050703100", "DIRTY", "PCSX10", "48 RCG"],
    ],
  }),
);
assert.equal(
  parseShinzuiSales(
    principal(principalRow()),
    dirtyAlternativeMapping,
    accurateLines,
  )[0]?.mappingStatus,
  "OK",
);
assert.throws(
  () =>
    parseShinzuiSales(principal(principalRow()), dirtyAlternativeMapping, [
      accurateLine("DIRTY", "PCSX10"),
    ]),
  /ISI\/CTN tidak valid pada baris 3/,
);
assert.throws(
  () =>
    parseShinzuiSales(
      principal(principalRow({ "ID Produk": "070702000" })),
      parseShinzuiMappings(zeroIsiMapping),
      [accurateLine("ITEM-ZERO")],
    ),
  /ISI\/CTN harus positif pada baris 2/,
);
assert.equal(
  parseShinzuiSales(principal(principalRow()), parsed, [
    accurateLine("F4031101040010", "CTN"),
  ])[0]?.mappingStatus,
  "UNIT_CONVERSION_ERROR",
);
assert.equal(
  parseShinzuiSales(
    principal(principalRow({ "ID Produk": "UNKNOWN" })),
    parsed,
    accurateLines,
  )[0]?.mappingStatus,
  "UNMAPPED_SKU",
);

const reconciled = reconcileShinzuiSales(
  accurate,
  principal(principalRow()),
  mapping,
);
assert.equal(reconciled.summary.MATCH, 1);
assert.deepEqual(reconciled.results[0]?.warnings, []);
const [accuratePath, principalPath, mappingPath] = process.argv.slice(2);
if (accuratePath && principalPath && mappingPath) {
  const actual = reconcileShinzuiSales(
    readFileSync(accuratePath),
    readFileSync(principalPath),
    readFileSync(mappingPath),
    { valueTolerance: 1 },
  );
  assert.equal(actual.results.length, 181);
  assert.equal(actual.summary.MATCH, 130);
  assert.equal(actual.summary.VALUE_MISMATCH, 35);
  assert.equal(actual.summary.QTY_AND_VALUE_MISMATCH, 1);
  assert.equal(actual.summary.MISSING_INTERNAL, 15);
  for (const status of [
    "QTY_MISMATCH",
    "MISSING_PRINCIPAL",
    "UNMAPPED_SKU",
    "UNIT_CONVERSION_ERROR",
    "INVALID_DATA",
  ] as const)
    assert.equal(actual.summary[status], 0);
}

console.log("OK - parser dan rekonsiliasi SHINZUI tervalidasi.");
