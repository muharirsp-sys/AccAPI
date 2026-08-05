import assert from "node:assert/strict";
import {
  createReconciliationStore,
  type ReconciliationDatabase,
  type ReconciliationMappingRow,
  type ReconciliationRunRow,
} from "./reconciliation-store";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const actor = {
  id: "local-dev-admin",
  name: "LOCAL QA Admin",
  email: "qa.admin@local.test",
};

class FakeDatabase implements ReconciliationDatabase {
  mappings: ReconciliationMappingRow[] = [];
  runs: ReconciliationRunRow[] = [];

  async transaction<T>(callback: (database: ReconciliationDatabase) => Promise<T>): Promise<T> {
    const mappings = structuredClone(this.mappings);
    try {
      return await callback(this);
    } catch (error) {
      this.mappings = mappings;
      throw error;
    }
  }

  async findActiveMapping(division: string, principalCode: string) {
    return this.mappings.find(
      (row) => row.division === division && row.principalCode === principalCode && row.isActive,
    ) ?? null;
  }

  async findMappings(division: string, principalCode: string) {
    return this.mappings
      .filter((row) => row.division === division && row.principalCode === principalCode)
      .sort((left, right) => right.version - left.version)
      .map(({ workbook: _workbook, ...row }) => row);
  }

  async nextMappingVersion(division: string, principalCode: string) {
    return Math.max(
      0,
      ...this.mappings
        .filter((row) => row.division === division && row.principalCode === principalCode)
        .map((row) => row.version),
    ) + 1;
  }

  async deactivateMappings(division: string, principalCode: string) {
    for (const row of this.mappings)
      if (row.division === division && row.principalCode === principalCode) row.isActive = false;
  }

  async insertMapping(row: ReconciliationMappingRow) {
    this.mappings.push(row);
  }

  async insertRun(row: ReconciliationRunRow) {
    this.runs.push(row);
  }

  async updateRun(id: string, changes: Partial<ReconciliationRunRow>) {
    const row = this.runs.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`Unknown run ${id}`);
    Object.assign(row, changes);
  }

  async findRuns(filter: { division?: string; principalCode?: string; limit: number; offset: number }) {
    return this.runs
      .filter(
        (row) =>
          (!filter.division || row.division === filter.division) &&
          (!filter.principalCode || row.principalCode === filter.principalCode),
      )
      .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())
      .slice(filter.offset, filter.offset + filter.limit);
  }

  activeVersions(division: string, principalCode: string) {
    return this.mappings.filter(
      (row) => row.division === division && row.principalCode === principalCode && row.isActive,
    ).length;
  }
}

async function main() {
  const fakeDb = new FakeDatabase();
  const store = createReconciliationStore(fakeDb);

  const first = await store.activateMapping({
    division: "sales",
    principalCode: "KINO",
    originalName: "Kino-v1.xlsx",
    mimeType: XLSX_MIME,
    workbook: Buffer.from("old mapping"),
    actor,
  });
  const next = await store.activateMapping({
    division: "sales",
    principalCode: "KINO",
    originalName: "Kino.xlsx",
    mimeType: XLSX_MIME,
    workbook: Buffer.from("mapping"),
    actor,
  });

  assert.equal(first.version, 1);
  assert.equal(next.version, 2);
  assert.equal(next.byteSize, 7);
  assert.equal(next.sha256, "a6375ee99716acf4635ba3c192f7578a85ad4b479d09174e7d80d01aa91443af");
  assert.equal(fakeDb.activeVersions("sales", "KINO"), 1);
  assert.equal("workbook" in next, false);
  const versions = await store.listMappingVersions("sales", "KINO");
  assert.deepEqual(versions.map((row) => row.version), [2, 1]);
  assert.ok(versions.every((row) => !("workbook" in row)));
  assert.equal(versions.find((row) => row.isActive)?.version, 2);

  const active = await store.getActiveMapping("sales", "KINO");
  assert.equal(active?.version, 2);
  assert.deepEqual(active?.workbook, Buffer.from("mapping"));
  assert.equal(active && "isActive" in active, false);
  assert.equal(await store.getActiveMapping("returns", "KINO"), null);

  const successId = await store.startReconciliationRun({
    division: "sales",
    principalCode: "KINO",
    mappingVersionId: next.id,
    actor,
    inputFiles: [{ role: "accurate", name: "accurate.xlsx", mimeType: XLSX_MIME, byteSize: 12, sha256: "a".repeat(64) }],
  });
  await store.completeReconciliationRun(successId, {
    summary: { MATCH: 1, VALUE_MISMATCH: 1 },
    results: [
      { status: "MATCH", invoice: "INV-OK" },
      { status: "VALUE_MISMATCH", invoice: "INV-BAD" },
    ],
  }, 42);
  const success = fakeDb.runs.find((row) => row.id === successId);
  assert.deepEqual(success?.summary, { MATCH: 1, VALUE_MISMATCH: 1 });
  assert.deepEqual(success?.issues, [{ status: "VALUE_MISMATCH", invoice: "INV-BAD" }]);
  assert.equal(success?.status, "success");
  assert.equal(success?.durationMs, 42);

  const failedId = await store.startReconciliationRun({
    division: "returns",
    principalCode: "KINO",
    mappingVersionId: next.id,
    actor,
    inputFiles: [],
  });
  await store.failReconciliationRun(failedId, "Rekonsiliasi gagal diproses.", 9);
  const failed = fakeDb.runs.find((row) => row.id === failedId);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error, "Rekonsiliasi gagal diproses.");
  assert.equal(failed?.durationMs, 9);
  assert.ok(failed?.finishedAt instanceof Date);

  for (let index = 0; index < 105; index += 1) {
    await store.startReconciliationRun({
      division: "purchases",
      principalCode: "KINO",
      mappingVersionId: next.id,
      actor,
      inputFiles: [],
    });
    fakeDb.runs.at(-1)!.startedAt = new Date(index);
  }

  assert.equal((await store.listReconciliationRuns({ division: "purchases", principalCode: "KINO" })).length, 20);
  assert.equal((await store.listReconciliationRuns({ division: "purchases", page: 0, pageSize: 1000 })).length, 100);
  assert.equal((await store.listReconciliationRuns({ division: "purchases", page: 2, pageSize: 3 }))[0]?.startedAt.getTime(), 101);
  assert.equal((await store.listReconciliationRuns({ division: "returns", pageSize: 0 })).length, 1);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
