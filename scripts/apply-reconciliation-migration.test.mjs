import assert from "node:assert/strict";
import test from "node:test";
import { runReconciliationMigration } from "./apply-reconciliation-migration.mjs";

test("closes the client when connect rejects", async () => {
  const expected = new Error("connection rejected");
  let ended = false;
  const client = {
    connect: async () => { throw expected; },
    end: async () => { ended = true; },
    query: async () => { throw new Error("query must not run"); },
  };

  await assert.rejects(runReconciliationMigration(client, "SELECT 1"), expected);
  assert.equal(ended, true);
});
