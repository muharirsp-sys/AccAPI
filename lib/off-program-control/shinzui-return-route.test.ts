import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { createKinoSalesPostHandler } from "./kino-sales-route.ts";
import { reconcileShinzuiReturns } from "./return-reconciliation.ts";

const mime =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const expected = {
  summary: { MATCH: 1 },
  results: [{ status: "MATCH", invoiceNumber: "INVGTS1-2-3" }],
};

function request(mutate?: (form: FormData) => void): Request {
  const form = new FormData();
  form.append("accurateFile", new File([zip], "accurate.xlsx", { type: mime }));
  form.append(
    "principalFile",
    new File([zip], "principal.xlsx", { type: mime }),
  );
  mutate?.(form);
  return new Request("http://localhost/api/reconciliation/shinzui/returns", {
    method: "POST",
    body: form,
  });
}

function handler(reconcile: () => unknown = () => expected) {
  return createKinoSalesPostHandler({
    authorize: async () => null,
    readMapping: async () => zip,
    reconcile,
    missingMappingMessage: "Master mapping SHINZUI tidak tersedia.",
  });
}

let parsedMultipart = false;
const denied = await createKinoSalesPostHandler({
  authorize: async () => Response.json({ error: "Forbidden" }, { status: 403 }),
  readMapping: async () => zip,
  reconcile: () => expected,
})(
  Object.assign(new Request("http://localhost", { method: "POST" }), {
    formData: async () => {
      parsedMultipart = true;
      throw new Error("must not parse");
    },
  }),
);
assert.equal(denied.status, 403);
assert.equal(parsedMultipart, false);

assert.equal(
  (
    await handler()(
      request((form) => form.append("unexpected", new File([zip], "x.xlsx"))),
    )
  ).status,
  400,
);
assert.equal(
  (
    await handler()(
      request((form) =>
        form.append("accurateFile", new File([zip], "duplicate.xlsx")),
      ),
    )
  ).status,
  400,
);

const missingMaster = createKinoSalesPostHandler({
  authorize: async () => null,
  readMapping: async () => {
    throw Object.assign(new Error("D:\\secret\\SHINZUI.xlsx"), {
      code: "ENOENT",
    });
  },
  reconcile: () => expected,
  missingMappingMessage: "Master mapping SHINZUI tidak tersedia.",
});
const missingResponse = await missingMaster(request());
assert.equal(missingResponse.status, 500);
assert.deepEqual(await missingResponse.json(), {
  error: "Master mapping SHINZUI tidak tersedia.",
});

for (const message of [
  "REM harus memuat tepat satu nomor invoice pada baris 5",
  "Mapping KODE BARANG ambigu pada baris 7",
] as const) {
  const response = await handler(() => {
    throw new Error(message);
  })(request());
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: message });
}

const hiddenResponse = await handler(() => {
  throw new Error("D:\\secret\\SHINZUI.xlsx: parser stack");
})(request());
assert.equal(hiddenResponse.status, 500);
assert.deepEqual(await hiddenResponse.json(), {
  error: "Rekonsiliasi gagal diproses.",
});

const successResponse = await handler()(request());
assert.equal(successResponse.status, 200);
assert.deepEqual(await successResponse.json(), expected);

function workbook(name: string, rows: unknown[][]): Uint8Array {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
}

const accurateHeaders = [
  "KODE PELANGGAN INDUK", "KODE_BARANG", "QTY_SATUANKECIL", "DPP",
  "NILAI_PAJAK", "JUMLAH", "REM", "JENIS_TRANSAKSI",
];
const principalHeaders = [
  "INV NUM", "ID PRODUK", "ID PELANGGAN LAMA", "TIPE PENJUALAN",
  "QTY SMALL", "DPP INV", "PPN INV", "TOTAL INV",
];
const mappingHeaders = [
  "KODE BARANG", "PCPL KODE 1", "PCPL KODE 2", "PCPL KODE 3",
  "PCPL KODE 4", "PCPL KODE 5",
];
const validAccurate = workbook("Rincian Faktur Penjualan", [
  accurateHeaders,
  ["C-1", "I-1", -1, -100, -11, -111, "INVGTS1-2607-000001", "Retur Penjualan"],
]);
const validPrincipal = workbook("PenjualanInvoice", [
  principalHeaders,
  ["INVGTS1-2607-000001", "P-1", "C-1", "RETUR", -1, -100, -11, -111],
]);
const validMapping = workbook("Fix Mapping", [
  mappingHeaders,
  ["I-1", "P-1", 0, 0, 0, 0],
]);

function integrated(mapping: Uint8Array = validMapping) {
  return createKinoSalesPostHandler({
    authorize: async () => null,
    readMapping: async () => mapping,
    reconcile: (accurate, principal, master) =>
      reconcileShinzuiReturns(accurate, principal, master),
    missingMappingMessage: "Master mapping SHINZUI tidak tersedia.",
  });
}

async function integratedResponse(
  accurate: Uint8Array,
  principal: Uint8Array = validPrincipal,
  mapping: Uint8Array = validMapping,
): Promise<Response> {
  const form = new FormData();
  form.append("accurateFile", new File([Uint8Array.from(accurate)], "accurate.xlsx", { type: mime }));
  form.append("principalFile", new File([Uint8Array.from(principal)], "principal.xlsx", { type: mime }));
  return integrated(mapping)(new Request("http://localhost", { method: "POST", body: form }));
}

for (const [accurate, principal, mapping, message] of [
  [
    workbook("Rincian Faktur Penjualan", [
      accurateHeaders,
      ["", "I-1", -1, -100, -11, -111, "INVGTS1-2607-000001", "Retur Penjualan"],
    ]),
    validPrincipal,
    validMapping,
    "KODE PELANGGAN INDUK kosong pada baris 2",
  ],
  [
    validAccurate,
    workbook("PenjualanInvoice", [
      principalHeaders,
      ["INVGTS1-2607-000001", "P-1", "", "RETUR", -1, -100, -11, -111],
    ]),
    validMapping,
    "ID PELANGGAN LAMA kosong pada baris 2",
  ],
  [
    validAccurate,
    validPrincipal,
    workbook("Fix Mapping", [mappingHeaders, ["", "P-1", 0, 0, 0, 0]]),
    "KODE BARANG kosong pada baris 2",
  ],
] as const) {
  const response = await integratedResponse(accurate, principal, mapping);
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: message });
}

const principalWithoutLegacyCustomer = workbook("PenjualanInvoice", [
  principalHeaders.filter((header) => header !== "ID PELANGGAN LAMA"),
  ["INVGTS1-2607-000001", "P-1", "RETUR", -1, -100, -11, -111],
]);
const missingLegacyCustomer = await integratedResponse(
  validAccurate,
  principalWithoutLegacyCustomer,
);
assert.equal(missingLegacyCustomer.status, 422);
assert.deepEqual(await missingLegacyCustomer.json(), {
  error:
    "Header wajib tidak ditemukan: INV NUM, ID PRODUK, ID PELANGGAN LAMA, TIPE PENJUALAN, QTY SMALL, DPP INV, PPN INV, TOTAL INV",
});

const corruptResponse = await integratedResponse(
  new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff]),
);
assert.equal(corruptResponse.status, 422);
assert.deepEqual(await corruptResponse.json(), {
  error: "File XLSX rusak atau tidak valid.",
});
console.log(
  "OK - route Return SHINZUI mencakup izin, field, master, parser aman, masking, integrasi parser nyata, dan sukses.",
);
