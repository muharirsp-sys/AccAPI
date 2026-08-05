import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { reconciliationKeys } from "../lib/off-program-control/reconciliation-config.ts";
import type { ReconciliationDivision } from "../lib/off-program-control/reconciliation-store.ts";

try { process.loadEnvFile(".env.local"); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const usage = "Usage: npx --no-install tsx scripts/import-reconciliation-mapping.ts <division> <principal> <path.xlsx>";

export async function parseImportArguments(args: string[]) {
  if (args.length === 1 && args[0] === "--help") return { help: true } as const;
  if (args.length !== 3) throw new Error(usage);
  const [division, principal, workbookPath] = args;
  if (!reconciliationKeys().includes(`${division}:${principal}`))
    throw new Error(`Kontrak rekonsiliasi tidak didukung: ${division}:${principal}`);
  if (!workbookPath.toLowerCase().endsWith(".xlsx")) throw new Error("Mapping harus berupa workbook .xlsx.");
  await access(workbookPath);
  return {
    help: false,
    division: division as ReconciliationDivision,
    principal,
    path: workbookPath,
  } as const;
}

async function main() {
  const parsed = await parseImportArguments(process.argv.slice(2));
  if (parsed.help) return console.log(usage);
  const [{ validateReconciliationMapping }, { reconciliationStore }] = await Promise.all([
    import("../lib/off-program-control/reconciliation-mapping-validator.ts"),
    import("../lib/off-program-control/reconciliation-store.ts"),
  ]);
  const workbook = await readFile(parsed.path);
  validateReconciliationMapping(parsed.division, parsed.principal, workbook);
  const metadata = await reconciliationStore.activateMapping({
    division: parsed.division,
    principalCode: parsed.principal,
    originalName: path.basename(parsed.path),
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    workbook,
    actor: {
      id: process.env.RECONCILIATION_IMPORT_ACTOR_ID ?? "local-dev-admin",
      name: process.env.RECONCILIATION_IMPORT_ACTOR_NAME ?? "LOCAL QA Admin",
      email: process.env.RECONCILIATION_IMPORT_ACTOR_EMAIL ?? "qa.admin@local.test",
    },
  });
  console.log(`${parsed.division}:${parsed.principal} version ${metadata.version} active`);
  process.exit(0);
}

if (require.main === module) main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
