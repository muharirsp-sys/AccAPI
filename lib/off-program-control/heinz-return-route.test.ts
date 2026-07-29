import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import { POST } from "../../app/api/reconciliation/heinz/returns/route.ts";
import { auth } from "../auth.ts";
import { db } from "../db.ts";
import {
  createKinoSalesPostHandler,
  CSV_MIME_TYPES,
} from "./kino-sales-route.ts";
import { reconcileHeinzReturns } from "./return-reconciliation.ts";

const xlsxMime =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function workbook(sheets: Record<string, unknown[][]>): Uint8Array {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return new Uint8Array(XLSX.write(book, { bookType: "xlsx", type: "buffer" }));
}

function csv(rows: (string | number)[][]): Uint8Array {
  return new TextEncoder().encode(
    rows
      .map((row) =>
        row
          .map((value) => {
            const text = String(value);
            return /[",\r\n]/.test(text)
              ? `"${text.replaceAll('"', '""')}"`
              : text;
          })
          .join(","),
      )
      .join("\r\n"),
  );
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
      ["RET-1", "C-A", "INT-1", 1, 100, 11, 111, "CN-1", "Retur Penjualan"],
    ],
  }),
  headerColumns = [
    "credit_note_number",
    "goods_return_note_number",
    "sales_representative_code",
    "retailer_code",
    "retailer_name",
    "credit_note_date",
    "invoice_number",
    "remarks",
    "line_count",
    "net_value",
    "status",
  ],
  detailColumns = [
    "credit_note_number",
    "line_number",
    "distributor_stock_keeping_unit",
    "unit_quantity",
    "unit",
    "eaches_quantity",
    "unit_price",
    "gross_value",
    "return_code",
  ],
  header = csv([
    headerColumns,
    [
      "CN-1",
      "GRN-1",
      "S1",
      "OLD-1",
      "TOKO A C-A",
      "2026-07-22",
      "I1",
      "",
      1,
      111,
      "Approved",
    ],
  ]),
  detail = csv([
    detailColumns,
    ["CN-1", 1, "P-1", 1, "PCS", 1, 111, 111, "R1"],
  ]),
  mapping = workbook({
    "Fix Mapping": [
      [
        "KODE BARANG",
        "PCPL KODE 1",
        "PCPL KODE 2",
        "PCPL KODE 3",
        "PCPL KODE 4",
        "PCPL KODE 5",
      ],
      ["INT-1", "P-1", 0, "", "", ""],
    ],
  });

function file(content: BlobPart, name: string, type: string): File {
  return new File([content], name, { type });
}

function request(mutate?: (form: FormData) => void): Request {
  const form = new FormData();
  form.append("accurateFile", file(accurate, "accurate.xlsx", xlsxMime));
  form.append("headerFile", file(header, "header.csv", "text/csv"));
  form.append("principalFile", file(detail, "detail.csv", "text/csv"));
  mutate?.(form);
  return new Request("http://localhost/api/reconciliation/heinz/returns", {
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
  assert.deepEqual(await unauthenticated.json(), { error: "Unauthorized" });
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
  assert.deepEqual(await forbidden.json(), { error: "Forbidden" });
  assert.equal(forbiddenParsedMultipart, false);

  for (const [mutate, status] of [
    [(form: FormData) => form.delete("accurateFile"), 400],
    [(form: FormData) => form.delete("headerFile"), 400],
    [(form: FormData) => form.delete("principalFile"), 400],
    [
      (form: FormData) =>
        form.append("headerFile", file(header, "again.csv", "text/csv")),
      400,
    ],
    [
      (form: FormData) =>
        form.append("unexpected", file(detail, "extra.csv", "text/csv")),
      400,
    ],
    [
      (form: FormData) =>
        form.set("accurateFile", file(accurate, "accurate.csv", xlsxMime)),
      400,
    ],
    [
      (form: FormData) =>
        form.set("headerFile", file(header, "header.xlsx", "text/csv")),
      400,
    ],
    [
      (form: FormData) =>
        form.set("principalFile", file(detail, "detail.csv", "image/png")),
      400,
    ],
    [
      (form: FormData) =>
        form.set("accurateFile", file("not zip", "accurate.xlsx", xlsxMime)),
      422,
    ],
    [
      (form: FormData) =>
        form.set("headerFile", file("credit_note_number\0", "header.csv", "text/csv")),
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
          "headerFile",
          file(new Uint8Array(10 * 1024 * 1024 + 1), "header.csv", "text/csv"),
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

  for (const type of CSV_MIME_TYPES) {
    const response = await withPermissions(["reconciliation.run"], () =>
      POST(
        request((form) => {
          form.set("headerFile", file(header, "header.csv", type));
          form.set("principalFile", file(detail, "detail.csv", type));
        }),
      ),
    );
    assert.equal(response.status, 200, `CSV MIME ${type || "<empty>"}`);
  }

  const badHeader = await withPermissions(["reconciliation.run"], () =>
    POST(
      request((form) =>
        form.set(
          "headerFile",
          file("credit_note_number\r\nCN-1", "header.csv", "text/csv"),
        ),
      ),
    ),
  );
  assert.equal(badHeader.status, 422);
  assert.match(
    (await badHeader.json()).error,
    /^Header wajib tidak ditemukan:/,
  );

  const invalidRetailer = await withPermissions(["reconciliation.run"], () =>
    POST(
      request((form) =>
        form.set(
          "headerFile",
          file(
            csv([
              headerColumns,
              [
                "CN-1",
                "GRN-1",
                "S1",
                "OLD-1",
                "TOKO TANPA KODE",
                "2026-07-22",
                "I1",
                "",
                1,
                111,
                "Approved",
              ],
            ]),
            "header.csv",
            "text/csv",
          ),
        ),
      ),
    ),
  );
  assert.equal(invalidRetailer.status, 422);
  assert.deepEqual(await invalidRetailer.json(), {
    error: "retailer_name harus memuat tepat satu token pada baris 2",
  });

  const originalCwd = process.cwd;
  process.cwd = () => "D:\\definitely-missing-heinz-route-master";
  try {
    const missingMaster = await withPermissions(["reconciliation.run"], () =>
      POST(request()),
    );
    assert.equal(missingMaster.status, 500);
    assert.deepEqual(await missingMaster.json(), {
      error: "Master mapping HEINZ Return tidak tersedia.",
    });
  } finally {
    process.cwd = originalCwd;
  }

  const master = new Uint8Array(
    await readFile(
      new URL("../../data/reconciliation/HEINZ_RETURN.xlsx", import.meta.url),
    ),
  );
  const sensitiveForm = await request().formData(),
    sensitiveFile = sensitiveForm.get("accurateFile");
  assert.ok(sensitiveFile instanceof File);
  Object.defineProperty(sensitiveFile, "arrayBuffer", {
    configurable: true,
    value: async () => {
      throw new Error("D:\\secret\\DATABASE_PASSWORD=local route stack");
    },
  });
  const actualRouteMasked = await withPermissions(["reconciliation.run"], () =>
    POST(
      Object.assign(new Request("http://localhost", { method: "POST" }), {
        formData: async () => sensitiveForm,
      }),
    ),
  );
  assert.equal(actualRouteMasked.status, 500);
  assert.deepEqual(await actualRouteMasked.json(), {
    error: "Rekonsiliasi gagal diproses.",
  });

  function sharedHandler(message: string) {
    return createKinoSalesPostHandler({
      authorize: async () => null,
      readMapping: async () => master,
      headerUpload: {
        kind: "csv",
        extensions: [".csv"],
        mimeTypes: CSV_MIME_TYPES,
      },
      principalUpload: {
        kind: "csv",
        extensions: [".csv"],
        mimeTypes: CSV_MIME_TYPES,
      },
      reconcile: () => {
        throw new Error(message);
      },
    });
  }

  for (const message of [
    "Header wajib tidak ditemukan: DATABASE PASSWORD",
    "D:\\secret\\HEINZ_RETURN.xlsx parser stack",
  ]) {
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
  const expected = reconcileHeinzReturns(accurate, header, detail, master, {
    dppTolerance: 1,
  });
  assert.deepEqual(await success.json(), expected);

  console.log(
    "OK - actual POST HEINZ Return mencakup auth-before-parse, tiga CSV/XLSX, upload aman, master, masking, dan parity.",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
