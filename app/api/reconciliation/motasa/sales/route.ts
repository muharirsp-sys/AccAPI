import { createKinoSalesPostHandler } from "@/lib/off-program-control/kino-sales-route";
import { reconciliationStore } from "@/lib/off-program-control/reconciliation-store";
import { reconcileMotasaSales } from "@/lib/off-program-control/sales-reconciliation";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

export const POST = createKinoSalesPostHandler({
  reconciliationKey: "sales:MOTASA",
  authorize: async (request) => {
    const { response, session } = await requirePermission(request, "reconciliation.run");
    return { response, actor: session ? { id: session.user.id, name: session.user.name ?? session.user.email, email: session.user.email } : null };
  },
  readMapping: () => reconciliationStore.getActiveMapping("sales", "MOTASA"),
  startReconciliationRun: (input) => reconciliationStore.startReconciliationRun(input),
  completeReconciliationRun: (id, output, durationMs) =>
    reconciliationStore.completeReconciliationRun(id, output, durationMs),
  failReconciliationRun: (id, error, durationMs) =>
    reconciliationStore.failReconciliationRun(id, error, durationMs),
  reconcile: (accurate, principal, mapping) =>
    reconcileMotasaSales(accurate, principal, mapping, { valueTolerance: 1 }),
  missingMappingMessage: "Master mapping MOTASA tidak tersedia.",
});
