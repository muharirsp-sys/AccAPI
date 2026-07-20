import assert from "node:assert/strict";
import {
  createKinoSalesPostHandler,
  CSV_MIME_TYPES,
} from "./kino-sales-route.ts";

const xlsxMime =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const csv = "Invoice No,Product Code\r\nTI125970,100113936\r\n";

function file(
  content: BlobPart,
  name: string,
  type: string,
): File {
  return new File([content], name, { type });
}

function request(mutate?: (form: FormData) => void): Request {
  const form = new FormData();
  form.append("accurateFile", file("PK\u0003\u0004", "accurate.xlsx", xlsxMime));
  form.append("principalFile", file(csv, "detail.csv", "text/csv"));
  mutate?.(form);
  return new Request("http://localhost/api/reconciliation/cussons/sales", {
    method: "POST",
    body: form,
  });
}

let buffers: Uint8Array[] = [];
const handler = createKinoSalesPostHandler({
  authorize: async () => null,
  readMapping: async () => new Uint8Array([1, 2, 3]),
  reconcile: (accurate, principal, mapping) => {
    buffers = [accurate, principal, mapping];
    return { ok: true };
  },
  principalUpload: {
    kind: "csv",
    extensions: [".csv"],
    mimeTypes: CSV_MIME_TYPES,
  },
});

const success = await handler(request());
assert.equal(success.status, 200);
assert.deepEqual(await success.json(), { ok: true });
assert.deepEqual([...buffers[0].slice(0, 4)], [80, 75, 3, 4]);
assert.equal(new TextDecoder().decode(buffers[1]), csv);
assert.deepEqual([...buffers[2]], [1, 2, 3]);

let readAfterDenial = false;
const denied = createKinoSalesPostHandler({
  authorize: async () => Response.json({ error: "Forbidden" }, { status: 403 }),
  readMapping: async () => {
    readAfterDenial = true;
    return new Uint8Array();
  },
  reconcile: () => null,
  principalUpload: { kind: "csv" },
});
assert.equal((await denied(new Request("http://localhost"))).status, 403);
assert.equal(readAfterDenial, false);

async function responseFor(mutate: (form: FormData) => void): Promise<Response> {
  return handler(request(mutate));
}

for (const mutate of [
  (form: FormData) => form.delete("principalFile"),
  (form: FormData) => form.append("principalFile", file(csv, "detail.csv", "text/csv")),
  (form: FormData) => form.append("unknown", file(csv, "detail.csv", "text/csv")),
  (form: FormData) => form.set("principalFile", file(csv, "detail.xlsx", "text/csv")),
  (form: FormData) => form.set("principalFile", file(csv, "detail.csv", "image/png")),
])
  assert.equal((await responseFor(mutate)).status, 400);

assert.equal(
  (
    await responseFor((form) =>
      form.set(
        "principalFile",
        file(new Uint8Array(10 * 1024 * 1024 + 1), "detail.csv", "text/csv"),
      ),
    )
  ).status,
  413,
);
assert.equal(
  (await responseFor((form) => form.set("accurateFile", file("bad", "accurate.xlsx", xlsxMime)))).status,
  422,
);
for (const content of ["", "Invoice No\u0000,Product Code\r\n"]) {
  const response = await responseFor((form) =>
    form.set("principalFile", file(content, "detail.csv", "text/csv")),
  );
  assert.equal(response.status, 422);
}

for (const type of CSV_MIME_TYPES) {
  const response = await responseFor((form) =>
    form.set("principalFile", file(csv, "detail.csv", type)),
  );
  assert.equal(response.status, 200, `CSV MIME ${type || "<empty>"}`);
}

for (const message of [
  "Header wajib tidak ditemukan: INVOICE NO",
  "Product Quantity tidak valid pada baris 2",
  "File CSV kosong",
]) {
  const parser = createKinoSalesPostHandler({
    authorize: async () => null,
    readMapping: async () => new Uint8Array(),
    reconcile: () => {
      throw new Error(message);
    },
    principalUpload: { kind: "csv" },
  });
  const response = await parser(request());
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: message });
}

const hiddenMaster = createKinoSalesPostHandler({
  authorize: async () => null,
  readMapping: async () => {
    throw Object.assign(new Error("C:\\secret\\CUSSONS.xlsx"), { code: "ENOENT" });
  },
  reconcile: () => null,
  principalUpload: { kind: "csv" },
  missingMappingMessage: "Master mapping CUSSONS belum tersedia.",
});
const hiddenResponse = await hiddenMaster(request());
assert.equal(hiddenResponse.status, 500);
assert.deepEqual(await hiddenResponse.json(), {
  error: "Master mapping CUSSONS belum tersedia.",
});

const masked = createKinoSalesPostHandler({
  authorize: async () => null,
  readMapping: async () => new Uint8Array(),
  reconcile: () => {
    throw new Error("C:\\secret\\CUSSONS.xlsx parser stack");
  },
  principalUpload: { kind: "csv" },
});
const maskedResponse = await masked(request());
assert.equal(maskedResponse.status, 500);
assert.deepEqual(await maskedResponse.json(), {
  error: "Rekonsiliasi gagal diproses.",
});

console.log("OK - route CUSSONS memvalidasi XLSX + CSV dan menutup detail internal.");
