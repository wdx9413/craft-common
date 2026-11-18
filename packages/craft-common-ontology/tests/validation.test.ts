import assert from "node:assert/strict";
import test from "node:test";
import { CONCEPT_KINDS, RELATION_KINDS, isConceptKind, isRelationKind } from "../src/concepts.ts";
import { checkConceptConsistency, checkRelationConcepts, mapLegacyKind, validateConcept } from "../src/validation.ts";

test("concept guards only accept own taxonomy values", () => {
  for (const kind of CONCEPT_KINDS) assert.equal(isConceptKind(kind), true);
  for (const relation of RELATION_KINDS) assert.equal(isRelationKind(relation), true);
  for (const value of [undefined, null, 1, "toString", "constructor", "__proto__", "not-a-kind"]) {
    assert.equal(isConceptKind(value), false);
    assert.equal(isRelationKind(value), false);
  }
});

test("concept writes normalize text and reject invalid shape and filler", () => {
  assert.deepEqual(validateConcept("fact", "  A   verified fact. "), { kind: "fact", statement: "A verified fact." });
  assert.throws(() => validateConcept("constructor", "unsafe"), /concept kind must be one of/u);
  assert.throws(() => validateConcept("fact", null), /non-empty string/u);
  assert.throws(() => validateConcept("fact", "x".repeat(301)), /300 characters or fewer/u);
  assert.throws(() => validateConcept("fact", "tbd"), /filler phrase/u);
  assert.throws(() => validateConcept("fact", "以上内容适用"), /stand on its own/u);
});

test("legacy mappings are explicit and reject unsupported values", () => {
  assert.equal(mapLegacyKind("knowledge", "failure_mode"), "rule");
  assert.equal(mapLegacyKind("memory", "working"), "fact");
  assert.equal(mapLegacyKind("memory", "episodic"), "fact");
  assert.equal(mapLegacyKind("memory", "preference"), "preference");
  assert.equal(mapLegacyKind("memory", "procedural"), "procedure");
  assert.equal(mapLegacyKind("experience", "scenario"), "procedure");
  assert.throws(() => mapLegacyKind("knowledge", "unknown"), /unsupported knowledge kind/u);
});

test("typed relations reject invalid known endpoints but allow historical missing tags", () => {
  assert.deepEqual(checkRelationConcepts("contradicts", "fact", "preference"), {
    valid: false,
    reason: "contradicts cannot end at a preference",
  });
  assert.deepEqual(checkRelationConcepts("refines", "fact", "term"), {
    valid: false,
    reason: "refines cannot start at a fact",
  });
  assert.deepEqual(checkRelationConcepts("references", "old-kind", undefined), { valid: true, reason: null });
  assert.deepEqual(checkRelationConcepts("refines", "fact", undefined), { valid: true, reason: null });
  assert.deepEqual(checkRelationConcepts("contradicts", "fact", "fact"), { valid: true, reason: null });
  assert.throws(() => checkRelationConcepts("made-up", "fact", "fact"), /relation must be one of/u);
});

test("consistency diagnostics report only obvious duplicate terms and polarity conflicts", () => {
  const issues = checkConceptConsistency([
    { id: "term-a", concept_kind: "term", subject: "CQRS", statement: "Separates reads and writes." },
    { id: "term-b", concept_kind: "term", subject: " cqrs ", statement: "A message bus." },
    { id: "rule-a", concept_kind: "rule", subject: "package manager", statement: "Use pnpm in this repository." },
    { id: "rule-b", concept_kind: "rule", subject: "PACKAGE MANAGER", statement: "Never use pnpm here." },
    { id: "rule-c", concept_kind: "rule", subject: "安全策略", statement: "禁止关闭审计。" },
    { id: "rule-d", concept_kind: "rule", subject: "安全策略", statement: "关闭审计以便调试。" },
    { id: "fact", concept_kind: "fact", subject: "package manager", statement: "Uses pnpm." },
    { id: "unscoped", concept_kind: "rule", statement: "Never change this." },
    { id: "empty-rule", concept_kind: "rule", statement: "   " },
    { id: "bad", concept_kind: "fact", statement: null },
  ]);
  assert.deepEqual(issues, [
    { kind: "duplicate_term_definition", recordIds: ["term-a", "term-b"] },
    { kind: "conflicting_rule", recordIds: ["rule-a", "rule-b"] },
    { kind: "conflicting_rule", recordIds: ["rule-c", "rule-d"] },
  ]);
  assert.deepEqual(checkConceptConsistency([]), []);
});
