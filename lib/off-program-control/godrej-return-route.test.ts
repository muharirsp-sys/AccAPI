import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import { POST } from "../../app/api/reconciliation/godrej/returns/route.ts";
import { auth } from "../auth.ts";
import { db } from "../db.ts";
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

function accurate(customer = "C-ONE-GD"): Uint8Array {
  return workbook({
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
        customer,
        "G1011000001510",
        1,
        100,
        11,
        111,
        "RB/BFG-1",
        "Retur Penjualan",
      ],
    ],
  });
}

const principal = new TextEncoder().encode(
  [
    "Sale Return No.,CUSTOMER,Skunit,Quantity(Units),Amount,Sale Return State",
    'RB/BFG-1,"ONE STORE (C-ONE)",40008216 - PRODUCT ONE,1,111.555,approved',
  ].join("\r\n"),
);
const masterPath = new URL(
  "../../data/reconciliation/GODREJ_RETURN.xlsx",
  import.meta.url,
);

async function main(): Promise<void> {
const mapping = new Uint8Array(await readFile(masterPath));

function file(content: BlobPart, name: string, type: string): File {
  return new File([content], name, { type });
}

function request(
  mutate?: (form: FormData) => void,
  accurateFile = accurate(),
): Request {
  const form = new FormData();
  form.append("accurateFile", file(accurateFile, "accurate.xlsx", xlsxMime));
  form.append("principalFile", file(principal, "return.csv", "text/csv"));
  mutate?.(form);
  return new Request("http://localhost/api/reconciliation/godrej/returns", {
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
assert.deepEqual(await unauthenticated.json(), { error: "Unauthorized" });
assert.equal(parsedMultipart, false);

const forbidden = await withPermissions([], () => POST(request()));
assert.equal(forbidden.status, 403);
assert.deepEqual(await forbidden.json(), { error: "Forbidden" });

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
      form.set("accurateFile", file(accurate(), "accurate.csv", xlsxMime)),
    400,
  ],
  [
    (form: FormData) =>
      form.set("accurateFile", file(accurate(), "accurate.xlsx", "text/csv")),
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
] as const)
  assert.equal(
    await withPermissions(["reconciliation.run"], async () =>
      (await POST(request(mutate))).status,
    ),
    status,
  );

for (const type of CSV_MIME_TYPES)
  assert.equal(
    await withPermissions(["reconciliation.run"], async () =>
      (
        await POST(
          request((form) =>
            form.set("principalFile", file(principal, "return.csv", type)),
          ),
        )
      ).status,
    ),
    200,
    `CSV MIME ${type || "<empty>"}`,
  );

for (const [csv, error] of [
  [
    "CUSTOMER\r\nONE STORE",
    "Header wajib tidak ditemukan: SALE RETURN NO., CUSTOMER, SKUNIT, QUANTITY(UNITS), AMOUNT, SALE RETURN STATE",
  ],
  [
    [
      "Sale Return No.,CUSTOMER,Skunit,Quantity(Units),Amount,Sale Return State",
      'RB/BFG-1,"ONE STORE (C-ONE)",40008216 - PRODUCT ONE,NaN,111.555,approved',
    ].join("\r\n"),
    "Quantity(Units) tidak valid pada baris 2",
  ],
] as const) {
  const response = await withPermissions(["reconciliation.run"], () =>
    POST(
      request((form) =>
        form.set(
          "principalFile",
          file(new TextEncoder().encode(csv), "return.csv", "text/csv"),
        ),
      ),
    ),
  );
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error });
}

const originalCwd = process.cwd;
process.cwd = () => "D:\\definitely-missing-godrej-route-master";
try {
  const missingMaster = await withPermissions(["reconciliation.run"], () =>
    POST(request()),
  );
  assert.equal(missingMaster.status, 500);
  assert.deepEqual(await missingMaster.json(), {
    error: "Master mapping GODREJ Return tidak tersedia.",
  });
} finally {
  process.cwd = originalCwd;
}

const invalidCustomer = await withPermissions(["reconciliation.run"], () =>
  POST(request(undefined, accurate("C-ONE dan C-TWO"))),
);
assert.equal(invalidCustomer.status, 422);
assert.deepEqual(await invalidCustomer.json(), {
  error:
    "KODE PELANGGAN INDUK harus memuat tepat satu token pada baris 2",
});

function sharedHandler(message: string) {
  return createKinoSalesPostHandler({
    authorize: async () => null,
    readMapping: async () => mapping,
    reconcile: () => {
      throw new Error(message);
    },
    principalUpload: {
      kind: "csv",
      extensions: [".csv"],
      mimeTypes: CSV_MIME_TYPES,
    },
  });
}

for (const message of [
  "Header wajib tidak ditemukan: NAMA BARANG PRINCIPLE",
  "Header wajib tidak ditemukan: DATABASE PASSWORD",
  "D:\\secret\\GODREJ_RETURN.xlsx parser stack",
] as const) {
  const response = await sharedHandler(message)(request());
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Rekonsiliasi gagal diproses.",
  });
}

const success = await withPermissions(["reconciliation.run"], () =>
  POST(request()),
);
assert.equal(success.status, 200);
const expected = reconcileGodrejReturns(accurate(), principal, mapping, {
  dppTolerance: 1,
});
assert.equal(expected.summary.MATCH, 1);
assert.equal(expected.results[0].dppDifference, -0.5);
assert.deepEqual(await success.json(), expected);

console.log(
  "OK - actual POST GODREJ Return mencakup 401/403, XLSX+CSV, master, parser aman, masking, dan tolerance parity.",
);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
