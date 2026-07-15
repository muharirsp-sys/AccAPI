import assert from "node:assert/strict";
import { createKinoSalesPostHandler } from "./kino-sales-route.ts";

const form = new FormData();
const mime =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
form.append(
  "accurateFile",
  new File(["PK\u0003\u0004"], "accurate.xlsx", { type: mime }),
);
form.append(
  "principalFile",
  new File(["PK\u0003\u0004"], "gdi.xlsx", { type: mime }),
);

const handler = createKinoSalesPostHandler({
  authorize: async () => null,
  readMapping: async () => {
    throw Object.assign(new Error("hidden path"), { code: "ENOENT" });
  },
  reconcile: () => null,
  missingMappingMessage: "Master mapping GODREJ tidak tersedia.",
});
const response = await handler(
  new Request("http://localhost/api/reconciliation/godrej/sales", {
    method: "POST",
    body: form,
  }),
);
assert.equal(response.status, 500);
assert.deepEqual(await response.json(), {
  error: "Master mapping GODREJ tidak tersedia.",
});

console.log(
  "OK — handler Godrej memakai validasi upload bersama dan pesan master yang tepat.",
);
