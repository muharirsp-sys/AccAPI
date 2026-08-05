import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { reconciliationMappingVersion, reconciliationRun } from "@/db/schema";

export type ReconciliationDivision = "sales" | "purchases" | "returns";
export type ReconciliationActor = { id: string; name: string; email: string };
export type ReconciliationRunStatus = "processing" | "success" | "failed";

export type ReconciliationMappingRow = {
  id: string;
  division: ReconciliationDivision;
  principalCode: string;
  version: number;
  originalName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  workbook: Buffer;
  uploadedBy: string;
  uploadedByName: string;
  uploadedByEmail: string;
  isActive: boolean;
  createdAt: Date;
};

export type ReconciliationInputFile = {
  role: string;
  name: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
};

export type ReconciliationIssue = { status: string; [key: string]: unknown };

export type ReconciliationRunRow = {
  id: string;
  division: ReconciliationDivision;
  principalCode: string;
  mappingVersionId: string;
  status: ReconciliationRunStatus;
  uploadedBy: string;
  uploadedByName: string;
  uploadedByEmail: string;
  inputFiles: ReconciliationInputFile[];
  summary: Record<string, number> | null;
  issues: ReconciliationIssue[] | null;
  error: string | null;
  durationMs: number | null;
  startedAt: Date;
  finishedAt: Date | null;
};

export interface ReconciliationDatabase {
  transaction<T>(callback: (database: ReconciliationDatabase) => Promise<T>): Promise<T>;
  findActiveMapping(division: string, principalCode: string): Promise<ReconciliationMappingRow | null>;
  nextMappingVersion(division: string, principalCode: string): Promise<number>;
  deactivateMappings(division: string, principalCode: string): Promise<void>;
  insertMapping(row: ReconciliationMappingRow): Promise<void>;
  insertRun(row: ReconciliationRunRow): Promise<void>;
  updateRun(id: string, changes: Partial<ReconciliationRunRow>): Promise<void>;
  findRuns(filter: { division?: string; principalCode?: string; limit: number; offset: number }): Promise<ReconciliationRunRow[]>;
}

type DrizzleExecutor = Pick<typeof db, "select" | "insert" | "update">;

function createDrizzleDatabase(database: DrizzleExecutor): ReconciliationDatabase {
  return {
    transaction: async <T>(callback: (database: ReconciliationDatabase) => Promise<T>) =>
      db.transaction((transaction) => callback(createDrizzleDatabase(transaction as DrizzleExecutor))),
    async findActiveMapping(division, principalCode) {
      const [row] = await database.select().from(reconciliationMappingVersion).where(and(
        eq(reconciliationMappingVersion.division, division),
        eq(reconciliationMappingVersion.principalCode, principalCode),
        eq(reconciliationMappingVersion.isActive, true),
      )).limit(1);
      return (row as ReconciliationMappingRow | undefined) ?? null;
    },
    async nextMappingVersion(division, principalCode) {
      const [row] = await database.select({ version: sql<number>`coalesce(max(${reconciliationMappingVersion.version}), 0) + 1` })
        .from(reconciliationMappingVersion)
        .where(and(eq(reconciliationMappingVersion.division, division), eq(reconciliationMappingVersion.principalCode, principalCode)));
      return Number(row.version);
    },
    async deactivateMappings(division, principalCode) {
      await database.update(reconciliationMappingVersion).set({ isActive: false }).where(and(
        eq(reconciliationMappingVersion.division, division),
        eq(reconciliationMappingVersion.principalCode, principalCode),
        eq(reconciliationMappingVersion.isActive, true),
      ));
    },
    async insertMapping(row) {
      await database.insert(reconciliationMappingVersion).values(row);
    },
    async insertRun(row) {
      await database.insert(reconciliationRun).values(row);
    },
    async updateRun(id, changes) {
      await database.update(reconciliationRun).set(changes).where(eq(reconciliationRun.id, id));
    },
    async findRuns(filter) {
      const conditions = [
        filter.division ? eq(reconciliationRun.division, filter.division) : undefined,
        filter.principalCode ? eq(reconciliationRun.principalCode, filter.principalCode) : undefined,
      ].filter((condition) => condition !== undefined);
      const rows = await database.select().from(reconciliationRun)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(reconciliationRun.startedAt))
        .limit(filter.limit)
        .offset(filter.offset);
      return rows as ReconciliationRunRow[];
    },
  };
}

export function createReconciliationStore(database: ReconciliationDatabase) {
  return {
    async getActiveMapping(division: ReconciliationDivision, principalCode: string) {
      const row = await database.findActiveMapping(division, principalCode);
      if (!row) return null;
      const { isActive: _isActive, ...mapping } = row;
      void _isActive;
      return mapping;
    },

    activateMapping(input: {
      division: ReconciliationDivision;
      principalCode: string;
      originalName: string;
      mimeType: string;
      workbook: Buffer;
      actor: ReconciliationActor;
    }) {
      return database.transaction(async (transaction) => {
        const version = await transaction.nextMappingVersion(input.division, input.principalCode);
        await transaction.deactivateMappings(input.division, input.principalCode);
        const row: ReconciliationMappingRow = {
          id: randomUUID(),
          division: input.division,
          principalCode: input.principalCode,
          version,
          originalName: input.originalName,
          mimeType: input.mimeType,
          byteSize: input.workbook.byteLength,
          sha256: createHash("sha256").update(input.workbook).digest("hex"),
          workbook: input.workbook,
          uploadedBy: input.actor.id,
          uploadedByName: input.actor.name,
          uploadedByEmail: input.actor.email,
          isActive: true,
          createdAt: new Date(),
        };
        await transaction.insertMapping(row);
        const { workbook: _workbook, isActive: _isActive, ...metadata } = row;
        void _workbook;
        void _isActive;
        return metadata;
      });
    },

    async startReconciliationRun(input: {
      division: ReconciliationDivision;
      principalCode: string;
      mappingVersionId: string;
      actor: ReconciliationActor;
      inputFiles: ReconciliationInputFile[];
    }) {
      const id = randomUUID();
      await database.insertRun({
        id,
        division: input.division,
        principalCode: input.principalCode,
        mappingVersionId: input.mappingVersionId,
        status: "processing",
        uploadedBy: input.actor.id,
        uploadedByName: input.actor.name,
        uploadedByEmail: input.actor.email,
        inputFiles: input.inputFiles,
        summary: null,
        issues: null,
        error: null,
        durationMs: null,
        startedAt: new Date(),
        finishedAt: null,
      });
      return id;
    },

    completeReconciliationRun(id: string, output: { summary: Record<string, number>; results: ReconciliationIssue[] }, durationMs: number) {
      return database.updateRun(id, {
        status: "success",
        summary: Object.fromEntries(Object.entries(output.summary)),
        issues: output.results.filter((row) => row.status !== "MATCH"),
        error: null,
        durationMs,
        finishedAt: new Date(),
      });
    },

    failReconciliationRun(id: string, error: string, durationMs: number) {
      return database.updateRun(id, { status: "failed", error, durationMs, finishedAt: new Date() });
    },

    listReconciliationRuns(filter: { division?: ReconciliationDivision; principalCode?: string; page?: number; pageSize?: number } = {}) {
      const page = Math.max(1, Math.trunc(filter.page ?? 1));
      const pageSize = Math.min(100, Math.max(1, Math.trunc(filter.pageSize ?? 20)));
      return database.findRuns({
        division: filter.division,
        principalCode: filter.principalCode,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
    },
  };
}

export const reconciliationStore = createReconciliationStore(createDrizzleDatabase(db));
