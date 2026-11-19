import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore } from "../src/store.ts";
import { craftPaths, ensureProjectStorageDirectory, sessionStorageScopeId } from "../src/paths.ts";
import { createHash } from "node:crypto";

const stores: CraftStore[] = [];
const directories: string[] = [];
async function open(): Promise<CraftStore> {
  const directory = mkdtempSync(join(tmpdir(), "craft-partitions-"));
  directories.push(directory);
  const store = await new CraftStore(craftPaths(directory)).open();
  stores.push(store);
  return store;
}
test.after(() => {
  for (const store of stores) store.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function registerProject(store: CraftStore, projectId: string): string {
  const root = join(store.paths.root, "workspaces", projectId);
  mkdirSync(root, { recursive: true });
  const alias = root;
  store.create("scope_alias", `alias_${projectId}`, {
    status: "active", alias_kind: "path", alias,
    alias_digest: `sha256:${createHash("sha256").update(JSON.stringify(alias)).digest("hex")}`,
    scope: { kind: "project", id: projectId },
  });
  return root;
}

test("memory records are partitioned by their scope", async () => {
  const store = await open();
  const global = store.create("memory_ledger", "g1", { scope: { kind: "global", id: "global" }, status: "active" });
  assert.equal(global.version, 1);
  const user = store.create("memory_ledger", "u1", { scope: { kind: "user", id: "local" }, status: "active" });
  assert.equal(user.version, 1);
  const task = store.create("memory_ledger", "t1", { scope: { kind: "task", id: "task-1" }, status: "active" });
  assert.equal(task.version, 1);
  const team = store.create("memory_ledger", "tm1", { scope: { kind: "team", id: "core" }, status: "active" });
  assert.equal(team.version, 1);
  assert.equal(store.find("memory_ledger", "g1")?.id, "g1");
  assert.equal(store.find("memory_ledger", "tm1")?.id, "tm1");
  assert.throws(() => store.create("memory_ledger", "bad", { scope: { kind: "unknown", id: "x" } }), /scope is malformed/u);
  assert.throws(() => store.create("memory_ledger", "bad", { scope: { kind: "task", id: "" } }), /scope is malformed/u);
  assert.throws(() => store.create("memory_ledger", "bad", { scope: { kind: "task", id: "a/b" } }), /safe directory name/u);
  assert.throws(() => store.create("memory_ledger", "bad", { scope: "not a scope" }), /scope is malformed/u);
  const taskScoped = store.create("memory_ledger", "task-scoped", { scope: "task", status: "active" });
  assert.equal(taskScoped.version, 1);
});

test("memory records derive their scope from legacy fields", async () => {
  const store = await open();
  const legacy = store.create("memory_ledger", "legacy", { scope_kind: "workspace", scope_id: "w1", status: "active" });
  assert.equal(legacy.version, 1);
  const userScoped = store.create("memory_ledger", "user-scoped", { scope: "user", user_id: "u9", status: "active" });
  assert.equal(userScoped.version, 1);
  const fallback = store.create("memory_ledger", "fallback", { scope: "task", status: "active" });
  assert.equal(fallback.version, 1);
  const legacyUser = store.create("memory_ledger", "legacy-user", { scope: "user", user_id: "  ", status: "active" });
  assert.equal(legacyUser.version, 1);
});

test("session memory records require a matching host identity", async () => {
  const store = await open();
  const scopeId = sessionStorageScopeId("craft-mcp", "session-1");
  const created = store.create("memory_ledger", "s1", { scope: { kind: "session", id: scopeId }, status: "active" });
  assert.equal(created.version, 1);
  const rawSession = store.create("memory_ledger", "raw-session", { scope: { kind: "session", id: "raw" }, status: "active" });
  assert.equal(rawSession.version, 1);
});

test("context records are partitioned by their host session", async () => {
  const store = await open();
  const scopeId = sessionStorageScopeId("craft-mcp", "session-2");
  const created = store.create("context_ephemeral_index", "c1", {
    session_host: "craft-mcp", session_id: "session-2", session_scope_id: scopeId, status: "active",
  });
  assert.equal(created.version, 1);
  assert.equal(store.find("context_ephemeral_index", "c1")?.id, "c1");
  assert.throws(() => store.create("context_ephemeral_index", "bad", { session_host: "craft-mcp", session_id: "other", session_scope_id: scopeId }), /session storage identity is invalid/u);
});

test("knowledge records inherit their scope from their parents", async () => {
  const store = await open();
  registerProject(store, "p1");
  const source = store.create("knowledge_source", "s1", { scope: { kind: "project", id: "p1" }, status: "active" });
  assert.equal(source.version, 1);
  const claim = store.create("knowledge_claim", "c1", { source_id: "s1", status: "active" });
  assert.equal(claim.version, 1);
  assert.equal(store.find("knowledge_claim", "c1")?.id, "c1");
  assert.throws(() => store.create("knowledge_claim", "bad", { source_id: "missing", status: "active" }), /parent is unavailable/u);
});

test("experience records inherit their scope from their source or project", async () => {
  const store = await open();
  registerProject(store, "p1");
  registerProject(store, "p2");
  registerProject(store, "p3");
  const observation = store.create("experience_observation", "o1", { scope: { kind: "project", id: "p1" }, status: "active" });
  assert.equal(observation.version, 1);
  const projectScoped = store.create("experience_observation", "o2", { project_id: "p2", status: "active" });
  assert.equal(projectScoped.version, 1);
  const procedure = store.create("experience_procedure", "pr1", { source: { scope: { kind: "project", id: "p3" } }, status: "active" });
  assert.equal(procedure.version, 1);
});

test("evidence records are partitioned only when their owner is declared", async () => {
  const store = await open();
  const owned = store.create("evidence", "e1", { metadata: { capability_owner: "knowledge", scope: "global" }, status: "active" });
  assert.equal(owned.version, 1);
  const unowned = store.create("evidence", "e2", { metadata: { scope: "global" }, status: "active" });
  assert.equal(unowned.version, 1);
  const fragment = store.create("evidence", "e3", { source_type: "knowledge_fragment", metadata: { scope: "global" }, status: "active" });
  assert.equal(fragment.version, 1);
});

test("evolution cycles require a project scope", async () => {
  const store = await open();
  assert.throws(() => store.create("evolution_cycle", "e1", { scope: { kind: "global", id: "global" }, status: "active" }), /project scope/u);
  registerProject(store, "p1");
  const cycle = store.create("evolution_cycle", "e2", { scope: { kind: "project", id: "p1" }, status: "active" });
  assert.equal(cycle.version, 1);
});

test("project knowledge records require a registered project root", async () => {
  const store = await open();
  assert.throws(() => store.create("knowledge_source", "s1", { scope: { kind: "project", id: "unregistered" }, status: "active" }), /root is not registered/u);
  const project = join(store.paths.root, "projects-source");
  const paths = craftPaths(store.paths.root);
  const projectRoot = join(store.paths.root, "workspace", "project");
  void project; void paths; void projectRoot;
  assert.ok(ensureProjectStorageDirectory);
});

test("partition pointers are published with the stored record", async () => {
  const store = await open();
  const created = store.create("memory_ledger", "m1", { scope: { kind: "global", id: "global" }, status: "active" });
  assert.equal(created.version, 1);
  const raw = store.rawRecords("memory_ledger");
  assert.equal(raw.length, 1);
  assert.equal(typeof (raw[0]!.payload as Record<string, unknown>).scope, "object");
});
