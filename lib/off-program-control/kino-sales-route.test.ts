import assert from "node:assert/strict";
import { createKinoSalesPostHandler, safeParserMessage } from "./kino-sales-route.ts";

async function main(): Promise<void> {

const mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const actor = { id: "user-1", name: "Operator", email: "operator@example.com" };
const audit = {
  reconciliationKey: "sales:KINO" as const,
  startReconciliationRun: async () => "run-1",
  completeReconciliationRun: async () => {},
  failReconciliationRun: async () => {},
};
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
let recorded: {
  status?: string;
  mappingVersionId?: string;
  inputFiles: { sha256: string }[];
} = { inputFiles: [] };
const success = createKinoSalesPostHandler({
  ...audit,
  authorize: async () => ({ response: null, actor }),
  readMapping: async () => ({ id: "mapping-v2", workbook: new Uint8Array([80, 75, 3, 4]) }),
  startReconciliationRun: async (input) => {
    recorded = { status: "processing", ...input };
    return "run-1";
  },
  completeReconciliationRun: async () => { recorded.status = "success"; },
  reconcile: (accurate, principal, mapping) => { reconciledBuffers = [accurate, principal, mapping]; return successPayload; },
});
const successResponse = await success(request());
assert.equal(successResponse.status, 200);
assert.deepEqual(await successResponse.json(), successPayload);
assert.deepEqual(reconciledBuffers.map((value) => [...value.slice(0, 4)]), [[80, 75, 3, 4], [80, 75, 3, 4], [80, 75, 3, 4]]);
assert.equal(recorded.status, "success");
assert.equal(recorded.mappingVersionId, "mapping-v2");
assert.deepEqual(recorded.inputFiles.map(file => file.sha256.length), [64, 64]);

let readAfterDenial = false;
const denied = createKinoSalesPostHandler({
  ...audit,
  authorize: async () => ({ response: Response.json({ error: "Forbidden" }, { status: 403 }), actor: null }),
  readMapping: async () => { readAfterDenial = true; return null; },
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

let readOversized = false;
const oversized = createKinoSalesPostHandler({
  ...audit,
  authorize: async () => ({ response: null, actor }),
  readMapping: async () => ({ id: "mapping-v2", workbook: new Uint8Array() }),
  headerUpload: { kind: "csv" },
  principalUpload: { kind: "csv" },
  reconcile: () => null,
});
const oversizedForm = new FormData();
const oversizedAccurate = file();
let accurateSizeReads = 0;
Object.defineProperty(oversizedAccurate, "size", { get: () => ++accurateSizeReads <= 2 ? 10 * 1024 * 1024 : 11 * 1024 * 1024 });
Object.defineProperty(oversizedAccurate, "arrayBuffer", { value: async () => { readOversized = true; return new ArrayBuffer(0); } });
const oversizedHeader = file("csv", "header.csv", "text/csv");
const oversizedPrincipal = file("csv", "detail.csv", "text/csv");
for (const csvFile of [oversizedHeader, oversizedPrincipal]) {
  Object.defineProperty(csvFile, "size", { value: 10 * 1024 * 1024 });
  Object.defineProperty(csvFile, "arrayBuffer", { value: async () => { readOversized = true; return new ArrayBuffer(0); } });
}
oversizedForm.append("accurateFile", oversizedAccurate);
oversizedForm.append("headerFile", oversizedHeader);
oversizedForm.append("principalFile", oversizedPrincipal);
assert.equal((await oversized(Object.assign(new Request("http://localhost", { method: "POST" }), { formData: async () => oversizedForm }))).status, 413);
assert.equal(readOversized, false);

const missingMaster = createKinoSalesPostHandler({
  ...audit,
  authorize: async () => ({ response: null, actor }),
  readMapping: async () => null,
  reconcile: () => null,
});
const missingResponse = await missingMaster(request());
assert.equal(missingResponse.status, 422);
assert.deepEqual(await missingResponse.json(), { error: "Master mapping KINO untuk divisi sales tidak tersedia." });

let failedStatus = "processing";
const reconciliationFailure = createKinoSalesPostHandler({
  ...audit,
  authorize: async () => ({ response: null, actor }),
  readMapping: async () => ({ id: "mapping-v2", workbook: new Uint8Array([80, 75, 3, 4]) }),
  failReconciliationRun: async () => { failedStatus = "failed"; },
  reconcile: () => { throw new Error("parser exploded"); },
});
assert.equal((await reconciliationFailure(request())).status, 500);
assert.equal(failedStatus, "failed");

const auditFailure = createKinoSalesPostHandler({
  ...audit,
  authorize: async () => ({ response: null, actor }),
  readMapping: async () => ({ id: "mapping-v2", workbook: new Uint8Array([80, 75, 3, 4]) }),
  completeReconciliationRun: async () => { throw new Error("database unavailable"); },
  reconcile: () => successPayload,
});
const auditFailureResponse = await auditFailure(request());
assert.equal(auditFailureResponse.status, 500);
assert.deepEqual(await auditFailureResponse.json(), { error: "Rekonsiliasi gagal diproses." });

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
  const handler = createKinoSalesPostHandler({ ...audit, authorize: async () => ({ response: null, actor }), readMapping: async () => ({ id: "mapping-v2", workbook: new Uint8Array() }), reconcile: () => { throw new Error(message); } });
  const response = await handler(request());
  assert.equal(response.status, expected === message ? 422 : 500);
  assert.deepEqual(await response.json(), { error: expected });
}

console.log("OK — actual KINO POST handler covers auth, multipart, size, ZIP, master, masking, parser, and success parity.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
