import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import { POST } from "../../app/api/reconciliation/reckitt/purchases/route.ts";
import { auth } from "../auth.ts";
import { db } from "../db.ts";
import { reconciliationStore } from "./reconciliation-store.ts";

const xlsxMime =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function workbook(sheet: string, rows: unknown[][]): Uint8Array {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheet);
  return new Uint8Array(XLSX.write(book, { bookType: "xlsx", type: "buffer" }));
}

const accurate = workbook("Rincian Faktur Pembelian", [
    ["NO. PEMBELIAN", "KODE BARANG", "QTY", "SATUAN", "DPP", "PPN", "REM"],
    ["LPB-1", "R1054001000010", 1, "KRT", 100, 11, "2100000001"],
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
      ["2100000001", "3300965", "CAR", "EA", 1, 1, 100, 0, 0, 0, 0, 100, 11, 11],
    ]
      .map((row) => row.join("|"))
      .join("\n"),
  );

function file(content: BlobPart, name: string, type = xlsxMime): File {
  return new File([content], name, { type });
}

function request(mutate?: (form: FormData) => void): Request {
  const form = new FormData();
  form.append("accurateFile", file(accurate, "accurate.xlsx"));
  form.append("principalFile", file(principal, "TXN_COMPINV_DTL.csv", "text/csv"));
  mutate?.(form);
  return new Request("http://localhost/api/reconciliation/reckitt/purchases", {
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

async function main(): Promise<void> {
  const mapping = new Uint8Array(
    await readFile(new URL("../../data/reconciliation/RECKITT_PURCHASE.xlsx", import.meta.url)),
  );
  let activeMapping: Uint8Array | null = mapping;
  Object.defineProperties(reconciliationStore, {
    getActiveMapping: { configurable: true, value: async () => activeMapping ? { id: "mapping-v2", workbook: Buffer.from(activeMapping) } : null },
    startReconciliationRun: { configurable: true, value: async () => "run-1" },
    completeReconciliationRun: { configurable: true, value: async () => {} },
    failReconciliationRun: { configurable: true, value: async () => {} },
  });
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
        form.set(
          "principalFile",
          file(new Uint8Array(10 * 1024 * 1024 + 1), "detail.csv", "text/csv"),
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

  const malformedAccurate = workbook("Rincian Faktur Pembelian", [
    ["NO. PEMBELIAN", "KODE BARANG"],
    ["LPB-1", "R1054001000010"],
  ]);
  const accurateParserResponse = await withPermissions(
    ["reconciliation.run"],
    () =>
      POST(
        request((form) =>
          form.set("accurateFile", file(malformedAccurate, "accurate.xlsx")),
        ),
      ),
  );
  assert.equal(accurateParserResponse.status, 422);
  assert.deepEqual(await accurateParserResponse.json(), {
    error:
      "Header wajib tidak ditemukan: NO. PEMBELIAN, KODE BARANG, QTY, SATUAN, DPP, PPN, REM",
  });

  const malformedPrincipal = Buffer.from("Invoice No|Product Code\n2100000001|3300965");
  const principalParserResponse = await withPermissions(
    ["reconciliation.run"],
    () =>
      POST(
        request((form) =>
          form.set(
            "principalFile",
            file(malformedPrincipal, "detail.csv", "text/csv"),
          ),
        ),
      ),
  );
  assert.equal(principalParserResponse.status, 422);
  assert.deepEqual(await principalParserResponse.json(), {
    error: `Header wajib tidak ditemukan: ${principalHeaders.join(", ")}`,
  });

  const previousMapping = activeMapping;
  activeMapping = null;
  try {
    const missingMaster = await withPermissions(["reconciliation.run"], () =>
      POST(request()),
    );
    assert.equal(missingMaster.status, 422);
    assert.deepEqual(await missingMaster.json(), {
      error: "Master mapping RECKITT Purchase tidak tersedia.",
    });
  } finally {
    activeMapping = previousMapping;
  }

  activeMapping = Buffer.from("PK\u0003\u0004corrupt internal D:\\secret\\master.xlsx");
  try {
    const corruptMaster = await withPermissions(["reconciliation.run"], () =>
      POST(request()),
    );
    assert.equal(corruptMaster.status, 500);
    assert.deepEqual(await corruptMaster.json(), {
      error: "Rekonsiliasi gagal diproses.",
    });
  } finally {
    activeMapping = previousMapping;
  }

  const sensitiveForm = await request().formData(),
    sensitiveFile = sensitiveForm.get("accurateFile");
  assert.ok(sensitiveFile instanceof File);
  Object.defineProperty(sensitiveFile, "arrayBuffer", {
    configurable: true,
    value: async () => {
      throw new Error("D:\\secret\\DATABASE_PASSWORD=local route stack");
    },
  });
  const unknownError = await withPermissions(["reconciliation.run"], () =>
    POST(
      Object.assign(new Request("http://localhost", { method: "POST" }), {
        formData: async () => sensitiveForm,
      }),
    ),
  );
  assert.equal(unknownError.status, 500);
  assert.deepEqual(await unknownError.json(), {
    error: "Rekonsiliasi gagal diproses.",
  });

  const success = await withPermissions(["reconciliation.run"], () =>
    POST(request()),
  );
  assert.equal(success.status, 200);
  const body = (await success.json()) as {
    summary: Record<string, number>;
    results: Array<Record<string, unknown>>;
  };
  assert.equal(body.summary.MATCH, 1);
  assert.equal(body.results[0]?.invoiceNumber, "2100000001");
  assert.equal(body.results[0]?.accurateQuantity, 1);
  assert.equal(body.results[0]?.principalQuantity, 1);

  console.log(
    "reckitt purchase route: auth, upload contract, safe errors, master masking, and success ok",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
