import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createKinoSalesPostHandler,
  CSV_MIME_TYPES,
} from "@/lib/off-program-control/kino-sales-route";
import { reconcileGodrejReturns } from "@/lib/off-program-control/return-reconciliation";
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
        "GODREJ_RETURN.xlsx",
      ),
    ),
  reconcile: (accurate, principal, mapping) =>
    reconcileGodrejReturns(accurate, principal, mapping, { dppTolerance: 1 }),
  missingMappingMessage: "Master mapping GODREJ Return tidak tersedia.",
});
