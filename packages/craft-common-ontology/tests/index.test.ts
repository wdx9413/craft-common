import assert from "node:assert/strict";
import test from "node:test";
import * as ontology from "../src/index.ts";

test("ontology package entry exports its public surface", () => {
  for (const name of ["CONCEPTS", "CONCEPT_KINDS", "RELATION_KINDS", "isConceptKind", "isRelationKind", "validateConcept",
    "validateConceptBody", "checkConceptConsistency", "checkRelationConcepts", "mapLegacyKind", "EVOLUTION_VALUE_ACTIONS", "evaluateEvolutionValue"]) {
    assert.ok(name in ontology, `missing export ${name}`);
  }
});
