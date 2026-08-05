import { NextResponse } from "next/server";
import { reconciliationKeys } from "@/lib/off-program-control/reconciliation-config";
import { reconciliationStore, type ReconciliationDivision, type ReconciliationRunRow } from "@/lib/off-program-control/reconciliation-store";
import { requirePermission } from "@/lib/rbac/resolve";

type Dependencies = {
  authorize(request: Request, permission: "reconciliation.view"): Promise<{ response: Response | null }>;
  listReconciliationRuns(filter: { division: ReconciliationDivision; principalCode: string; page: number; pageSize: number }): Promise<ReconciliationRunRow[]>;
};

export function createHistoryGetHandler(deps: Dependencies) {
  return async function GET(request: Request) {
    const gate = await deps.authorize(request, "reconciliation.view");
    if (gate.response) return gate.response;
    const { searchParams } = new URL(request.url);
    const division = searchParams.get("division") ?? "";
    const principal = searchParams.get("principal") ?? "";
    if (!reconciliationKeys().includes(`${division}:${principal}`))
      return NextResponse.json({ error: "Kontrak rekonsiliasi tidak didukung." }, { status: 400 });
    const page = Math.max(1, Math.trunc(Number(searchParams.get("page"))) || 1);
    const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(searchParams.get("pageSize"))) || 20));
    const items = await deps.listReconciliationRuns({ division: division as ReconciliationDivision, principalCode: principal, page, pageSize });
    return NextResponse.json({ items, page, pageSize });
  };
}

export const GET = createHistoryGetHandler({
  authorize: async (request, permission) => requirePermission(request, permission),
  listReconciliationRuns: (filter) => reconciliationStore.listReconciliationRuns(filter),
});
