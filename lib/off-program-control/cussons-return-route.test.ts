import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import { POST } from "../../app/api/reconciliation/cussons/returns/route.ts";
import { auth } from "../auth.ts";
import { db } from "../db.ts";
import { CSV_MIME_TYPES } from "./kino-sales-route.ts";
import { reconcileCussonsReturns } from "./return-reconciliation.ts";

const xlsxMime =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function workbook(rows: unknown[][]): Uint8Array {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet(rows),
    "Rincian Faktur Penjualan",
  );
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

const accurate = workbook([
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
      "C-A",
      "C1011001000410",
      1,
      100,
      11,
      111,
      "CN999",
      "Retur Penjualan",
    ],
  ]),
  principalHeader = [
    "Credit Note No",
    "Customer Code",
    "Route Code",
    "Product Code",
    "Product Description",
    "UOM code",
    "Selling Type",
    "Prd Qty",
    "UOM List Price",
    "Gross Amount",
    "Discount Amount",
    "Total Amount After SKU",
    "Customer Discount Amount",
    "Total Tax Amount",
    "Total Net Amount",
    "Tax Code",
    "Tax Percentage 1",
  ],
  principalRow: (string | number)[] = [
    "CN999",
    "CT-A",
    "R-1",
    "100000425",
    "PRODUCT",
    "EA",
    "S",
    1,
    100,
    100,
    0,
    100,
    0,
    11,
    111,
    "PPN_Output",
    11,
  ],
  principal = csv([principalHeader, principalRow]);

function file(content: BlobPart, name: string, type: string): File {
  return new File([content], name, { type });
}

function request(mutate?: (form: FormData) => void): Request {
  const form = new FormData();
  form.append("accurateFile", file(accurate, "accurate.xlsx", xlsxMime));
  form.append("principalFile", file(principal, "return.csv", "text/csv"));
  mutate?.(form);
  return new Request("http://localhost/api/reconciliation/cussons/returns", {
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

  const forbidden = await withPermissions([], () => POST(request()));
  assert.equal(forbidden.status, 403);

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
        form.set("principalFile", file("Credit Note No\0", "return.csv", "text/csv")),
      422,
    ],
    [
      (form: FormData) =>
        form.set("principalFile", file("", "return.csv", "text/csv")),
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

  const badHeaders = await withPermissions(["reconciliation.run"], () =>
    POST(
      request((form) =>
        form.set(
          "principalFile",
          file("Credit Note No\r\nCN999", "return.csv", "text/csv"),
        ),
      ),
    ),
  );
  assert.equal(badHeaders.status, 422);
  assert.match((await badHeaders.json()).error, /^Header wajib tidak ditemukan:/);

  const originalCwd = process.cwd;
  process.cwd = () => "D:\\definitely-missing-cussons-route-master";
  try {
    const missingMaster = await withPermissions(["reconciliation.run"], () =>
      POST(request()),
    );
    assert.equal(missingMaster.status, 500);
    assert.deepEqual(await missingMaster.json(), {
      error: "Master mapping CUSSONS Return tidak tersedia.",
    });
  } finally {
    process.cwd = originalCwd;
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
  const masked = await withPermissions(["reconciliation.run"], () =>
    POST(
      Object.assign(new Request("http://localhost", { method: "POST" }), {
        formData: async () => sensitiveForm,
      }),
    ),
  );
  assert.equal(masked.status, 500);
  assert.deepEqual(await masked.json(), {
    error: "Rekonsiliasi gagal diproses.",
  });

  const mapping = new Uint8Array(
      await readFile(
        new URL("../../data/reconciliation/CUSSONS_RETURN.xlsx", import.meta.url),
      ),
    ),
    success = await withPermissions(["reconciliation.run"], () => POST(request()));
  assert.equal(success.status, 200);
  assert.deepEqual(
    await success.json(),
    reconcileCussonsReturns(accurate, principal, mapping, { dppTolerance: 1 }),
  );

  console.log(
    "OK - actual POST CUSSONS Return mencakup auth-before-parse, dua file, upload aman, master, parser aman, masking, dan parity.",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
