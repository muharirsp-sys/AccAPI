import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import { createKinoSalesPostHandler } from "./kino-sales-route.ts";
import { reconcileKinoReturns } from "./return-reconciliation.ts";

const mime =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function workbook(name: string, rows: unknown[][]): Uint8Array {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
}

const accurate = workbook("Rincian Faktur Penjualan", [
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
    "RT-1",
    "C-1",
    "I-1",
    -1,
    -100,
    -11,
    -111,
    "1671-SRI-1",
    "Retur Penjualan",
  ],
]);
const principal = workbook("Sheet1", [
  [
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
  ["1671-SRI-1", "C-1", "P-1", -1, -120, -20, 0, 0, -11, -111, "RET01"],
]);
const mapping = workbook("Table Pvt 1", [
  ["Kode Pcpl", "Kode Barang Win"],
  ["P-1", "I-1"],
]);

function request(
  mutate?: (form: FormData) => void,
  accurateBuffer = accurate,
): Request {
  const form = new FormData();
  form.append(
    "accurateFile",
    new File([Uint8Array.from(accurateBuffer)], "accurate.xlsx", { type: mime }),
  );
  form.append(
    "principalFile",
    new File([Uint8Array.from(principal)], "principal.xlsx", { type: mime }),
  );
  mutate?.(form);
  return new Request("http://localhost/api/reconciliation/kino/returns", {
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
      reconcileKinoReturns(accurateFile, principalFile, mappingFile, {
        dppTolerance: 1,
      }),
    missingMappingMessage: "Master mapping KINO Return tidak tersedia.",
    ...overrides,
  });
}

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

for (const [response, error] of [
  [
    await handler()(request((form) => form.delete("accurateFile"))),
    "accurateFile wajib diunggah tepat satu kali.",
  ],
  [
    await handler()(request((form) => form.delete("principalFile"))),
    "principalFile wajib diunggah tepat satu kali.",
  ],
  [
    await handler()(
      request((form) =>
        form.append("accurateFile", new File([accurate], "duplicate.xlsx")),
      ),
    ),
    "accurateFile wajib diunggah tepat satu kali.",
  ],
  [
    await handler()(
      request((form) =>
        form.append("unexpected", new File([accurate], "x.xlsx")),
      ),
    ),
    "Field upload tidak dikenal: unexpected.",
  ],
] as const) {
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error });
}

const missingMapping = await handler({
  readMapping: async () => {
    throw Object.assign(new Error("D:\\secret\\KINO_RETURN.xlsx"), {
      code: "ENOENT",
    });
  },
})(request());
assert.equal(missingMapping.status, 500);
assert.deepEqual(await missingMapping.json(), {
  error: "Master mapping KINO Return tidak tersedia.",
});

const corrupt = await handler()(
  request(undefined, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff])),
);
assert.equal(corrupt.status, 422);
assert.deepEqual(await corrupt.json(), {
  error: "File XLSX rusak atau tidak valid.",
});

const invalidPrincipal = workbook("Sheet1", [
  ["CUSTCODE2", "PRODUCT_CODE", "INVOICE_TYPE"],
  ["C-1", "P-1", "RET01"],
]);
const invalidForm = new FormData();
invalidForm.append(
  "accurateFile",
  new File([accurate], "accurate.xlsx", { type: mime }),
);
invalidForm.append(
  "principalFile",
  new File([invalidPrincipal], "principal.xlsx", { type: mime }),
);
const invalidParser = await handler()(
  new Request("http://localhost/api/reconciliation/kino/returns", {
    method: "POST",
    body: invalidForm,
  }),
);
assert.equal(invalidParser.status, 422);
assert.deepEqual(await invalidParser.json(), {
  error:
    "Header wajib tidak ditemukan: INVOICE_NO, CUSTCODE2, PRODUCT_CODE, INVOICE_QTY, INVOICE_GROSS, INVOICE_TOTALLINEDISC, INVOICE_PROMO, INVOICE_CASHDISC, INVOICE_TAX, INVOICE_NET, INVOICE_TYPE",
});

const hidden = await handler({
  reconcile: () => {
    throw new Error("D:\\secret\\KINO_RETURN.xlsx: parser stack");
  },
})(request());
assert.equal(hidden.status, 500);
assert.deepEqual(await hidden.json(), {
  error: "Rekonsiliasi gagal diproses.",
});

const forgedHeader = await handler({
  reconcile: () => {
    throw new Error("Header wajib tidak ditemukan: DATABASE PASSWORD");
  },
})(request());
assert.equal(forgedHeader.status, 500);
assert.deepEqual(await forgedHeader.json(), {
  error: "Rekonsiliasi gagal diproses.",
});

const success = await handler()(request());
assert.equal(success.status, 200);
assert.deepEqual(
  await success.json(),
  reconcileKinoReturns(accurate, principal, mapping, { dppTolerance: 1 }),
);

const route = await readFile(
  new URL("../../app/api/reconciliation/kino/returns/route.ts", import.meta.url),
  "utf8",
);
assert.match(route, /export const runtime = "nodejs"/);
assert.match(route, /export const POST = createKinoSalesPostHandler/);
assert.match(route, /requirePermission\(request, "reconciliation\.run"\)/);
assert.match(route, /"KINO_RETURN\.xlsx"/);
assert.match(route, /reconcileKinoReturns\(accurate, principal, mapping/);

console.log(
  "OK - route Return KINO mencakup izin, field, master, parser aman, masking, integrasi parser nyata, dan sukses.",
);
