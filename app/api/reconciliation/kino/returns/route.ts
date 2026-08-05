import { createKinoSalesPostHandler } from "@/lib/off-program-control/kino-sales-route";
import { reconciliationStore } from "@/lib/off-program-control/reconciliation-store";
import { reconcileKinoReturns } from "@/lib/off-program-control/return-reconciliation";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

export const POST = createKinoSalesPostHandler({
  reconciliationKey: "returns:KINO",
  authorize: async (request) => {
    const { response, session } = await requirePermission(request, "reconciliation.run");
    return { response, actor: session ? { id: session.user.id, name: session.user.name ?? session.user.email, email: session.user.email } : null };
  },
  readMapping: () => reconciliationStore.getActiveMapping("returns", "KINO"),
  startReconciliationRun: (input) => reconciliationStore.startReconciliationRun(input),
  completeReconciliationRun: (id, output, durationMs) =>
    reconciliationStore.completeReconciliationRun(id, output, durationMs),
  failReconciliationRun: (id, error, durationMs) =>
    reconciliationStore.failReconciliationRun(id, error, durationMs),
  reconcile: (accurate, principal, mapping) =>
    reconcileKinoReturns(accurate, principal, mapping, { dppTolerance: 1 }),
  missingMappingMessage: "Master mapping KINO Return tidak tersedia.",
});
