# Reconciliation Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store versioned reconciliation mappings and auditable reconciliation history in PostgreSQL while preserving all existing formulas and making all 27 tests runnable through one command.

**Architecture:** Keep the three existing reconciliation engines unchanged except for exporting their existing mapping parsers for validation. Add a PostgreSQL-backed mapping/history module behind the existing `createKinoSalesPostHandler` seam, a client-safe registry for the 15 supported combinations, and small admin/history endpoints consumed by the current page.

**Tech Stack:** Next.js App Router, TypeScript, PostgreSQL, Drizzle ORM, `xlsx`, `tsx`, Node `crypto`, existing RBAC.

## Global Constraints

- Do not commit any master mapping workbook or transaction workbook to Git.
- Mapping workbooks are immutable versions stored as PostgreSQL `bytea`, maximum 10 MiB each.
- Input transaction files are not persisted; store only role, name, MIME, size, and SHA-256.
- Persist summary and non-`MATCH` rows only; do not persist matched detail rows.
- Preserve every existing reconciliation formula, tolerance, parser rule, and safe error message.
- Keep each physical Next.js reconciliation route; do not replace them with a dynamic route.
- Keep the 10 MiB per-file limit and enforce a 30 MiB aggregate limit before calling `File.arrayBuffer()`.
- Do not change the package to global ESM.
- Database schema changes start with reviewed SQL migration, then mirror in `db/schema.ts`.
- Do not stage, revert, or modify unrelated local login, chatbot, dashboard, or RBAC resolver changes already present in the working tree.

---

### Task 1: PostgreSQL mapping and run storage

**Files:**
- Create: `db/migrations/0001_reconciliation_storage.sql`
- Modify: `db/schema.ts`
- Create: `lib/off-program-control/reconciliation-store.ts`
- Create: `lib/off-program-control/reconciliation-store.test.ts`

**Interfaces:**
- Produces `ReconciliationDivision = "sales" | "purchases" | "returns"`.
- Produces `ReconciliationActor = { id: string; name: string; email: string }`.
- Produces `getActiveMapping(division, principalCode)` returning `{ id, version, workbook: Buffer, originalName, sha256 }` or `null`.
- Produces `activateMapping(input)` returning mapping metadata after transactional activation.
- Produces `startReconciliationRun(input)`, `completeReconciliationRun(id, output, durationMs)`, `failReconciliationRun(id, error, durationMs)`, and `listReconciliationRuns(filter)`.

- [ ] **Step 1: Write the SQL migration first**

Create both tables, checks, indexes, the partial unique active-mapping index, and restricted mapping reference exactly as specified in the approved design. Actor fields are immutable text snapshots and do not reference `user`, because local development uses `local-dev-admin`.

- [ ] **Step 2: Write failing storage tests**

Use a small fake database adapter passed to `createReconciliationStore(database)` and assert:

```ts
const store = createReconciliationStore(fakeDb);
const next = await store.activateMapping({
  division: "sales",
  principalCode: "KINO",
  originalName: "Kino.xlsx",
  mimeType: XLSX_MIME,
  workbook: Buffer.from("mapping"),
  actor: { id: "local-dev-admin", name: "LOCAL QA Admin", email: "qa.admin@local.test" },
});
assert.equal(next.version, 2);
assert.equal(fakeDb.activeVersions("sales", "KINO"), 1);
```

Also assert SHA-256 metadata, failed-run state, issue filtering, `MATCH` exclusion, and pagination limit clamped to `1..100` with default `20`.

- [ ] **Step 3: Run the test and verify RED**

Run: `npx --no-install tsx lib/off-program-control/reconciliation-store.test.ts`
Expected: FAIL because `reconciliation-store.ts` and its exports do not exist.

- [ ] **Step 4: Mirror the migration in Drizzle and implement the minimum store**

Add `reconciliationMappingVersion` and `reconciliationRun` to `db/schema.ts`. Implement `createReconciliationStore(database)` plus a default `reconciliationStore` using `db`. Use `randomUUID()` and `createHash("sha256")`; use one database transaction for activation. `completeReconciliationRun` stores `Object.fromEntries` summary and `results.filter(row => row.status !== "MATCH")`.

- [ ] **Step 5: Verify GREEN and schema quality**

Run:

```powershell
npx --no-install tsx lib/off-program-control/reconciliation-store.test.ts
npx tsc --noEmit --pretty false
```

Expected: storage test and TypeScript pass. The migration is exercised against PostgreSQL in Task 6 before any local data import.

- [ ] **Step 6: Commit Task 1 only**

```powershell
git add db/migrations/0001_reconciliation_storage.sql db/schema.ts lib/off-program-control/reconciliation-store.ts lib/off-program-control/reconciliation-store.test.ts
git commit -m "feat(reconciliation): store mappings and run history"
```

### Task 2: Central registry and mapping validation

**Files:**
- Create: `lib/off-program-control/reconciliation-config.ts`
- Create: `lib/off-program-control/reconciliation-config.test.ts`
- Create: `lib/off-program-control/reconciliation-mapping-validator.ts`
- Modify: `lib/off-program-control/sales-reconciliation.ts`
- Modify: `lib/off-program-control/return-reconciliation.ts`
- Modify: `lib/off-program-control/purchase-reconciliation.ts`

**Interfaces:**
- Consumes `ReconciliationDivision` from Task 1.
- Produces `RECONCILIATION_CONFIG`, `getReconciliationConfig(division, principal)`, and `reconciliationKeys()`.
- Produces `validateReconciliationMapping(division, principal, workbook): void`.

- [ ] **Step 1: Write the failing registry test**

Assert the registry contains exactly these 15 keys and that each declared endpoint exists on disk:

```ts
const expected = [
  "sales:KINO", "sales:GODREJ", "sales:SHINZUI", "sales:MOTASA", "sales:CUSSONS",
  "purchases:GODREJ", "purchases:RECKITT", "purchases:CUSSONS", "purchases:KINO", "purchases:FORISA",
  "returns:SHINZUI", "returns:KINO", "returns:GODREJ", "returns:HEINZ", "returns:CUSSONS",
];
assert.deepEqual(reconciliationKeys().sort(), expected.sort());
```

Assert HEINZ Return has three inputs and every other key has two. Assert the KINO/FORISA Purchase principal inputs accept `.xlsx`, while CSV-based contracts retain `.csv`.

- [ ] **Step 2: Run the test and verify RED**

Run: `npx --no-install tsx lib/off-program-control/reconciliation-config.test.ts`
Expected: FAIL because the registry does not exist.

- [ ] **Step 3: Implement the client-safe registry**

Use plain serializable objects only: division, principal, endpoint suffix, description, file roles, labels, extensions, and accept strings. Do not import `fs`, database code, or reconciliation engines into this file.

- [ ] **Step 4: Write the failing mapping-validator assertions**

Extend the registry test to call `validateReconciliationMapping` with an empty workbook and expect a safe parser error for every key. Call it with one known valid generated workbook for each distinct mapping layout and expect no throw.

- [ ] **Step 5: Export existing parsers and implement the validator**

Export the existing private mapping parser functions without changing their bodies. Route each registry key to its existing parser. Shared mappings may call the same parser, but each of the 15 keys must be explicit so missing future keys fail closed.

- [ ] **Step 6: Verify GREEN and regression tests**

Run:

```powershell
npx --no-install tsx lib/off-program-control/reconciliation-config.test.ts
npx --no-install tsx lib/off-program-control/sales-reconciliation.test.ts
npx tsc --noEmit --pretty false
```

- [ ] **Step 7: Commit Task 2 only**

```powershell
git add lib/off-program-control/reconciliation-config.ts lib/off-program-control/reconciliation-config.test.ts lib/off-program-control/reconciliation-mapping-validator.ts lib/off-program-control/sales-reconciliation.ts lib/off-program-control/return-reconciliation.ts lib/off-program-control/purchase-reconciliation.ts
git commit -m "refactor(reconciliation): centralize principal contracts"
```

### Task 3: Database-backed route execution and mandatory audit

**Files:**
- Modify: `lib/off-program-control/kino-sales-route.ts`
- Modify: all 15 files under `app/api/reconciliation/**/route.ts`
- Modify: route tests under `lib/off-program-control/*route.test.ts`

**Interfaces:**
- Consumes Task 1 store functions and Task 2 registry keys.
- Changes `authorize` to return `{ response: Response | null; actor: ReconciliationActor | null }`.
- Changes `readMapping` to return mapping metadata and workbook bytes.
- The handler starts, completes, or fails a run through injected store callbacks.

- [ ] **Step 1: Make the existing route test runner stable**

In `cussons-sales-route.test.ts`, `godrej-sales-route.test.ts`, `kino-return-route.test.ts`, `kino-sales-route.test.ts`, `shinzui-return-route.test.ts`, and `shinzui-sales-route.test.ts`, keep imports at module scope and wrap executable statements in `async function main()` with the rejection handler specified in Task 6. Run the route tests once and confirm their existing assertions pass before changing production behavior.

- [ ] **Step 2: Add failing shared-handler tests**

Add assertions to `kino-sales-route.test.ts` for:

```ts
assert.equal(recorded.status, "success");
assert.equal(recorded.mappingVersionId, "mapping-v2");
assert.deepEqual(recorded.inputFiles.map(file => file.sha256.length), [64, 64]);
```

Add tests that a 31 MiB aggregate upload returns `413` before any `arrayBuffer()` call, missing active mapping returns `422`, reconciliation exceptions record `failed`, and audit-write failure returns `500` instead of an unaudited successful response.

- [ ] **Step 3: Run the focused route test and verify RED**

Run: `npx --no-install tsx lib/off-program-control/kino-sales-route.test.ts`
Expected: FAIL on missing actor/mapping/run behavior.

- [ ] **Step 4: Extend the shared handler minimally**

Keep validation and parser-safe-message behavior in place. Normalize the authorization result, sum file sizes before `arrayBuffer()`, hash file buffers, create the processing run, invoke reconcile, then complete/fail the run. The JSON result shape returned to the UI must remain unchanged.

- [ ] **Step 5: Rewire all 15 route files**

Remove every `readFile(path.join(process.cwd(), "data", "reconciliation", ...))`. Each route supplies a constant registry key, returns the actor from `requirePermission`, and uses the Task 1 store for active mapping and run history. Preserve each route's current reconciliation call, tolerances, upload contract, and safe parser message.

- [ ] **Step 6: Update route tests and verify GREEN**

Run all route tests through `tsx --test` after updating their injected authorization/mapping shapes. Expected assertion failures must be fixed without loosening production validation.

- [ ] **Step 7: Prove filesystem mapping dependency is gone**

Run:

```powershell
rg -n "data.*reconciliation|readFile\(" app/api/reconciliation
```

Expected: no runtime mapping reads in the 15 route files.

- [ ] **Step 8: Commit Task 3 only**

```powershell
git add lib/off-program-control/kino-sales-route.ts app/api/reconciliation lib/off-program-control/*route.test.ts
git commit -m "feat(reconciliation): audit database-backed runs"
```

### Task 4: Mapping administration and history endpoints

**Files:**
- Create: `app/api/reconciliation/mappings/route.ts`
- Create: `app/api/reconciliation/history/route.ts`
- Create: `lib/off-program-control/reconciliation-admin-route.test.ts`
- Modify: `lib/rbac.ts`
- Modify: `lib/rbac/registry.ts`
- Modify: `lib/rbac/registry.test.ts`

**Interfaces:**
- `GET /api/reconciliation/mappings?division=sales&principal=KINO` returns active metadata plus version history without workbook bytes.
- `POST /api/reconciliation/mappings` accepts `division`, `principal`, and one `mappingFile`.
- `GET /api/reconciliation/history?division=sales&principal=KINO&page=1&pageSize=20` returns paginated immutable runs.
- Mapping mutation requires `reconciliation.manage`; reads require `reconciliation.view`.

- [ ] **Step 1: Write failing endpoint/RBAC tests**

Assert unauthenticated requests return `401`, `reconciliation.run` without `manage` returns `403` for POST, invalid registry key returns `400`, invalid workbook returns `422`, valid mapping returns version metadata, and history clamps page size to `100`.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx --no-install tsx lib/off-program-control/reconciliation-admin-route.test.ts`
Expected: FAIL because endpoints and `reconciliation.manage` do not exist.

- [ ] **Step 3: Add the minimum RBAC action and endpoints**

Add `manage` only to the reconciliation module and registry. Reuse `requirePermission`; do not add a second role system. Validate registry keys, upload count, extension, MIME, non-empty size, 10 MiB limit, and mapping parser before calling `activateMapping`.

- [ ] **Step 4: Verify GREEN and permission registry**

Run:

```powershell
npx --no-install tsx lib/off-program-control/reconciliation-admin-route.test.ts
npx --no-install tsx lib/rbac/registry.test.ts
npx tsc --noEmit --pretty false
```

- [ ] **Step 5: Commit Task 4 only**

```powershell
git add app/api/reconciliation/mappings/route.ts app/api/reconciliation/history/route.ts lib/off-program-control/reconciliation-admin-route.test.ts lib/rbac.ts lib/rbac/registry.ts lib/rbac/registry.test.ts
git commit -m "feat(reconciliation): manage mappings and history"
```

### Task 5: Registry-driven UI for mappings and history

**Files:**
- Modify: `app/(dashboard)/reconciliation/page.tsx`
- Modify: `tests/reconciliation-ui.spec.ts`

**Interfaces:**
- Consumes Task 2 registry and Task 4 endpoints.
- Keeps the existing reconciliation result and export behavior.

- [ ] **Step 1: Add failing UI tests**

Add Playwright assertions that:

- Faktur, Pembelian, and Return options come from all 15 registry entries.
- Active mapping name/version is visible.
- Admin sees upload mapping control; a non-manage user does not.
- History shows status, actor, mapping version, filenames, duration, total, match, and issue count.
- Opening a history row displays persisted issue causes.
- Pagination requests `pageSize=20`.

- [ ] **Step 2: Run the focused UI test and verify RED**

Run: `npx playwright test tests/reconciliation-ui.spec.ts --project=chromium`
Expected: new mapping/history assertions fail.

- [ ] **Step 3: Replace hardcoded UI branches with the registry**

Derive principle options, endpoint, labels, accepts, file roles, and HEINZ three-file layout from `RECONCILIATION_CONFIG`. Keep status labels and result column behavior unchanged.

- [ ] **Step 4: Add the smallest mapping/history UI**

Add one mapping status card with an admin-only replace action and one collapsible history section. Reuse existing buttons, cards, table primitives, three themes, focus rings, and error banner. Do not create a separate dashboard or new navigation entry.

- [ ] **Step 5: Verify GREEN and accessibility basics**

Run:

```powershell
npx playwright test tests/reconciliation-ui.spec.ts --project=chromium
npx eslint 'app/(dashboard)/reconciliation/page.tsx' tests/reconciliation-ui.spec.ts
npx tsc --noEmit --pretty false
```

- [ ] **Step 6: Commit Task 5 only**

```powershell
git add 'app/(dashboard)/reconciliation/page.tsx' tests/reconciliation-ui.spec.ts
git commit -m "feat(reconciliation): show mapping and run history"
```

### Task 6: Stable test command, local migration, and initial mapping import

**Files:**
- Create: `scripts/import-reconciliation-mapping.ts`
- Create: `scripts/import-reconciliation-mapping.test.ts`
- Create: `scripts/apply-reconciliation-migration.mjs`
- Modify: `package.json`
- Modify: two remaining non-route tests using top-level await:
  - `lib/off-program-control/forisa-purchase-reconciliation.test.ts`
  - `lib/off-program-control/motasa-sales-validation.test.ts`

**Interfaces:**
- `npm run test:reconciliation` executes all 27 `*.test.ts` files.
- `node scripts/apply-reconciliation-migration.mjs` applies only the committed SQL migration transactionally.
- `npx --no-install tsx scripts/import-reconciliation-mapping.ts <division> <principal> <path>` validates and activates one mapping.

- [ ] **Step 1: Add the failing package script and run it**

Set:

```json
"test:reconciliation": "tsx --test lib/off-program-control/*.test.ts"
```

Run: `npm run test:reconciliation`
Expected: 25 pass and 2 fail with top-level-await/CJS transform errors.

- [ ] **Step 2: Wrap the two remaining test bodies in async main functions**

Use this exact ending and retain all assertions:

```ts
async function main() {
  // existing test body
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

Do not set `"type": "module"` and do not change production behavior.

- [ ] **Step 3: Verify all 27 tests GREEN**

Run: `npm run test:reconciliation`
Expected: 27 test files pass, zero failures.

- [ ] **Step 4: Write migration/import script tests first**

In `scripts/import-reconciliation-mapping.test.ts`, add `--help` and invalid-argument assertions against an exported `parseImportArguments`. Expected import arguments are exactly one valid division, one registry principal, and one existing `.xlsx` path. The import must call the same validator and activation module as the admin endpoint.

- [ ] **Step 5: Implement the two small scripts**

Use `pg` and `node:fs/promises`, no new dependency. Migration script reads the one committed SQL file and applies it in a transaction. Import script obtains actor metadata from `RECONCILIATION_IMPORT_ACTOR_ID`, `RECONCILIATION_IMPORT_ACTOR_NAME`, and `RECONCILIATION_IMPORT_ACTOR_EMAIL`, defaulting to the local QA admin values.

- [ ] **Step 6: Apply migration locally and import all 15 keys**

Use the existing mapping files for SHINZUI, Return, RECKITT, GODREJ/CUSSONS Purchase, and the user's supplied master mapping workbooks for KINO, GODREJ, MOTASA, CUSSONS, FORISA. Shared workbook bytes are imported as separate immutable versions for each division-principle key. No Downloads path is committed.

- [ ] **Step 7: Verify database coverage**

Run a read-only query through `reconciliationStore` and assert every value from `reconciliationKeys()` has one active mapping. Expected: 15 active keys and no duplicate active key.

- [ ] **Step 8: Run complete verification**

```powershell
npm run test:reconciliation
npx tsc --noEmit --pretty false
npx eslint lib/off-program-control app/api/reconciliation 'app/(dashboard)/reconciliation/page.tsx' tests/reconciliation-ui.spec.ts
npm run build
```

Then run browser simulations for one real Faktur, one real Pembelian, and one real Return source set. Confirm each run appears in history with its active mapping version and issue count.

- [ ] **Step 9: Commit Task 6 only**

```powershell
git add package.json scripts/apply-reconciliation-migration.mjs scripts/import-reconciliation-mapping.ts scripts/import-reconciliation-mapping.test.ts lib/off-program-control/*.test.ts
git commit -m "test(reconciliation): add stable full-suite runner"
```

## Final Acceptance Checklist

- [ ] `rg -n "data.*reconciliation|readFile\(" app/api/reconciliation` returns no filesystem mapping dependency.
- [ ] Database contains one active mapping for all 15 supported keys.
- [ ] Mapping versions remain immutable and prior run references remain readable.
- [ ] Successful and failed runs appear in paginated UI history.
- [ ] History contains only summary and issue detail, not source workbooks or matched rows.
- [ ] `npm run test:reconciliation` passes all 27 test files.
- [ ] TypeScript, ESLint, and Next.js build pass.
- [ ] Real browser simulation passes for Faktur, Pembelian, and Return.
- [ ] No ignored `.xlsx` file is staged or committed.
