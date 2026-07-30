import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import { POST } from "../../app/api/reconciliation/cussons/purchases/route.ts";
import { auth } from "../auth.ts";
import { db } from "../db.ts";
import { reconcileCussonsPurchases } from "./purchase-reconciliation.ts";

const xlsxMime =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function workbook(sheet: string, rows: unknown[][]): Uint8Array {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheet);
  return new Uint8Array(XLSX.write(book, { bookType: "xlsx", type: "buffer" }));
}

const accurate = workbook("Rincian Faktur Pembelian", [
    ["NO. PEMBELIAN", "KODE BARANG", "QTY", "SATUAN", "DPP", "PPN", "REM"],
    ["LPB-1", "WIN-A", 1, "KRT", 100, 11, "DO 100000001"],
  ]),
  principalHeaders = [
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
  principal = Buffer.from(
    [
      principalHeaders,
      ["100000001", "PC-A", "CS", "EA", 1, 1, 100, 0, 0, 0, 0, 100, 11, 11],
    ]
      .map((row) => row.join(","))
      .join("\r\n"),
  ),
  mapping = workbook("Form Fix", [
    [],
    [],
    [],
    [],
    ["KODE PCPL", "ISI/CTN", "SATUAN FIX WIN", "KODE BARANG WIN2"],
    ["PC-A", 1, "PCS", "WIN-A"],
  ]);

function file(content: BlobPart, name: string, type = xlsxMime): File {
  return new File([content], name, { type });
}

function request(mutate?: (form: FormData) => void): Request {
  const form = new FormData();
  form.append("accurateFile", file(accurate, "accurate.xlsx"));
  form.append("principalFile", file(principal, "TXN_COMPINV_DTL.csv", "text/csv"));
  mutate?.(form);
  return new Request("http://localhost/api/reconciliation/cussons/purchases", {
    method: "POST",
    body: form,
  });
}

async function withPermissions<T>(
  permissions: string[],
  action: () => Promise<T>,
): Promise<T> {
  const sessionDescriptor = Object.getOwnPropertyDescriptor(auth.api, "getSession"),
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

async function withMaster<T>(
  content: Uint8Array,
  action: () => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "cussons-purchase-route-")),
    originalCwd = process.cwd;
  await mkdir(path.join(root, "data", "reconciliation"), { recursive: true });
  await writeFile(
    path.join(root, "data", "reconciliation", "CUSSONS_RETURN.xlsx"),
    content,
  );
  process.cwd = () => root;
  try {
    return await action();
  } finally {
    process.cwd = originalCwd;
    await rm(root, { recursive: true, force: true });
  }
}

async function post(mutate?: (form: FormData) => void): Promise<Response> {
  return withPermissions(["reconciliation.run"], () => POST(request(mutate)));
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

  let forbiddenParsedMultipart = false;
  const forbidden = await withPermissions([], () =>
    POST(
      Object.assign(new Request("http://localhost", { method: "POST" }), {
        formData: async () => {
          forbiddenParsedMultipart = true;
          throw new Error("multipart tidak boleh dibaca");
        },
      }),
    ),
  );
  assert.equal(forbidden.status, 403);
  assert.equal(forbiddenParsedMultipart, false);

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
        form.set("accurateFile", file(accurate, "accurate.csv")),
      400,
    ],
    [
      (form: FormData) =>
        form.set("principalFile", file(principal, "detail.xlsx", "text/csv")),
      400,
    ],
    [
      (form: FormData) =>
        form.set("accurateFile", file(accurate, "accurate.xlsx", "text/csv")),
      400,
    ],
    [
      (form: FormData) =>
        form.set("principalFile", file(principal, "detail.csv", xlsxMime)),
      400,
    ],
    [
      (form: FormData) =>
        form.set(
          "accurateFile",
          file(new Uint8Array(10 * 1024 * 1024 + 1), "accurate.xlsx"),
        ),
      413,
    ],
    [
      (form: FormData) =>
        form.set(
          "principalFile",
          file(new Uint8Array(10 * 1024 * 1024 + 1), "detail.csv", "text/csv"),
        ),
      413,
    ],
    [
      (form: FormData) =>
        form.set("accurateFile", file("not zip", "accurate.xlsx")),
      422,
    ],
    [
      (form: FormData) =>
        form.set("principalFile", file("", "detail.csv", "text/csv")),
      422,
    ],
    [
      (form: FormData) =>
        form.set("principalFile", file("Invoice No\0", "detail.csv", "text/csv")),
      422,
    ],
  ] as const)
    assert.equal((await post(mutate)).status, status);

  const malformedAccurate = workbook("Rincian Faktur Pembelian", [
    ["NO. PEMBELIAN", "KODE BARANG"],
    ["LPB-1", "WIN-A"],
  ]);
  const accurateParserResponse = await withMaster(mapping, () =>
    post((form) =>
      form.set("accurateFile", file(malformedAccurate, "accurate.xlsx")),
    ),
  );
  assert.equal(accurateParserResponse.status, 422);
  assert.deepEqual(await accurateParserResponse.json(), {
    error:
      "Header wajib tidak ditemukan: NO. PEMBELIAN, KODE BARANG, QTY, SATUAN, DPP, PPN, REM",
  });

  const malformedPrincipal = Buffer.from("Invoice No,Product Code\r\n100000001,PC-A");
  const principalParserResponse = await withMaster(mapping, () =>
    post((form) =>
      form.set(
        "principalFile",
        file(malformedPrincipal, "detail.csv", "text/csv"),
      ),
    ),
  );
  assert.equal(principalParserResponse.status, 422);
  assert.deepEqual(await principalParserResponse.json(), {
    error: `Header wajib tidak ditemukan: ${principalHeaders.join(", ")}`,
  });

  for (const [mutate, message] of [
    [
      (form: FormData) =>
        form.set(
          "accurateFile",
          file(
            workbook("Rincian Faktur Pembelian", [
              [
                "NO. PEMBELIAN",
                "KODE BARANG",
                "QTY",
                "QTY",
                "SATUAN",
                "DPP",
                "PPN",
                "REM",
              ],
              ["LPB-1", "WIN-A", 1, 1, "KRT", 100, 11, "DO 100000001"],
            ]),
            "accurate.xlsx",
          ),
        ),
      "Header duplikat: QTY",
    ],
    [
      (form: FormData) =>
        form.set(
          "principalFile",
          file(
            Buffer.from(
              [[...principalHeaders, "Invoice No"], [...principalHeaders.map(() => ""), ""]]
                .map((row) => row.join(","))
                .join("\r\n"),
            ),
            "detail.csv",
            "text/csv",
          ),
        ),
      "Header duplikat: Invoice No",
    ],
  ] as const) {
    const response = await withMaster(mapping, () => post(mutate));
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: message });
  }

  const originalCwd = process.cwd;
  process.cwd = () => "D:\\definitely-missing-cussons-purchase-master";
  try {
    const missingMaster = await post();
    assert.equal(missingMaster.status, 500);
    assert.deepEqual(await missingMaster.json(), {
      error: "Master mapping CUSSONS Purchase tidak tersedia.",
    });
  } finally {
    process.cwd = originalCwd;
  }

  for (const invalidMaster of [
    new TextEncoder().encode("PK\u0003\u0004corrupt D:\\secret\\master.xlsx"),
    workbook("Wrong Sheet", [["KODE PCPL"]]),
    workbook("Form Fix", [
      [],
      [],
      [],
      [],
      ["KODE PCPL", "WRONG HEADER"],
    ]),
  ]) {
    const response = await withMaster(invalidMaster, () => post());
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "Rekonsiliasi gagal diproses.",
    });
  }

  const success = await withMaster(mapping, () => post());
  assert.equal(success.status, 200);
  assert.deepEqual(
    await success.json(),
    reconcileCussonsPurchases(accurate, principal, mapping, { dppTolerance: 1 }),
  );

  console.log(
    "cussons purchase route: auth-first, upload contract, safe errors, exact master path, masking, engine, and success ok",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
