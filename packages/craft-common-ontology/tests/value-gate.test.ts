import assert from "node:assert/strict";
import test from "node:test";
import { EVOLUTION_VALUE_ACTIONS, evaluateEvolutionValue } from "../src/value-gate.ts";

test("value gate actions are the documented closed set", () => {
  assert.deepEqual([...EVOLUTION_VALUE_ACTIONS], ["store_as_fact", "store_as_preference", "candidate_procedure", "candidate_mod", "ignore", "needs_review"]);
});

test("empty and unsafe statements are ignored", () => {
  assert.equal(evaluateEvolutionValue({}).action, "ignore");
  assert.equal(evaluateEvolutionValue({ statement: "   " }).reason, "empty statement");
  assert.equal(evaluateEvolutionValue({ statement: 42 }).action, "ignore");
  assert.equal(evaluateEvolutionValue({ statement: "api_key: abcdefgh" }).reason, "credential or placeholder rejected");
  assert.equal(evaluateEvolutionValue({ statement: "token = abcdefgh" }).action, "ignore");
  assert.equal(evaluateEvolutionValue({ statement: "请不要记住这个" }).reason, "explicit opt-out");
  assert.equal(evaluateEvolutionValue({ statement: "do not remember this" }).action, "ignore");
});

test("oversized statements require review", () => {
  const decision = evaluateEvolutionValue({ statement: "x".repeat(301) });
  assert.equal(decision.action, "needs_review");
  assert.equal(decision.reason, "statement exceeds durable-record limit");
});

test("preferences, rules and project facts are classified", () => {
  assert.equal(evaluateEvolutionValue({ statement: "I prefer pnpm" }).action, "store_as_preference");
  assert.equal(evaluateEvolutionValue({ statement: "我更喜欢 pnpm" }).action, "store_as_preference");
  assert.equal(evaluateEvolutionValue({ statement: "必须使用 pnpm" }).action, "store_as_fact");
  assert.equal(evaluateEvolutionValue({ statement: "本项目约定：使用 pnpm" }).action, "store_as_fact");
  assert.equal(evaluateEvolutionValue({ statement: "the project uses pnpm" }).action, "store_as_fact");
});

test("operating steps require verification or repetition", () => {
  assert.deepEqual(evaluateEvolutionValue({ statement: "how to deploy: run make" }),
    { ...evaluateEvolutionValue({ statement: "how to deploy: run make" }), action: "needs_review" });
  assert.equal(evaluateEvolutionValue({ statement: "how to deploy: run make", verification: "passed" }).action, "candidate_procedure");
  assert.equal(evaluateEvolutionValue({ statement: "how to deploy: run make", verification: true }).action, "candidate_procedure");
  assert.equal(evaluateEvolutionValue({ statement: "how to deploy: run make", repetitions: 2 }).action, "candidate_procedure");
  assert.equal(evaluateEvolutionValue({ statement: "先安装依赖再运行测试" }).action, "needs_review");
});

test("failures are mods only with evidence", () => {
  assert.equal(evaluateEvolutionValue({ statement: "timeout", source_kind: "failure" }).action, "needs_review");
  const mod = evaluateEvolutionValue({ statement: "timeout", source_kind: "failure", evidence_ids: [{ id: "e1" }] });
  assert.equal(mod.action, "candidate_mod");
  assert.deepEqual(mod.source_refs, [{ id: "e1" }]);
  assert.equal(evaluateEvolutionValue({ statement: "timeout", verification: "failed", artifact_refs: [{ id: "a" }] }).action, "candidate_mod");
});

test("explicit and repeated verified signals are handled", () => {
  assert.equal(evaluateEvolutionValue({ statement: "remember this", explicit: true }).action, "needs_review");
  assert.equal(evaluateEvolutionValue({ statement: "retry is needed", verification: "passed", evidence_ids: [{ id: "e" }], repetitions: 2 }).action, "candidate_procedure");
  assert.equal(evaluateEvolutionValue({ statement: "ordinary text" }).reason, "ordinary task text");
  assert.equal(evaluateEvolutionValue({ statement: "ordinary text", verification: "passed", evidence_ids: [{ id: "e" }] }).action, "ignore");
});

test("scope and reference fields are bounded and digestable", () => {
  const decision = evaluateEvolutionValue({
    statement: "I prefer pnpm",
    scope: { kind: "project", id: "p" },
    domain: " coding ",
    device_id: "dev-1",
    path: "src",
    evidence_ids: [{ id: "e1" }, null, [], "bad", { id: "e2" }],
    note_refs: [
      { member: "craft_notes", subject_type: "file", id: "n1", version: 1 },
      { member: "other", subject_type: "file", id: "n2", version: 1 },
      { member: "craft_notes", subject_type: "unknown", id: "n3", version: 1 },
      { member: "craft_notes", subject_type: "device", id: "", version: 1 },
      { member: "craft_notes", subject_type: "directory", id: "n4", version: 1.5 },
    ],
  });
  assert.equal(decision.scope.domain, "coding");
  assert.equal(decision.scope.device_id, "dev-1");
  assert.equal(decision.scope.path, "src");
  assert.deepEqual(decision.scope.note_refs, [{ member: "craft_notes", subject_type: "file", id: "n1", version: 1 }]);
  assert.deepEqual(decision.note_refs, decision.scope.note_refs);
  assert.deepEqual(decision.source_refs, [{ id: "e1" }, { id: "e2" }]);
  assert.match(decision.digest, /^[a-f0-9]{64}$/u);
  assert.equal(decision.gate_version, "evolution-value-gate.v1");
  assert.equal(evaluateEvolutionValue({ statement: "ordinary", scope: [] }).scope.domain, undefined);
  assert.equal(evaluateEvolutionValue({ statement: "ordinary", note_refs: "x" }).note_refs.length, 0);
});
