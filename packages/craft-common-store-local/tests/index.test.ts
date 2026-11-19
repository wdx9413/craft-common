import assert from "node:assert/strict";
import test from "node:test";
import * as store from "../src/index.ts";

test("store package entry exports its public surface", () => {
  for (const name of ["CraftStore", "craftPaths", "MarkdownContentStore", "applyMigrations", "MIGRATIONS", "SCHEMA_VERSION",
    "ContextReadGuard", "assertContextReadCurrent", "ContextAccessChangedError"]) {
    assert.ok(name in store, `missing export ${name}`);
  }
});
