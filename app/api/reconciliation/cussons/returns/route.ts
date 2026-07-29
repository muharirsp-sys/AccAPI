import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createKinoSalesPostHandler,
  CSV_MIME_TYPES,
} from "@/lib/off-program-control/kino-sales-route";
import { reconcileCussonsReturns } from "@/lib/off-program-control/return-reconciliation";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

export const POST = createKinoSalesPostHandler({
  authorize: async (request) =>
    (await requirePermission(request, "reconciliation.run")).response,
  principalUpload: {
    kind: "csv",
    extensions: [".csv"],
    mimeTypes: CSV_MIME_TYPES,
  },
  readMapping: () =>
    readFile(
      path.join(
        process.cwd(),
        "data",
        "reconciliation",
        "CUSSONS_RETURN.xlsx",
      ),
    ),
  reconcile: (accurate, principal, mapping) =>
    reconcileCussonsReturns(accurate, principal, mapping, { dppTolerance: 1 }),
  missingMappingMessage: "Master mapping CUSSONS Return tidak tersedia.",
});
