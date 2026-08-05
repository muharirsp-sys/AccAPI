import { NextResponse } from "next/server";
import { reconciliationKeys } from "@/lib/off-program-control/reconciliation-config";
import { validateReconciliationMapping } from "@/lib/off-program-control/reconciliation-mapping-validator";
import {
  reconciliationStore,
  type ReconciliationActor,
  type ReconciliationDivision,
  type ReconciliationMappingMetadata,
} from "@/lib/off-program-control/reconciliation-store";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

type Authorization = { response: Response | null; actor: ReconciliationActor | null; canManage: boolean };
type Dependencies = {
  authorize(request: Request, permission: "reconciliation.view" | "reconciliation.manage"): Promise<Authorization>;
  listMappingVersions(division: ReconciliationDivision, principal: string): Promise<ReconciliationMappingMetadata[]>;
  activateMapping(input: { division: ReconciliationDivision; principalCode: string; originalName: string; mimeType: string; workbook: Buffer; actor: ReconciliationActor }): Promise<ReconciliationMappingMetadata>;
  validateMapping(division: ReconciliationDivision, principal: string, workbook: Buffer): void;
};

const MAX_MAPPING_BYTES = 10 * 1024 * 1024;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function registryKey(request: Request): { division: ReconciliationDivision; principal: string } | null {
  const { searchParams } = new URL(request.url);
  const division = searchParams.get("division") ?? "";
  const principal = searchParams.get("principal") ?? "";
  return reconciliationKeys().includes(`${division}:${principal}`)
    ? { division: division as ReconciliationDivision, principal }
    : null;
}

export function createMappingsHandlers(deps: Dependencies) {
  return {
    async GET(request: Request) {
      const gate = await deps.authorize(request, "reconciliation.view");
      if (gate.response) return gate.response;
      const key = registryKey(request);
      if (!key) return NextResponse.json({ error: "Kontrak rekonsiliasi tidak didukung." }, { status: 400 });
      const versions = await deps.listMappingVersions(key.division, key.principal);
      return NextResponse.json({ active: versions.find((version) => version.isActive) ?? null, versions, canManage: gate.canManage });
    },

    async POST(request: Request) {
      const gate = await deps.authorize(request, "reconciliation.manage");
      if (gate.response) return gate.response;
      if (!gate.actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      const data = await request.formData();
      const division = String(data.get("division") ?? "");
      const principal = String(data.get("principal") ?? "");
      const key = reconciliationKeys().includes(`${division}:${principal}`)
        ? { division: division as ReconciliationDivision, principal }
        : null;
      if (!key) return NextResponse.json({ error: "Kontrak rekonsiliasi tidak didukung." }, { status: 400 });
      const files = data.getAll("mappingFile");
      if (files.length !== 1 || !(files[0] instanceof File)) return NextResponse.json({ error: "Tepat satu mappingFile wajib diunggah." }, { status: 400 });
      const file = files[0];
      if (!file.name.toLowerCase().endsWith(".xlsx") || file.type !== XLSX_MIME)
        return NextResponse.json({ error: "Mapping harus berupa workbook .xlsx." }, { status: 400 });
      if (!file.size) return NextResponse.json({ error: "Mapping tidak boleh kosong." }, { status: 400 });
      if (file.size > MAX_MAPPING_BYTES) return NextResponse.json({ error: "Mapping melebihi batas 10 MiB." }, { status: 413 });
      const workbook = Buffer.from(await file.arrayBuffer());
      try {
        deps.validateMapping(key.division, key.principal, workbook);
      } catch {
        return NextResponse.json({ error: "Workbook mapping tidak valid." }, { status: 422 });
      }
      const metadata = await deps.activateMapping({
        division: key.division,
        principalCode: key.principal,
        originalName: file.name,
        mimeType: file.type,
        workbook,
        actor: gate.actor,
      });
      return NextResponse.json(metadata, { status: 201 });
    },
  };
}

const handlers = createMappingsHandlers({
  authorize: async (request, permission) => {
    const gate = await requirePermission(request, permission);
    return {
      response: gate.response,
      actor: gate.session ? { id: gate.session.user.id, name: gate.session.user.name ?? gate.session.user.email, email: gate.session.user.email } : null,
      canManage: gate.perms?.has("reconciliation.manage") === true,
    };
  },
  listMappingVersions: (division, principal) => reconciliationStore.listMappingVersions(division, principal),
  activateMapping: (input) => reconciliationStore.activateMapping(input),
  validateMapping: validateReconciliationMapping,
});

export const GET = handlers.GET;
export const POST = handlers.POST;
