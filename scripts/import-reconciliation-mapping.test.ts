import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseImportArguments } from "./import-reconciliation-mapping.ts";

test("--help requests usage without import arguments", async () => {
  assert.deepEqual(await parseImportArguments(["--help"]), { help: true });
});

test("accepts exactly one registered division/principal and existing .xlsx path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "reconciliation-import-"));
  const workbookPath = path.join(directory, "mapping.xlsx");
  try {
    await writeFile(workbookPath, "xlsx");
    assert.deepEqual(await parseImportArguments(["sales", "KINO", workbookPath]), {
      help: false,
      division: "sales",
      principal: "KINO",
      path: workbookPath,
    });
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("rejects missing, extra, unsupported, absent, and non-xlsx arguments", async () => {
  for (const args of [
    [],
    ["sales", "KINO"],
    ["sales", "KINO", "mapping.xlsx", "extra"],
    ["invalid", "KINO", "mapping.xlsx"],
    ["sales", "FORISA", "mapping.xlsx"],
    ["sales", "KINO", "missing.xlsx"],
    ["sales", "KINO", "mapping.csv"],
  ]) await assert.rejects(() => parseImportArguments(args));
});
