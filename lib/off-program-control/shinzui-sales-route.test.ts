import assert from "node:assert/strict";
import { createKinoSalesPostHandler } from "./kino-sales-route.ts";

const mime =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const mapping = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const expectedOutput = {
  summary: { MATCH: 1 },
  results: [{ status: "MATCH", orderNumber: "INVGTS1-2-3" }],
};

function request(): Request {
  const form = new FormData();
  form.append(
    "accurateFile",
    new File([mapping], "accurate.xlsx", { type: mime }),
  );
  form.append(
    "principalFile",
    new File([mapping], "shinzui.xlsx", { type: mime }),
  );
  return new Request("http://localhost/api/reconciliation/shinzui/sales", {
    method: "POST",
    body: form,
  });
}

function handler(reconcile: () => unknown) {
  return createKinoSalesPostHandler({
    authorize: async () => null,
    readMapping: async () => mapping,
    reconcile,
    missingMappingMessage: "Master mapping SHINZUI tidak tersedia.",
  });
}

const deniedResponse = await createKinoSalesPostHandler({
  authorize: async () => Response.json({ error: "Forbidden" }, { status: 403 }),
  readMapping: async () => mapping,
  reconcile: () => expectedOutput,
})(request());
assert.equal(deniedResponse.status, 403);

const missingMappingResponse = await createKinoSalesPostHandler({
  authorize: async () => null,
  readMapping: async () => {
    throw Object.assign(new Error("D:\\secret\\SHINZUI.xlsx"), {
      code: "ENOENT",
    });
  },
  reconcile: () => expectedOutput,
  missingMappingMessage: "Master mapping SHINZUI tidak tersedia.",
})(request());
assert.equal(missingMappingResponse.status, 500);
assert.deepEqual(await missingMappingResponse.json(), {
  error: "Master mapping SHINZUI tidak tersedia.",
});

const missingHeader =
  "Header wajib tidak ditemukan: INV NUM, INV DATE, ID PRODUK, ID PELANGGAN, ID SALES, TIPE PENJUALAN, QTY TRX-INV, QTY SMALL, HARGA, VALUE EXCL DISC, DISC 1 INV, DISC 2A INV, DISC 2B (PROMO DIST.) INV, DISC 2B (MANUAL) INV, DISC 3 INV, DISC 4 (PROMO DIST.) INV, DISC 4 (MANUAL) INV, DISC 5 INV, TOTAL DISC INV, DPP INV, PPN INV, TOTAL INV";
const missingHeaderResponse = await handler(() => {
  throw new Error(missingHeader);
})(request());
assert.equal(missingHeaderResponse.status, 422);
assert.match(
  (await missingHeaderResponse.json()).error,
  /^Header wajib tidak ditemukan:/,
);

const missingMappingHeader =
  "Header wajib tidak ditemukan: KODE PCPL, KODE BARANG WIN2, SATUAN FIX WIN, ISI/CTN";
const missingMappingHeaderResponse = await handler(() => {
  throw new Error(missingMappingHeader);
})(request());
assert.equal(missingMappingHeaderResponse.status, 422);
assert.deepEqual(await missingMappingHeaderResponse.json(), {
  error: missingMappingHeader,
});

const invalidInvoiceResponse = await handler(() => {
  throw new Error("INV NUM harus memuat tepat satu nomor invoice pada baris 5");
})(request());
assert.equal(invalidInvoiceResponse.status, 422);
assert.deepEqual(await invalidInvoiceResponse.json(), {
  error: "INV NUM harus memuat tepat satu nomor invoice pada baris 5",
});

const nonNumericIsiResponse = await handler(() => {
  throw new Error("ISI/CTN tidak valid pada baris 171");
})(request());
assert.equal(nonNumericIsiResponse.status, 422);
assert.deepEqual(await nonNumericIsiResponse.json(), {
  error: "ISI/CTN tidak valid pada baris 171",
});

const nonPositiveIsiResponse = await handler(() => {
  throw new Error("ISI/CTN harus positif pada baris 2");
})(request());
assert.equal(nonPositiveIsiResponse.status, 422);
assert.deepEqual(await nonPositiveIsiResponse.json(), {
  error: "ISI/CTN harus positif pada baris 2",
});

for (const message of [
  "QTY TRX-INV tidak valid pada baris 5",
  "VALUE EXCL DISC terlalu besar pada baris 5",
  "INV DATE tidak valid pada baris 5",
  "ID PRODUK kosong pada baris 5",
  "TIPE PENJUALAN tidak valid pada baris 5",
  "Tanda transaksi RETUR tidak valid pada baris 5",
  "Value Excl Disc tidak konsisten pada baris 5",
  "Total Disc Inv tidak konsisten pada baris 5",
  "DPP Inv tidak konsisten pada baris 5",
  "PPN Inv tidak konsisten pada baris 5",
] as const) {
  const response = await handler(() => {
    throw new Error(message);
  })(request());
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: message });
}

const safeParserResponse = await handler(() => {
  throw new Error("Total Inv tidak konsisten pada baris 5");
})(request());
assert.equal(safeParserResponse.status, 422);
assert.deepEqual(await safeParserResponse.json(), {
  error: "Total Inv tidak konsisten pada baris 5",
});

const hiddenErrorResponse = await handler(() => {
  throw new Error("D:\\secret\\SHINZUI.xlsx: parser stack");
})(request());
assert.equal(hiddenErrorResponse.status, 500);
assert.deepEqual(await hiddenErrorResponse.json(), {
  error: "Rekonsiliasi gagal diproses.",
});

const successResponse = await handler(() => expectedOutput)(request());
assert.deepEqual(await successResponse.json(), expectedOutput);

console.log(
  "OK - route SHINZUI mencakup izin, master, parser aman, masking, dan sukses.",
);
