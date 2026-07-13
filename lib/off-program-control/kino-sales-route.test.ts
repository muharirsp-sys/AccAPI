import assert from "node:assert/strict";
import { authorizeThenProcess, safeParserMessage, validateUploadForm } from "./kino-sales-route.ts";

function file(name = "data.xlsx", type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content = "PK\u0003\u0004") {
  return new File([content], name, { type });
}

const valid = new FormData();
valid.append("accurateFile", file());
valid.append("principalFile", file());
assert.deepEqual(validateUploadForm(valid).map((entry) => entry.name), ["data.xlsx", "data.xlsx"]);

for (const [label, mutate, status] of [
  ["missing", (form: FormData) => form.delete("principalFile"), 400],
  ["duplicate", (form: FormData) => form.append("accurateFile", file()), 400],
  ["unknown", (form: FormData) => form.append("other", file()), 400],
  ["empty", (form: FormData) => form.set("accurateFile", file("data.xlsx", undefined, "")), 400],
  ["extension", (form: FormData) => form.set("accurateFile", file("data.xls")), 400],
  ["type", (form: FormData) => form.set("accurateFile", file("data.xlsx", "text/plain")), 400],
] as const) {
  const form = new FormData();
  form.append("accurateFile", file());
  form.append("principalFile", file());
  mutate(form);
  assert.throws(() => validateUploadForm(form), (error: unknown) => (error as { status?: number }).status === status, label);
}

assert.equal(safeParserMessage(new Error("Header wajib tidak ditemukan: ORDER_NO")), "Header wajib tidak ditemukan: ORDER_NO");
assert.equal(safeParserMessage(new Error("INVOICE_QTY tidak valid pada baris 9")), "INVOICE_QTY tidak valid pada baris 9");
assert.equal(safeParserMessage(new Error("C:\\secret\\Kino.xlsx ENOENT")), null);
assert.equal(safeParserMessage(new Error("stack or internal detail")), null);

let parsed = false;
const denied = await authorizeThenProcess(
  new Request("http://localhost", { method: "POST" }),
  async () => new Response(null, { status: 403 }),
  async () => { parsed = true; return new Response(null, { status: 200 }); },
);
assert.equal(denied.status, 403);
assert.equal(parsed, false, "multipart processing must happen after authorization");

console.log("OK — route boundary authorization, multipart contract, and safe parser errors validated.");
