import assert from "node:assert/strict";
import test from "node:test";
import { CONTEXT_ASSET_MEMBERS, ContextBudget, ContextBudgetError, contextAssetKey, contextAssetMatches, contextAssetRef, DEFAULT_CONTEXT_MAX_CHARS, DEFAULT_CONTEXT_MAX_ITEMS, requiredContextRef } from "../src/context-assets.ts";

const scope = { kind: "project", id: "p" };

test("context asset references require an explicit identity and version", () => {
  assert.equal(CONTEXT_ASSET_MEMBERS.length, 6);
  assert.equal(DEFAULT_CONTEXT_MAX_ITEMS, 3);
  assert.equal(DEFAULT_CONTEXT_MAX_CHARS, 1200);
  const ref = contextAssetRef("memory", { memory_id: "m1", memory_version: 2, content_digest: "sha256:x" }, scope);
  assert.deepEqual(ref, { member: "memory", id: "m1", version: 2, content_version: 2, digest: "sha256:x",
    scope, source_id: null, index_id: null, checkpoint_id: null });
  assert.equal(contextAssetKey(ref), "memory:m1@2");
  assert.throws(() => contextAssetRef("unknown", {}, scope), /Unsupported Context asset member/u);
  assert.throws(() => contextAssetRef("memory", { id: "x", version: 0 }, scope), /must be explicit and positive/u);
  assert.throws(() => contextAssetRef("memory", { id: "x", version: "1" }, scope), /explicit and positive/u);
  assert.equal(contextAssetRef("memory", { id: "x", version: 1, content_version: 0 }, scope).content_version, 0);
});

test("context asset references resolve all supported identity fields", () => {
  const claim = contextAssetRef("knowledge", { claim_id: "c", claim_version: 1, definition_digest: "d", source_id: "s", scope: "project:p" }, scope);
  assert.deepEqual(claim, { member: "knowledge", id: "c", version: 1, content_version: 1, digest: "d", scope,
    source_id: "s", index_id: null, checkpoint_id: null });
  const procedure = contextAssetRef("experience", { procedure_id: "pr", procedure_version: 3, index_id: "i", checkpoint_id: "cp" }, scope);
  assert.equal(procedure.content_version, 3);
  assert.equal(procedure.index_id, "i");
  assert.equal(procedure.checkpoint_id, "cp");
  const node = contextAssetRef("codebase", { node_id: "n", record_version: 4, source_digest: "sd" }, { kind: "workspace", id: "w" });
  assert.equal(node.scope.kind, "workspace");
  const history = contextAssetRef("history", { ref_id: "h", version: 5, content_version: 7, content_digest: "d" }, scope);
  assert.equal(history.content_version, 7);
  const state = contextAssetRef("state", { id: "st", version: 1, content: { a: 1 } }, { kind: "task", id: "t" });
  assert.match(String(state.digest), /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(state.scope, { kind: "task", id: "t" });
});

test("asset matching compares only supplied constraints", () => {
  const actual = { member: "memory", id: "m", version: 2, digest: "d", index_id: "i", checkpoint_id: "c" };
  assert.equal(contextAssetMatches({ member: "memory", id: "m" }, actual), true);
  assert.equal(contextAssetMatches({ member: "knowledge", id: "m" }, actual), false);
  assert.equal(contextAssetMatches({ member: "memory", id: "m", version: 1 }, actual), false);
  assert.equal(contextAssetMatches({ member: "memory", id: "m", digest: "x" }, actual), false);
  assert.equal(contextAssetMatches({ member: "memory", id: "m", index_id: "x" }, actual), false);
  assert.equal(contextAssetMatches({ member: "memory", id: "m", checkpoint_id: "x" }, actual), false);
  assert.equal(contextAssetMatches({ member: "memory", id: "m", version: 2, digest: "d", index_id: "i", checkpoint_id: "c" }, actual), true);
});

test("required context refs reject malformed values", () => {
  assert.deepEqual(requiredContextRef({ member: "memory", id: "m", version: 1, digest: "d" }), { member: "memory", id: "m", version: 1, digest: "d" });
  assert.deepEqual(requiredContextRef({ member: "state", id: "s" }), { member: "state", id: "s" });
  for (const value of [null, [], "memory"]) assert.throws(() => requiredContextRef(value), /must be an object/u);
  assert.throws(() => requiredContextRef({ member: "other", id: "x" }), /Unsupported required Context member/u);
  assert.throws(() => requiredContextRef({ member: "memory", id: "" }), /id must not be empty/u);
  assert.throws(() => requiredContextRef({ member: "memory", id: "x", version: 0 }), /version must be positive/u);
  assert.throws(() => requiredContextRef({ member: "memory", id: "x", digest: "" }), /digest must not be empty/u);
});

test("context budgets enforce bounded reservations", () => {
  assert.throws(() => new ContextBudget(0, 10), (error: unknown) => error instanceof ContextBudgetError && /budget is invalid/u.test(error.message));
  assert.throws(() => new ContextBudget(1, 1.5), ContextBudgetError);
  const budget = new ContextBudget(2, 10);
  assert.equal(budget.reserve(1, 4, true, "required"), true);
  assert.equal(budget.items, 1);
  assert.equal(budget.chars, 4);
  assert.equal(budget.reserve(2, 1, false, "optional"), false);
  assert.throws(() => budget.reserve(2, 1, true, "required overflow"), (error: unknown) => error instanceof ContextBudgetError && error.message === "required overflow");
  assert.throws(() => budget.reserve(-1, 0, false, "x"), /nonnegative integer/u);
  assert.throws(() => budget.reserve(0, 1.5, false, "x"), /nonnegative integer/u);
  assert.equal(budget.reserve(1, 6, true, "fits"), true);
  assert.equal(budget.items, 2);
  assert.equal(budget.chars, 10);
});
