import { readFile } from "node:fs/promises";
import path from "node:path";
import { createKinoSalesPostHandler } from "@/lib/off-program-control/kino-sales-route";
import { reconcileGodrejPurchases } from "@/lib/off-program-control/purchase-reconciliation";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

export const POST = createKinoSalesPostHandler({
  authorize: async (request) =>
    (await requirePermission(request, "reconciliation.run")).response,
  readMapping: () =>
    readFile(
      path.join(
        process.cwd(),
        "data",
        "reconciliation",
        "GODREJ_RETURN.xlsx",
      ),
    ),
  reconcile: (accurate, principal, mapping) =>
    reconcileGodrejPurchases(accurate, principal, mapping, {
      dppTolerance: 1,
    }),
  missingMappingMessage: "Master mapping GODREJ Purchase tidak tersedia.",
});
