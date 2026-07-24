import assert from "node:assert/strict";
import { createKinoSalesPostHandler, safeParserMessage } from "./kino-sales-route.ts";

const mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
function file(content: BlobPart = "PK\u0003\u0004", name = "data.xlsx", type = mime) {
  return new File([content], name, { type });
}
function request(mutate?: (form: FormData) => void): Request {
  const form = new FormData();
  form.append("accurateFile", file());
  form.append("principalFile", file());
  mutate?.(form);
  return new Request("http://localhost/api/reconciliation/kino/sales", { method: "POST", body: form });
}

assert.equal(safeParserMessage(new Error("FLAG_BONUS harus Y/N pada baris 9")), "FLAG_BONUS harus Y/N pada baris 9");
assert.equal(
  safeParserMessage(new Error("Tipe harus SD pada baris 2")),
  "Tipe harus SD pada baris 2",
);
assert.equal(
  safeParserMessage(
    new Error("DISC. 1 harus antara 0 dan 100 pada baris 2"),
  ),
  "DISC. 1 harus antara 0 dan 100 pada baris 2",
);
assert.equal(
  safeParserMessage(new Error("D:\\secret\\MOTASA.xlsx parser stack")),
  null,
);
assert.equal(safeParserMessage(new Error("C:\\secret\\Kino.xlsx ENOENT")), null);
assert.equal(safeParserMessage(new Error("stack or internal detail")), null);

const successPayload = { summary: { MATCH: 1 }, results: [{ status: "MATCH" }] };
let reconciledBuffers: Uint8Array[] = [];
const success = createKinoSalesPostHandler({
  authorize: async () => null,
  readMapping: async () => new Uint8Array([80, 75, 3, 4]),
  reconcile: (accurate, principal, mapping) => { reconciledBuffers = [accurate, principal, mapping]; return successPayload; },
});
const successResponse = await success(request());
assert.equal(successResponse.status, 200);
assert.deepEqual(await successResponse.json(), successPayload);
assert.deepEqual(reconciledBuffers.map((value) => [...value.slice(0, 4)]), [[80, 75, 3, 4], [80, 75, 3, 4], [80, 75, 3, 4]]);

let readAfterDenial = false;
const denied = createKinoSalesPostHandler({
  authorize: async () => Response.json({ error: "Forbidden" }, { status: 403 }),
  readMapping: async () => { readAfterDenial = true; return new Uint8Array(); },
  reconcile: () => null,
});
assert.equal((await denied(new Request("http://localhost", { method: "POST" }))).status, 403);
assert.equal(readAfterDenial, false);

async function statusFor(mutate: (form: FormData) => void): Promise<number> {
  return (await success(request(mutate))).status;
}
assert.equal(await statusFor((form) => form.append("accurateFile", file())), 400);
assert.equal(await statusFor((form) => form.append("unexpected", file())), 400);
assert.equal(await statusFor((form) => form.set("accurateFile", file(new Uint8Array(10 * 1024 * 1024 + 1)))), 413);
assert.equal(await statusFor((form) => form.set("accurateFile", file("not zip"))), 422);

const missingMaster = createKinoSalesPostHandler({
  authorize: async () => null,
  readMapping: async () => { throw Object.assign(new Error("C:\\secret\\Kino.xlsx"), { code: "ENOENT" }); },
  reconcile: () => null,
});
const missingResponse = await missingMaster(request());
assert.equal(missingResponse.status, 500);
assert.deepEqual(await missingResponse.json(), { error: "Master mapping KINO tidak tersedia." });

for (const [message, expected] of [
  ["FLAG_BONUS harus Y/N pada baris 9", "FLAG_BONUS harus Y/N pada baris 9"],
  ["Pvt Map 1 tidak lengkap pada baris 12", "Pvt Map 1 tidak lengkap pada baris 12"],
  ["IV_DISC2 belum memiliki aturan pada baris 7", "IV_DISC2 belum memiliki aturan pada baris 7"],
  ["Nilai GDI tidak valid pada baris 18", "Nilai GDI tidak valid pada baris 18"],
  [
    "Header wajib tidak ditemukan: IV_NO, IV_DATE, CS_NO, PS_NO, INV_NO, IV_TOTPCS, IV_PRICE, IV_DISC1, IV_FRA",
    "Header wajib tidak ditemukan: IV_NO, IV_DATE, CS_NO, PS_NO, INV_NO, IV_TOTPCS, IV_PRICE, IV_DISC1, IV_FRA",
  ],
  [
    "Header wajib tidak ditemukan: KODE ITEM, KODE ALIAS, SATUAN",
    "Header wajib tidak ditemukan: KODE ITEM, KODE ALIAS, SATUAN",
  ],
  [
    "Header wajib tidak ditemukan: CODE KINO, CODE INTERNAL",
    "Header wajib tidak ditemukan: CODE KINO, CODE INTERNAL",
  ],
  [
    "Header wajib tidak ditemukan: SLSMAN_ID, CODE INTERNAL",
    "Header wajib tidak ditemukan: SLSMAN_ID, CODE INTERNAL",
  ],
  [
    "Header wajib tidak ditemukan: DATABASE PASSWORD",
    "Rekonsiliasi gagal diproses.",
  ],
  ["C:\\secret\\stack internal", "Rekonsiliasi gagal diproses."],
] as const) {
  const handler = createKinoSalesPostHandler({ authorize: async () => null, readMapping: async () => new Uint8Array(), reconcile: () => { throw new Error(message); } });
  const response = await handler(request());
  assert.equal(response.status, expected === message ? 422 : 500);
  assert.deepEqual(await response.json(), { error: expected });
}

console.log("OK — actual KINO POST handler covers auth, multipart, size, ZIP, master, masking, parser, and success parity.");
