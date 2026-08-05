import {
  createKinoSalesPostHandler,
  CSV_MIME_TYPES,
} from "@/lib/off-program-control/kino-sales-route";
import { reconciliationStore } from "@/lib/off-program-control/reconciliation-store";
import { reconcileHeinzReturns } from "@/lib/off-program-control/return-reconciliation";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

const csvUpload = {
  kind: "csv" as const,
  extensions: [".csv"],
  mimeTypes: CSV_MIME_TYPES,
};

export const POST = createKinoSalesPostHandler({
  reconciliationKey: "returns:HEINZ",
  authorize: async (request) => {
    const { response, session } = await requirePermission(request, "reconciliation.run");
    return { response, actor: session ? { id: session.user.id, name: session.user.name ?? session.user.email, email: session.user.email } : null };
  },
  headerUpload: csvUpload,
  principalUpload: csvUpload,
  readMapping: () => reconciliationStore.getActiveMapping("returns", "HEINZ"),
  startReconciliationRun: (input) => reconciliationStore.startReconciliationRun(input),
  completeReconciliationRun: (id, output, durationMs) =>
    reconciliationStore.completeReconciliationRun(id, output, durationMs),
  failReconciliationRun: (id, error, durationMs) =>
    reconciliationStore.failReconciliationRun(id, error, durationMs),
  reconcile: (accurate, header, detail, mapping) =>
    reconcileHeinzReturns(accurate, header, detail, mapping, {
      dppTolerance: 1,
    }),
  missingMappingMessage: "Master mapping HEINZ Return tidak tersedia.",
});
