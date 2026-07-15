import { readFile } from "node:fs/promises";
import path from "node:path";
import { createKinoSalesPostHandler } from "@/lib/off-program-control/kino-sales-route";
import { reconcileShinzuiSales } from "@/lib/off-program-control/sales-reconciliation";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

export const POST = createKinoSalesPostHandler({
  authorize: async (request) =>
    (await requirePermission(request, "reconciliation.run")).response,
  readMapping: () =>
    readFile(path.join(process.cwd(), "data", "reconciliation", "SHINZUI.xlsx")),
  reconcile: (accurate, principal, mapping) =>
    reconcileShinzuiSales(accurate, principal, mapping, { valueTolerance: 1 }),
  missingMappingMessage: "Master mapping SHINZUI tidak tersedia.",
});