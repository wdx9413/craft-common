import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertContextReadCurrent, ContextAccessChangedError, ContextReadGuard } from "../src/context-access-guard.ts";
import { CraftStore } from "../src/store.ts";
import { craftPaths } from "../src/paths.ts";

const stores: CraftStore[] = [];
const directories: string[] = [];
async function open(): Promise<CraftStore> {
  const directory = mkdtempSync(join(tmpdir(), "craft-guard-"));
  directories.push(directory);
  const store = await new CraftStore(craftPaths(directory)).open();
  stores.push(store);
  return store;
}
test.after(() => {
  for (const store of stores) store.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

test("receipts without read refs need no verification", async () => {
  const store = await open();
  assert.doesNotThrow(() => assertContextReadCurrent(store, {}));
  assert.doesNotThrow(() => assertContextReadCurrent(store, { read_refs: [] }));
  assert.doesNotThrow(() => assertContextReadCurrent(store, null));
});

test("current read refs pass and changed versions fail", async () => {
  const store = await open();
  const record = store.create("memory_ledger", "m1", { scope: { kind: "global", id: "global" }, status: "active" });
  assert.doesNotThrow(() => assertContextReadCurrent(store, { read_refs: [{ kind: "memory_ledger", id: "m1", version: record.version }] }));
  store.save("memory_ledger", "m1", { status: "archived" });
  assert.throws(() => assertContextReadCurrent(store, { read_refs: [{ kind: "memory_ledger", id: "m1", version: 1 }] }), ContextAccessChangedError);
  assert.throws(() => assertContextReadCurrent(store, { read_refs: [{ kind: "memory_ledger", id: "m1", version: 1 }] }), /authorization or material state changed/u);
});

test("guards accept explicit refs and expose them sorted", async () => {
  const store = await open();
  store.create("memory_ledger", "a", { scope: { kind: "global", id: "global" }, status: "active" });
  store.create("memory_ledger", "b", { scope: { kind: "global", id: "global" }, status: "active" });
  const guard = new ContextReadGuard(store, [
    { kind: "memory_ledger", id: "b", version: 1 },
    { kind: "memory_ledger", id: "a", version: 1 },
  ]);
  guard.track("memory_ledger", "b");
  guard.track("memory_ledger", "a");
  assert.deepEqual(guard.refs().map(ref => ref.id), ["a", "b"]);
  assert.throws(() => guard.track("memory_ledger", "a", 2), ContextAccessChangedError);
  guard.track("memory_ledger", "a", 1);
  assert.doesNotThrow(() => guard.assertCurrent());
});

test("guards without refs snapshot every context kind", async () => {
  const store = await open();
  store.create("memory_ledger", "m1", { scope: { kind: "global", id: "global" }, status: "active" });
  const guard = new ContextReadGuard(store);
  guard.track("memory_ledger", "m1");
  assert.equal(guard.refs().length, 1);
  guard.assertCurrent();
});

test("scoped guards read only matching context records", async () => {
  const store = await open();
  store.create("memory_ledger", "m1", { scope: { kind: "global", id: "global" }, status: "active" });
  store.create("memory_ledger", "m2", { scope: { kind: "user", id: "local" }, status: "active" });
  const scoped = new ContextReadGuard(store, undefined, [{ kind: "global", id: "global" }]);
  scoped.track("memory_ledger", "m1");
  assert.deepEqual(scoped.refs().map(ref => ref.id), ["m1"]);
  const empty = new ContextReadGuard(store, undefined, []);
  assert.equal(empty.refs().length, 0);
});

test("contribution tracks memory, knowledge and experience records", async () => {
  const store = await open();
  store.create("memory_ledger", "mem", { scope: { kind: "global", id: "global" }, status: "active" });
  store.create("knowledge_source", "src", { scope: { kind: "global", id: "global" }, status: "active" });
  store.create("knowledge_document", "doc", { scope: { kind: "global", id: "global" }, status: "active" });
  store.create("knowledge_claim", "claim", { scope: { kind: "global", id: "global" }, status: "active", source_id: "src", document_id: "doc" });
  store.create("experience_procedure", "proc", { scope: { kind: "global", id: "global" }, status: "active" });
  const guard = new ContextReadGuard(store);
  guard.contribution("memory", { memory_id: "mem" });
  guard.contribution("knowledge", { claim_id: "claim" });
  guard.contribution("experience", { procedure_id: "proc" });
  guard.contribution("memory", {});
  guard.contribution("memory", { memory_id: "missing" });
  const kinds = guard.refs().map(ref => `${ref.kind}:${ref.id}`);
  assert.ok(kinds.includes("memory_ledger:mem"));
  assert.ok(kinds.includes("knowledge_claim:claim"));
  assert.ok(kinds.includes("experience_procedure:proc"));
  assert.ok(kinds.includes("knowledge_source:src"));
  assert.ok(kinds.includes("knowledge_document:doc"));
  guard.assertCurrent();
});

test("contribution accepts source ids attached to the item", async () => {
  const store = await open();
  store.create("knowledge_source", "src2", { scope: { kind: "global", id: "global" }, status: "active" });
  const guard = new ContextReadGuard(store);
  guard.contribution("knowledge", { claim_id: "missing", source_id: "src2" });
  assert.ok(guard.refs().some(ref => ref.kind === "knowledge_claim" && ref.id === "missing"));
});
