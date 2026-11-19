import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CODEBASE_GRAPH_KINDS, CodebaseShardStore } from "../src/codebase-shards.ts";

const directories: string[] = [];
const stores: CodebaseShardStore[] = [];
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "craft-codebase-"));
  directories.push(directory);
  return directory;
}
function store(): CodebaseShardStore {
  const opened = new CodebaseShardStore(root());
  stores.push(opened);
  return opened;
}
test.after(() => {
  for (const opened of stores) opened.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

test("codebase graph kinds are the two sharded record kinds", () => {
  assert.deepEqual([...CODEBASE_GRAPH_KINDS], ["codebase_index_shard", "codebase_index_edge_route"]);
});

test("codebase shard store saves, reads and versions records", () => {
  const shards = store();
  assert.equal(shards.raw("codebase_index_shard", "missing"), null);
  assert.equal(shards.find("codebase_index_shard", "missing"), null);
  const saved = shards.save("codebase_index_shard", "id-1", { name: "entry", id: "ignored", version: 99 });
  assert.equal(saved.version, 1);
  assert.equal(saved.name, "entry");
  assert.equal(saved.id, "id-1");
  const updated = shards.save("codebase_index_shard", "id-1", { name: "entry-2" });
  assert.equal(updated.version, 2);
  assert.equal((shards.find("codebase_index_shard", "id-1") as { name: string }).name, "entry-2");
  assert.equal((shards.find("codebase_index_shard", "id-1", 1) as { name: string }).name, "entry");
  assert.equal(shards.count("codebase_index_shard"), 1);
  assert.throws(() => shards.raw("other", "id"), /Unsupported Codebase graph kind/u);
  assert.throws(() => shards.save("other", "id", {}), /Unsupported Codebase graph kind/u);
});

test("codebase shard history returns earlier versions", () => {
  const shards = store();
  shards.save("codebase_index_shard", "id-1", { v: 1 });
  shards.save("codebase_index_shard", "id-1", { v: 2 });
  shards.save("codebase_index_shard", "id-1", { v: 3 });
  const history = shards.history("codebase_index_shard", "id-1", 3, 10);
  assert.deepEqual(history.map(record => record.version), [2, 1]);
  assert.deepEqual(shards.history("codebase_index_shard", "missing", 3, 10), []);
  assert.throws(() => shards.history("other", "id", 1, 1), /Unsupported Codebase graph kind/u);
});

test("codebase shard list and predicate filter the latest versions", () => {
  const shards = store();
  shards.save("codebase_index_shard", "a", { kind: "one" });
  shards.save("codebase_index_shard", "b", { kind: "two" });
  shards.save("codebase_index_shard", "a", { kind: "one-updated" });
  const all = shards.list("codebase_index_shard", 10);
  assert.equal(all.length, 2);
  assert.deepEqual(shards.list("codebase_index_shard", 10, record => record.kind === "two").map(record => record.id), ["b"]);
  assert.deepEqual(shards.list("codebase_index_shard", 10, record => record.kind === "none"), []);
});

test("codebase shard import is idempotent and rejects foreign owners", () => {
  const shards = store();
  const rows = [{ kind: "codebase_index_shard", id: "id-1", version: 1, payload_json: JSON.stringify({ name: "x" }), created_at: "a", updated_at: "b" }];
  shards.importLegacy("id-1", rows);
  shards.importLegacy("id-1", rows);
  assert.equal(shards.find("codebase_index_shard", "id-1")?.version, 1);
  assert.throws(() => shards.importLegacy("id-1", [{ ...rows[0]!, payload_json: "{}" }]), /conflicts/u);
  assert.throws(() => shards.importLegacy("id-1", [{ ...rows[0]!, id: "other" }]), /different owner/u);
  assert.throws(() => shards.importLegacy("id-1", [{ ...rows[0]!, kind: "other" }]), /different owner/u);
});

test("codebase shard store rejects empty ids", () => {
  const shards = store();
  assert.throws(() => shards.save("codebase_index_shard", "", {}), /must not be empty/u);
});
