import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TraceShardStore, TRACE_KINDS, TRACE_SHARDED_KINDS } from "../src/trace-shards.ts";

const directories: string[] = [];
const stores: TraceShardStore[] = [];
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "craft-trace-"));
  directories.push(directory);
  return directory;
}
function store(): TraceShardStore {
  const opened = new TraceShardStore(root());
  stores.push(opened);
  return opened;
}
test.after(() => {
  for (const opened of stores) opened.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

test("trace kind sets include the hook journals without widening retention", () => {
  assert.deepEqual([...TRACE_KINDS], ["trace", "trace_event", "trace_feedback", "telemetry_event", "trace_archive"]);
  assert.equal(TRACE_SHARDED_KINDS.has("codex_hook_turn"), true);
  assert.equal(TRACE_KINDS.has("codex_hook_turn"), false);
});

test("trace shard store creates, saves and reads versioned records", () => {
  const shards = store();
  const created = shards.create("trace", "trace-1", { status: "running" });
  assert.equal(created.version, 1);
  assert.throws(() => shards.create("trace", "trace-1", {}), /already exists/u);
  const saved = shards.save("trace", "trace-1", { status: "completed" });
  assert.equal(saved.version, 2);
  assert.equal((shards.find("trace", "trace-1") as { status: string }).status, "completed");
  assert.equal((shards.find("trace", "trace-1", 1) as { status: string }).status, "running");
  assert.equal(shards.find("trace", "missing"), null);
  assert.equal(shards.count("trace"), 1);
  assert.equal(shards.find("trace_event", "x"), null);
  assert.throws(() => shards.transaction("", () => 1), /must not be empty/u);
});

test("trace shard store lists latest children and retention candidates", () => {
  const shards = store();
  shards.create("trace", "trace-1", { status: "completed", last_event_at: "2025-01-01T00:00:00.000Z" });
  shards.create("trace_event", "event-1", { trace_id: "trace-1", status: "completed" });
  shards.create("trace_event", "event-2", { trace_id: "trace-1" });
  shards.save("trace_event", "event-1", { trace_id: "trace-1", status: "failed" });
  assert.equal(shards.list("trace_event", 10).length, 2);
  assert.equal(shards.list("trace_event", 10, record => record.status === "failed").length, 1);
  assert.equal(shards.children("trace_event", "trace-1").length, 2);
  assert.deepEqual(shards.children("trace_event", "missing"), []);
  assert.equal(shards.retentionCandidates("2026-01-01T00:00:00.000Z", 10).length, 1);
});

test("trace shard events and lookups support hook signals", () => {
  const shards = store();
  const first = shards.appendEvent("trace-1", "started", { a: 1 });
  assert.equal(first.sequence, 1);
  const second = shards.appendEvent("trace-1", "completed", { b: 2 });
  assert.equal(second.sequence, 2);
  assert.deepEqual(shards.events("trace-1").map(event => event.sequence), [1, 2]);
  assert.deepEqual(shards.events("trace-1", 1).map(event => event.sequence), [1]);
  assert.throws(() => shards.events("trace-1", 0), /positive safe integer/u);
  assert.deepEqual(shards.events("missing"), []);
  shards.create("codex_hook_signal", "signal-1", { trace_id: "trace-1", scope: { kind: "session", id: "s" }, session_id: "s", turn_id: "t", observed_at_ms: 2, session_host: "h" });
  shards.create("codex_hook_signal", "signal-2", { trace_id: "trace-1", scope: { kind: "session", id: "s" }, session_id: "s", turn_id: "t", observed_at_ms: 1, session_host: "other" });
  assert.deepEqual(shards.hookSignalsForTurn("session", "s", "s", "t", 10, "h").map(item => item.id), ["signal-1"]);
  assert.deepEqual(shards.hookSignalsForTurn("", "s", "s", "t", 10), []);
  assert.deepEqual(shards.hookSignalsForTurn("session", "s", "s", "t", 0), []);
});

test("trace shard removes a trace and its children", () => {
  const shards = store();
  shards.create("trace", "trace-1", {});
  shards.create("trace_event", "event-1", { trace_id: "trace-1" });
  shards.create("trace_feedback", "feedback-1", { trace_id: "trace-1" });
  shards.create("telemetry_event", "telemetry-1", { trace_id: "trace-1" });
  shards.appendEvent("trace-1", "started", {});
  assert.equal(shards.remove("trace-1", ["event-1"], ["feedback-1"], ["telemetry-1"]), 5);
  assert.equal(shards.find("trace", "trace-1"), null);
  assert.equal(shards.remove("missing", [], [], []), 0);
});

test("trace shard import is idempotent and detects conflicts", () => {
  const shards = store();
  const records = [{ kind: "trace", id: "trace-1", version: 1, payload_json: JSON.stringify({ status: "running" }), created_at: "a", updated_at: "b" }];
  const events = [{ stream: "trace:trace-1", sequence: 1, event_type: "started", payload_json: "{}", created_at: "a" }];
  shards.importLegacy("trace-1", records, events);
  shards.importLegacy("trace-1", records, events);
  assert.equal(shards.find("trace", "trace-1")?.version, 1);
  assert.throws(() => shards.importLegacy("trace-1", [{ ...records[0]!, payload_json: "{}" }], []), /conflicts/u);
  assert.throws(() => shards.importLegacy("trace-1", [{ ...records[0]!, id: "other" }], []), /different owner/u);
  assert.throws(() => shards.importLegacy("trace-1", [], [{ ...events[0]!, stream: "trace:other" }]), /different owner/u);
});

test("trace shard transaction supports nested savepoints and rollback", () => {
  const shards = store();
  const value = shards.transaction("trace-1", () => {
    shards.create("trace", "trace-1", {});
    return shards.transaction("trace-1", () => shards.save("trace", "trace-1", { a: 1 }));
  });
  assert.equal(value.version, 2);
  assert.throws(() => shards.transaction("trace-1", () => { shards.save("trace", "trace-1", { a: 2 }); throw new Error("rollback"); }), /rollback/u);
  assert.equal(shards.find("trace", "trace-1")?.version, 2);
});

test("trace shard rejects symlinked or non-directory roots", () => {
  const directory = root();
  const shards = new TraceShardStore(join(directory, "file"));
  stores.push(shards);
  const database = new DatabaseSync(join(directory, "file"), {});
  database.exec("CREATE TABLE x(a)"); database.close();
  assert.throws(() => shards.create("trace", "trace-1", {}), /ENOTDIR|regular directories/u);
});
