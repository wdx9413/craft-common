import assert from "node:assert/strict";
import test from "node:test";
import { sqliteBusyTimeoutMs, sqliteTraceBusyTimeoutMs } from "../src/sqlite-busy-timeout.ts";
import { SCHEMA_VERSION } from "../src/store-schema.ts";

test("hook mode shortens SQLite busy timeouts", () => {
  assert.equal(sqliteBusyTimeoutMs({ CRAFT_HOOK_MODE: "1" }), 100);
  assert.equal(sqliteBusyTimeoutMs({}), 15_000);
  assert.equal(sqliteTraceBusyTimeoutMs({ CRAFT_HOOK_MODE: "1" }), 100);
  assert.equal(sqliteTraceBusyTimeoutMs({}), 15_000);
});

test("schema version is the shipped persistence revision", () => {
  assert.equal(SCHEMA_VERSION, 4);
});
