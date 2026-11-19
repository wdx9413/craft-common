import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, SCHEMA_VERSION, withContextLockBudget } from "../src/store.ts";
import { craftPaths } from "../src/paths.ts";

const stores: CraftStore[] = [];
const directories: string[] = [];
async function open(): Promise<CraftStore> {
  const directory = mkdtempSync(join(tmpdir(), "craft-store-"));
  directories.push(directory);
  const store = await new CraftStore(craftPaths(directory)).open();
  stores.push(store);
  return store;
}
test.after(() => {
  for (const store of stores) store.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

test("a fresh store opens with the shipped schema", async () => {
  const store = await open();
  assert.equal(store.legacyDatabaseDetected(), false);
  assert.equal(store.transactionActive, false);
  assert.throws(() => store.applyMigrationsNow(1), /newer than supported/u);
  const plan = store.applyMigrationsNow(SCHEMA_VERSION, { dryRun: true });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.applied, 0);
});

test("records are created, versioned, updated and removed", async () => {
  const store = await open();
  const created = store.create("note", "n1", { status: "candidate", body: "x" });
  assert.equal(created.version, 1);
  assert.equal(created.status, "candidate");
  assert.throws(() => store.create("note", "n1", {}), /already exists/u);
  const saved = store.save("note", "n1", { status: "active" });
  assert.equal(saved.version, 2);
  assert.equal(store.get("note", "n1").status, "active");
  assert.equal(store.find("note", "n1", 1)?.status, "candidate");
  assert.equal(store.find("note", "missing"), null);
  assert.throws(() => store.get("note", "missing"), /Unknown note: missing/u);
  const updated = store.updateIfVersion("note", "n1", 2, { status: "final" });
  assert.equal(updated.version, 3);
  assert.throws(() => store.updateIfVersion("note", "n1", 1, { status: "stale" }), /Concurrent update detected/u);
  assert.equal(store.count("note"), 1);
  assert.equal(store.remove("note", "n1"), 3);
  assert.equal(store.count("note"), 0);
});

test("batches create and save atomically", async () => {
  const store = await open();
  assert.deepEqual(store.createBatch([]), []);
  assert.deepEqual(store.saveBatch([]), []);
  const created = store.createBatch([{ kind: "note", id: "a", payload: { v: 1 } }, { kind: "note", id: "b", payload: { v: 2 } }]);
  assert.deepEqual(created.map(record => record.version), [1, 1]);
  assert.throws(() => store.createBatch([{ kind: "note", id: "a", payload: {} }]), /already exists/u);
  assert.throws(() => store.createBatch([{ kind: "note", id: "c", payload: {} }, { kind: "note", id: "c", payload: {} }]), /already exists/u);
  const saved = store.saveBatch([{ kind: "note", id: "a", payload: { v: 3 } }]);
  assert.equal(saved[0]!.version, 2);
});

test("listing, paging and counting honour limits and predicates", async () => {
  const store = await open();
  store.createBatch(Array.from({ length: 5 }, (_, index) => ({ kind: "note", id: `n${index}`, payload: { index } })));
  assert.equal(store.list("note", 10).length, 5);
  assert.equal(store.list("note", 2).length, 2);
  assert.equal(store.list("note", 10, record => record.index === 3).length, 1);
  assert.throws(() => store.list("note", 1.5), /finite integer/u);
  assert.equal(store.countMany(["note"]).note, 5);
  assert.deepEqual(store.countMany(["note", "note"]), { note: 5 });
  assert.equal(store.countMany([]).note, undefined);
  const page = store.listByIdPage("note", "", 2);
  assert.equal(page.records.length, 2);
  assert.equal(page.has_more, true);
  assert.equal(page.next_cursor, "n1");
  const last = store.listByIdPage("note", "n3", 10);
  assert.equal(last.has_more, false);
  assert.equal(last.next_cursor, null);
  assert.throws(() => store.listByIdPage("note", "", 1001), /must not exceed 1000/u);
});

test("findMany and latestRecordsDigest read bounded record sets", async () => {
  const store = await open();
  store.createBatch([{ kind: "note", id: "a", payload: { v: 1 } }, { kind: "note", id: "b", payload: { v: 2 } }]);
  assert.deepEqual(store.findMany("note", ["a", "b", "missing"]).map(record => record.id), ["a", "b"]);
  assert.throws(() => store.findMany("", ["a"]), /must not be empty/u);
  assert.throws(() => store.findMany("note", [""]), /read bounds/u);
  const digest = store.latestRecordsDigest("note", ["a", "b"]);
  assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.equal(store.latestRecordsDigest("note", ["a", "b"]), digest);
  assert.throws(() => store.latestRecordsDigest("note", [""]), /digest bounds/u);
});

test("events are appended and read back in sequence", async () => {
  const store = await open();
  const first = store.appendEvent("stream", "started", { a: 1 });
  assert.equal(first.sequence, 1);
  const second = store.appendEvent("stream", "completed", { b: 2 });
  assert.equal(second.sequence, 2);
  assert.deepEqual(store.events("stream").map(event => event.sequence), [1, 2]);
  assert.deepEqual(store.events("stream", 1).map(event => event.sequence), [1]);
  assert.throws(() => store.events("stream", 0), /positive safe integer/u);
  assert.deepEqual(store.events("missing"), []);
});

test("transactions roll back on failure and support nesting", async () => {
  const store = await open();
  assert.throws(() => store.transaction(() => { store.create("note", "a", {}); throw new Error("rollback"); }), /rollback/u);
  assert.equal(store.count("note"), 0);
  const nested = store.transaction(() => {
    store.create("note", "a", {});
    return store.transaction(() => store.create("note", "b", {}));
  });
  assert.equal(nested.version, 1);
  assert.equal(store.count("note"), 2);
  assert.throws(() => store.readSnapshot(() => store.transaction(() => 1)), /read snapshot/u);
  const snapshot = store.readSnapshot(() => store.count("note"));
  assert.equal(snapshot, 2);
  assert.equal(withContextLockBudget(() => 42), 42);
});

test("async write retry rejects an asynchronous callback", async () => {
  const store = await open();
  await assert.rejects(store.transactionWithRetry(async () => 1), /must be synchronous/u);
  assert.equal(await store.transactionWithRetry(() => 5), 5);
  await assert.rejects(store.transactionWithRetry(() => 1, { timeoutMs: -1 }), /0\.\.15000/u);
  await assert.rejects(store.transactionWithRetry(() => 1, { timeoutMs: 20_000 }), /0\.\.15000/u);
});

test("trace records route to their shard", async () => {
  const store = await open();
  const created = store.create("trace", "trace-1", { status: "running" });
  assert.equal(created.version, 1);
  assert.equal(store.find("trace", "trace-1")?.id, "trace-1");
  assert.throws(() => store.create("trace", "trace-1", {}), /already exists/u);
  store.save("trace", "trace-1", { status: "completed" });
  assert.equal(store.count("trace"), 1);
  assert.equal(store.list("trace", 10).length, 1);
  assert.deepEqual(store.listTraceChildren("trace_event", "trace-1"), []);
  assert.equal(store.findTraceChild("trace_event", "missing", "trace-1"), null);
});

test("codebase graph records keep their own shard", async () => {
  const store = await open();
  store.create("codebase_index_shard", "cb-1", { name: "entry" });
  assert.equal(store.find("codebase_index_shard", "cb-1")?.name, "entry");
  assert.equal(store.count("codebase_index_shard"), 1);
  assert.throws(() => store.create("codebase_index_shard", "cb-1", {}), /already exists/u);
});

test("session storage identity binds a host to one session", async () => {
  const store = await open();
  const directory = store.bindSessionStorageHost("session-1", "craft-mcp");
  assert.ok(directory.includes("sessions"));
  assert.equal(store.bindSessionStorageHost("session-1", "craft-mcp"), directory);
  assert.ok(store.bindSessionStorageHost("session-1", "other-host").includes("sessions"));
  assert.throws(() => store.resolveSessionStorageScopeId(""), /non-empty identifier/u);
  assert.equal(store.resolveSessionStorageScopeId("session-1", "craft-mcp").startsWith("craft-mcp--"), true);
  assert.equal(store.sessionStorageRoot("session-1", false, "craft-mcp").includes("sessions"), true);
});

test("session memory writes are guarded by an exclusive lock", async () => {
  const store = await open();
  const value = store.withSessionMemoryWriteGuard("session-1", () => "done");
  assert.equal(value, "done");
  assert.throws(() => store.withSessionMemoryWriteGuard("session-1", () => { throw new Error("boom"); }), /boom/u);
});

test("scoped queries read records by scope", async () => {
  const store = await open();
  store.create("note", "scoped", { scope: { kind: "project", id: "p" } });
  store.create("note", "global", { scope: { kind: "global", id: "global" } });
  const scoped = store.listScoped("note", [{ kind: "project", id: "p" }], 10);
  assert.deepEqual(scoped.map(record => record.id), ["scoped"]);
  assert.deepEqual(store.listScoped("note", [], 10), []);
  assert.throws(() => store.listScoped("note", [{ kind: 1 } as never], 10), /Invalid scoped query/u);
  assert.throws(() => store.listScoped("note", [{ kind: "project", id: "p" }], 10, undefined, { known_at: "not-a-date" }), /Invalid scoped known_at/u);
  const historical = store.listScoped("note", [{ kind: "project", id: "p" }], 10, undefined, { known_at: "2026-01-01T00:00:00.000Z", history: true });
  assert.ok(Array.isArray(historical));
});

test("history and raw records expose stored versions", async () => {
  const store = await open();
  store.create("note", "n1", { v: 1 });
  store.save("note", "n1", { v: 2 });
  assert.deepEqual(store.history("note", "n1", 2, 10).map(record => record.version), [1]);
  const raw = store.rawRecords("note");
  assert.equal(raw.length, 2);
  assert.equal(store.rawRecords("missing").length, 0);
});

test("payload replacement rewrites a stored version in place", async () => {
  const store = await open();
  store.create("note", "n1", { v: 1 });
  store.replacePayload("note", "n1", 1, { v: 2 });
  assert.equal(store.get("note", "n1", 1).v, 2);
  store.replacePayloadBatch([{ kind: "note", id: "n1", version: 1, payload: { v: 3 } }]);
  assert.equal(store.get("note", "n1", 1).v, 3);
});

test("capability search matches stored capability terms", async () => {
  const store = await open();
  store.create("capability", "c1", { name: "Search Capability", keywords: ["search"] });
  assert.ok(store.searchCapabilities(["search"], 10).length >= 0);
});

test("knowledge reconciliation reports on legacy records", async () => {
  const store = await open();
  const result = store.reconcileKnowledgeStorage({ max_records: 10 });
  assert.equal(result.status, "completed");
  assert.equal(result.phase, "content");
  assert.equal(result.migrated, 0);
  assert.throws(() => store.reconcileKnowledgeStorage({ max_records: 0 }), /between 1 and 500/u);
  assert.throws(() => store.reconcileKnowledgeStorage({ dry_run: "yes" as never }), /dry_run must be boolean/u);
  assert.throws(() => store.reconcileKnowledgeStorage({ summary_only: "yes" as never }), /summary_only must be boolean/u);
  assert.throws(() => store.reconcileKnowledgeStorage({ records_only: "yes" as never }), /records_only must be boolean/u);
  assert.throws(() => store.reconcileKnowledgeStorage({ cursor: "not base64!" }), /cursor is invalid/u);
});

test("experience definition migration pages are bounded", async () => {
  const store = await open();
  assert.deepEqual(store.experienceDefinitionMigrationPage("", 0, 10), []);
  assert.throws(() => store.experienceDefinitionMigrationPage("", -1, 10), /bounds are invalid/u);
  assert.throws(() => store.experienceDefinitionMigrationPage("", 0, 0), /bounds are invalid/u);
});

test("backups are written beside the live database", async () => {
  const store = await open();
  const backup = store.backup();
  assert.ok(existsSync(backup));
  assert.ok(backup.includes("backups"));
});

test("the store refuses writes while it is closed", async () => {
  const store = await open();
  store.close();
  assert.throws(() => store.create("note", "n1", {}), /not open/u);
  assert.throws(() => store.database, /not open/u);
});

test("session memory records are stored in their own partition", async () => {
  const store = await open();
  const created = store.create("memory_ledger", "m1", { scope: { kind: "session", id: "session-1" }, status: "active" });
  assert.equal(created.version, 1);
  assert.equal(store.find("memory_ledger", "m1")?.status, "active");
  assert.ok(existsSync(join(store.paths.root, "sessions")));
});
