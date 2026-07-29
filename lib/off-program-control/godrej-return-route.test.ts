import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import {
  createKinoSalesPostHandler,
  CSV_MIME_TYPES,
} from "./kino-sales-route.ts";
import { reconcileGodrejReturns } from "./return-reconciliation.ts";

const xlsxMime =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function workbook(sheets: Record<string, unknown[][]>): Uint8Array {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return new Uint8Array(XLSX.write(book, { bookType: "xlsx", type: "buffer" }));
}

const accurate = workbook({
  "Rincian Faktur Penjualan": [
    [
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
    [
      "RET-1",
      "C-ONE-GD",
      "WIN-1",
      1,
      10_000,
      1_100,
      11_100,
      "RB/BFG-1",
      "Retur Penjualan",
    ],
  ],
});
const principal = new TextEncoder().encode(
  [
    "Sale Return No.,CUSTOMER,Skunit,Quantity(Units),Amount,Sale Return State",
    'RB/BFG-1,"ONE STORE (C-ONE)",P-1 - PRODUCT ONE,1,11100,approved',
  ].join("\r\n"),
);
const mapping = workbook({
  "Pvt Map 1": [
    ["Kode BARANG Win2", "Kode Pcpl"],
    ["WIN-1", "P-1"],
  ],
  "Form Fix": [
    ["Nama Barang Principle", "Kode BARANG Win2", "DATABASE PASSWORD"],
    ["PRODUCT ONE", "WIN-1", "must-not-leak"],
  ],
});

function file(content: BlobPart, name: string, type: string): File {
  return new File([content], name, { type });
}

function request(mutate?: (form: FormData) => void): Request {
  const form = new FormData();
  form.append("accurateFile", file(accurate, "accurate.xlsx", xlsxMime));
  form.append("principalFile", file(principal, "return.csv", "text/csv"));
  mutate?.(form);
  return new Request("http://localhost/api/reconciliation/godrej/returns", {
    method: "POST",
    body: form,
  });
}

function handler(
  overrides: Partial<Parameters<typeof createKinoSalesPostHandler>[0]> = {},
) {
  return createKinoSalesPostHandler({
    authorize: async () => null,
    readMapping: async () => mapping,
    reconcile: (accurateFile, principalFile, mappingFile) =>
      reconcileGodrejReturns(accurateFile, principalFile, mappingFile, {
        dppTolerance: 1,
      }),
    principalUpload: {
      kind: "csv",
      extensions: [".csv"],
      mimeTypes: CSV_MIME_TYPES,
    },
    missingMappingMessage: "Master mapping GODREJ Return tidak tersedia.",
    ...overrides,
  });
}

const route = await readFile(
  new URL("../../app/api/reconciliation/godrej/returns/route.ts", import.meta.url),
  "utf8",
);

let parsedMultipart = false;
const denied = await handler({
  authorize: async () => Response.json({ error: "Forbidden" }, { status: 403 }),
})(
  Object.assign(new Request("http://localhost", { method: "POST" }), {
    formData: async () => {
      parsedMultipart = true;
      throw new Error("multipart tidak boleh dibaca");
    },
  }),
);
assert.equal(denied.status, 403);
assert.equal(parsedMultipart, false);

for (const [mutate, status] of [
  [(form: FormData) => form.delete("accurateFile"), 400],
  [(form: FormData) => form.delete("principalFile"), 400],
  [
    (form: FormData) =>
      form.append("principalFile", file(principal, "again.csv", "text/csv")),
    400,
  ],
  [
    (form: FormData) =>
      form.append("unexpected", file(principal, "extra.csv", "text/csv")),
    400,
  ],
  [
    (form: FormData) =>
      form.set("accurateFile", file(accurate, "accurate.csv", xlsxMime)),
    400,
  ],
  [
    (form: FormData) =>
      form.set("accurateFile", file(accurate, "accurate.xlsx", "text/csv")),
    400,
  ],
  [
    (form: FormData) =>
      form.set("principalFile", file(principal, "return.xlsx", "text/csv")),
    400,
  ],
  [
    (form: FormData) =>
      form.set("principalFile", file(principal, "return.csv", "image/png")),
    400,
  ],
  [
    (form: FormData) =>
      form.set("accurateFile", file("not zip", "accurate.xlsx", xlsxMime)),
    422,
  ],
  [
    (form: FormData) =>
      form.set(
        "principalFile",
        file("Sale Return No.\0,CUSTOMER", "return.csv", "text/csv"),
      ),
    422,
  ],
  [
    (form: FormData) =>
      form.set(
        "principalFile",
        file(new Uint8Array(10 * 1024 * 1024 + 1), "return.csv", "text/csv"),
      ),
    413,
  ],
] as const) {
  assert.equal((await handler()(request(mutate))).status, status);
}

for (const type of CSV_MIME_TYPES)
  assert.equal(
    (
      await handler()(
        request((form) =>
          form.set("principalFile", file(principal, "return.csv", type)),
        ),
      )
    ).status,
    200,
    `CSV MIME ${type || "<empty>"}`,
  );

const missingMaster = await handler({
  readMapping: async () => {
    throw Object.assign(new Error("D:\\secret\\GODREJ_RETURN.xlsx"), {
      code: "ENOENT",
    });
  },
})(request());
assert.equal(missingMaster.status, 500);
assert.deepEqual(await missingMaster.json(), {
  error: "Master mapping GODREJ Return tidak tersedia.",
});

for (const message of [
  "Header wajib tidak ditemukan: SALE RETURN NO., CUSTOMER, SKUNIT, QUANTITY(UNITS), AMOUNT, SALE RETURN STATE",
  "CUSTOMER harus memuat tepat satu token pada baris 2",
  "Quantity(Units) tidak valid pada baris 2",
  "Amount kosong pada baris 2",
] as const) {
  const response = await handler({
    reconcile: () => {
      throw new Error(message);
    },
  })(request());
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: message });
}

for (const message of [
  "Header wajib tidak ditemukan: DATABASE PASSWORD",
  "D:\\secret\\GODREJ_RETURN.xlsx parser stack",
] as const) {
  const response = await handler({
    reconcile: () => {
      throw new Error(message);
    },
  })(request());
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Rekonsiliasi gagal diproses.",
  });
}

const success = await handler()(request());
assert.equal(success.status, 200);
assert.deepEqual(
  await success.json(),
  reconcileGodrejReturns(accurate, principal, mapping, { dppTolerance: 1 }),
);

assert.match(route, /export const runtime = "nodejs"/);
assert.match(route, /export const POST = createKinoSalesPostHandler/);
assert.match(route, /requirePermission\(request, "reconciliation\.run"\)/);
assert.match(route, /"GODREJ_RETURN\.xlsx"/);
assert.match(route, /reconcileGodrejReturns\(accurate, principal, mapping/);
assert.match(route, /principalUpload:\s*{\s*kind: "csv"/);

console.log(
  "OK - route Return GODREJ mencakup auth, XLSX+CSV, master, parser aman, masking, dan parity engine nyata.",
);
