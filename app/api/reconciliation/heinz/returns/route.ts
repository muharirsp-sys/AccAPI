import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createKinoSalesPostHandler,
  CSV_MIME_TYPES,
} from "@/lib/off-program-control/kino-sales-route";
import { reconcileHeinzReturns } from "@/lib/off-program-control/return-reconciliation";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

const csvUpload = {
  kind: "csv" as const,
  extensions: [".csv"],
  mimeTypes: CSV_MIME_TYPES,
};

export const POST = createKinoSalesPostHandler({
  authorize: async (request) =>
    (await requirePermission(request, "reconciliation.run")).response,
  headerUpload: csvUpload,
  principalUpload: csvUpload,
  readMapping: () =>
    readFile(
      path.join(process.cwd(), "data", "reconciliation", "HEINZ_RETURN.xlsx"),
    ),
  reconcile: (accurate, header, detail, mapping) =>
    reconcileHeinzReturns(accurate, header, detail, mapping, {
      dppTolerance: 1,
    }),
  missingMappingMessage: "Master mapping HEINZ Return tidak tersedia.",
});
