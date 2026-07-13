import { readFile } from "node:fs/promises";
import path from "node:path";
import { createKinoSalesPostHandler } from "@/lib/off-program-control/kino-sales-route";
import { reconcileKinoSales } from "@/lib/off-program-control/sales-reconciliation";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

export const POST = createKinoSalesPostHandler({
  authorize: async (request) => (await requirePermission(request, "reconciliation.run")).response,
  readMapping: () => readFile(path.join(process.cwd(), "data", "reconciliation", "Kino.xlsx")),
  reconcile: (accurate, principal, mapping) => reconcileKinoSales(accurate, principal, mapping, { valueTolerance: 1 }),
});