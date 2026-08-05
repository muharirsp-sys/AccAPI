import assert from "node:assert/strict";
import { createMappingsHandlers } from "../../app/api/reconciliation/mappings/route";
import { createHistoryGetHandler } from "../../app/api/reconciliation/history/route";

const forbidden = new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
const unauthorized = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
const actor = { id: "u1", name: "Admin", email: "admin@example.com" };
const xlsxMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function form(file: File, extras: File[] = []) {
  const body = new FormData();
  body.set("division", "sales");
  body.set("principal", "KINO");
  body.append("mappingFile", file);
  for (const extra of extras) body.append("mappingFile", extra);
  return new Request("http://localhost/api/reconciliation/mappings", { method: "POST", body });
}

async function main() {
  const permissions: string[] = [];
  const mappings = createMappingsHandlers({
    authorize: async (_request, permission) => {
      permissions.push(permission);
      return permission === "reconciliation.manage"
        ? { response: forbidden, actor: null, canManage: false }
        : { response: unauthorized, actor: null, canManage: false };
    },
    listMappingVersions: async () => [],
    activateMapping: async () => { throw new Error("must not activate"); },
    validateMapping: () => undefined,
  });
  assert.equal((await mappings.GET(new Request("http://localhost/api/reconciliation/mappings?division=sales&principal=KINO"))).status, 401);
  assert.equal((await mappings.POST(form(new File(["x"], "mapping.xlsx", { type: xlsxMime })))).status, 403);
  assert.deepEqual(permissions, ["reconciliation.view", "reconciliation.manage"]);

  const authorized = createMappingsHandlers({
    authorize: async () => ({ response: null, actor, canManage: true }),
    listMappingVersions: async () => [{ id: "m1", division: "sales", principalCode: "KINO", version: 1, isActive: true } as never],
    activateMapping: async (input) => ({ id: "m2", division: input.division, principalCode: input.principalCode, version: 2 }),
    validateMapping: (_division, _principal, workbook) => {
      if (workbook.toString() === "invalid") throw new Error("Workbook mapping invalid");
    },
  });
  assert.equal((await authorized.GET(new Request("http://localhost/api/reconciliation/mappings?division=sales&principal=NOPE"))).status, 400);
  const listed = await (await authorized.GET(new Request("http://localhost/api/reconciliation/mappings?division=sales&principal=KINO"))).json();
  assert.equal(listed.active.version, 1);
  assert.equal(listed.canManage, true);
  assert.equal("workbook" in listed.active, false);
  assert.equal(listed.versions.length, 1);
  assert.equal((await authorized.POST(form(new File(["invalid"], "mapping.xlsx", { type: xlsxMime })))).status, 422);
  assert.equal((await authorized.POST(form(new File(["valid"], "mapping.xlsx", { type: xlsxMime }), [new File(["x"], "extra.xlsx", { type: xlsxMime })]))).status, 400);
  assert.equal((await authorized.POST(form(new File([], "mapping.xlsx", { type: xlsxMime })))).status, 400);
  assert.equal((await authorized.POST(form(new File(["valid"], "mapping.csv", { type: "text/csv" })))).status, 400);
  assert.equal((await authorized.POST(form(new File([new Uint8Array(10 * 1024 * 1024 + 1)], "mapping.xlsx", { type: xlsxMime })))).status, 413);
  const created = await authorized.POST(form(new File(["valid"], "mapping.xlsx", { type: xlsxMime })));
  assert.equal(created.status, 201);
  assert.equal((await created.json()).version, 2);

  let historyFilter: unknown;
  const anonymousHistory = createHistoryGetHandler({
    authorize: async () => ({ response: unauthorized }),
    listReconciliationRuns: async () => { throw new Error("must not list"); },
  });
  assert.equal((await anonymousHistory(new Request("http://localhost/api/reconciliation/history?division=sales&principal=KINO"))).status, 401);
  const history = createHistoryGetHandler({
    authorize: async (_request, permission) => {
      assert.equal(permission, "reconciliation.view");
      return { response: null };
    },
    listReconciliationRuns: async (filter) => {
      historyFilter = filter;
      return [{ id: "r1" }] as never;
    },
  });
  const response = await history(new Request("http://localhost/api/reconciliation/history?division=sales&principal=KINO&page=2&pageSize=999"));
  assert.deepEqual(await response.json(), { items: [{ id: "r1" }], page: 2, pageSize: 100 });
  assert.deepEqual(historyFilter, { division: "sales", principalCode: "KINO", page: 2, pageSize: 100 });
  const invalidPage = await history(new Request("http://localhost/api/reconciliation/history?division=sales&principal=KINO&page=Infinity&pageSize=1.5"));
  assert.deepEqual(await invalidPage.json(), { items: [{ id: "r1" }], page: 1, pageSize: 20 });
  assert.deepEqual(historyFilter, { division: "sales", principalCode: "KINO", page: 1, pageSize: 20 });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
