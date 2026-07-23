import assert from "node:assert/strict";
import { createKinoSalesPostHandler } from "./kino-sales-route.ts";

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

console.log(
  "OK - route Return SHINZUI mencakup izin, field, master, parser aman, masking, dan sukses.",
);
