import assert from "node:assert/strict";
import { POST } from "../../app/api/reconciliation/godrej/purchases/route.ts";
import { auth } from "../auth.ts";
import { db } from "../db.ts";
import { createKinoSalesPostHandler } from "./kino-sales-route.ts";
import * as XLSX from "xlsx";

const xlsxMime =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function workbook(sheet: string, rows: unknown[][]): Uint8Array {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheet);
  return new Uint8Array(XLSX.write(book, { bookType: "xlsx", type: "buffer" }));
}

const accurate = workbook("Rincian Faktur Pembelian", [
  ["NO. PEMBELIAN", "KODE BARANG", "QTY", "SATUAN", "DPP", "REM"],
  ["LPB-1", "G1011000001510", 1, "KRT", 100, "DMS Bill 1"],
]);
const principal = workbook("Sheet1", [
  [
    "Invoice_Number",
    "Bill_No",
    "Approved",
    "Amount_Uploaded",
    "Quantity_in_Units",
    "Quantity_Uploaded",
    "Qty_Approved",
    "Sku_Name",
  ],
  ["1", "1", "Approved", 111, 144, 144, 144, "AUTOSOL Metal Polish 15 gr"],
]);

function file(content: BlobPart, name: string, type = xlsxMime): File {
  return new File([content], name, { type });
}

function request(mutate?: (form: FormData) => void): Request {
  const form = new FormData();
  form.append("accurateFile", file(accurate, "accurate.xlsx"));
  form.append("principalFile", file(principal, "grn.xlsx"));
  mutate?.(form);
  return new Request("http://localhost/api/reconciliation/godrej/purchases", {
    method: "POST",
    body: form,
  });
}

async function withPermissions<T>(
  permissions: string[],
  action: () => Promise<T>,
): Promise<T> {
  const sessionDescriptor = Object.getOwnPropertyDescriptor(
      auth.api,
      "getSession",
    ),
    selectDescriptor = Object.getOwnPropertyDescriptor(db, "select");
  let selectCall = 0;
  Object.defineProperty(auth.api, "getSession", {
    configurable: true,
    value: async () => ({
      session: {
        id: "route-test-session",
        userId: "route-test-user",
        expiresAt: new Date(Date.now() + 60_000),
        token: "route-test-token",
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: null,
        userAgent: null,
      },
      user: {
        id: "route-test-user",
        name: "Route Test",
        email: "route@example.test",
        emailVerified: true,
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    }),
  });
  Object.defineProperty(db, "select", {
    configurable: true,
    value: () => ({
      from: () => ({
        where: () =>
          Promise.resolve(
            selectCall++ === 0
              ? [{ groupId: "route-test-group" }]
              : permissions.map((key) => ({ key })),
          ),
      }),
    }),
  });
  try {
    return await action();
  } finally {
    if (sessionDescriptor)
      Object.defineProperty(auth.api, "getSession", sessionDescriptor);
    else delete (auth.api as { getSession?: unknown }).getSession;
    if (selectDescriptor) Object.defineProperty(db, "select", selectDescriptor);
    else delete (db as { select?: unknown }).select;
  }
}

async function main(): Promise<void> {
let parsedMultipart = false;
const unauthenticated = await POST(
  Object.assign(new Request("http://localhost", { method: "POST" }), {
    formData: async () => {
      parsedMultipart = true;
      throw new Error("multipart tidak boleh dibaca");
    },
  }),
);
assert.equal(unauthenticated.status, 401);
assert.equal(parsedMultipart, false);
assert.equal((await withPermissions([], () => POST(request()))).status, 403);

for (const [mutate, status] of [
  [(form: FormData) => form.delete("accurateFile"), 400],
  [(form: FormData) => form.delete("principalFile"), 400],
  [
    (form: FormData) =>
      form.append("principalFile", file(principal, "again.xlsx")),
    400,
  ],
  [
    (form: FormData) =>
      form.append("unexpected", file(principal, "extra.xlsx")),
    400,
  ],
  [
    (form: FormData) =>
      form.set("accurateFile", file(accurate, "accurate.csv")),
    400,
  ],
  [
    (form: FormData) =>
      form.set("principalFile", file(principal, "grn.csv")),
    400,
  ],
  [
    (form: FormData) =>
      form.set("accurateFile", file(accurate, "accurate.xlsx", "text/csv")),
    400,
  ],
  [
    (form: FormData) =>
      form.set("principalFile", file(principal, "grn.xlsx", "text/csv")),
    400,
  ],
  [
    (form: FormData) =>
      form.set(
        "principalFile",
        file(new Uint8Array(10 * 1024 * 1024 + 1), "grn.xlsx"),
      ),
    413,
  ],
  [
    (form: FormData) =>
      form.set("principalFile", file("not zip", "grn.xlsx")),
    422,
  ],
] as const)
  assert.equal(
    await withPermissions(["reconciliation.run"], async () =>
      (await POST(request(mutate))).status,
    ),
    status,
  );

const originalCwd = process.cwd;
process.cwd = () => "D:\\definitely-missing-godrej-purchase-master";
try {
  const response = await withPermissions(["reconciliation.run"], () =>
    POST(request()),
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Master mapping GODREJ Purchase tidak tersedia.",
  });
} finally {
  process.cwd = originalCwd;
}

function parserResponse(message: string): Promise<Response> {
  return createKinoSalesPostHandler({
    authorize: async () => null,
    readMapping: async () => new Uint8Array(),
    reconcile: () => {
      throw new Error(message);
    },
  })(request());
}

const knownGodrejMessage =
  "Invoice_Number dan Bill_No tidak konsisten pada baris 2";
const malformedPrincipal = workbook("Sheet1", [
  [
    "Invoice_Number",
    "Bill_No",
    "Approved",
    "Amount_Uploaded",
    "Quantity_in_Units",
    "Quantity_Uploaded",
    "Qty_Approved",
    "Sku_Name",
  ],
  ["1", "2", "Approved", 111, 144, 144, 144, "AUTOSOL Metal Polish 15 gr"],
]);
const godrejParserResponse = await withPermissions(
  ["reconciliation.run"],
  () =>
    POST(
      request((form) =>
        form.set("principalFile", file(malformedPrincipal, "grn.xlsx")),
      ),
    ),
);
assert.equal(godrejParserResponse.status, 422);
assert.deepEqual(await godrejParserResponse.json(), {
  error: knownGodrejMessage,
});

const unrelatedResponse = await parserResponse(knownGodrejMessage);
assert.equal(unrelatedResponse.status, 500);
assert.deepEqual(await unrelatedResponse.json(), {
  error: "Rekonsiliasi gagal diproses.",
});

for (const message of [
  "Header wajib tidak ditemukan: DATABASE_PASSWORD",
  "D:\\secret\\GODREJ_RETURN.xlsx parser stack",
] as const) {
  const response = await parserResponse(message);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Rekonsiliasi gagal diproses.",
  });
}

const success = await withPermissions(["reconciliation.run"], () =>
  POST(request()),
);
assert.equal(success.status, 200);
const body = (await success.json()) as {
  summary: Record<string, number>;
  results: Array<Record<string, unknown>>;
};
assert.equal(body.summary.MATCH, 1);
assert.equal(body.results[0]?.invoiceNumber, "1");
assert.equal(body.results[0]?.accurateQuantity, 144);
assert.equal(body.results[0]?.principalQuantity, 144);

console.log(
  "OK - POST GODREJ Purchase mencakup auth, upload XLSX, master, parser aman, dan respons engine.",
);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
