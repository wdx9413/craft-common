export { CONCEPTS, CONCEPT_KINDS, EMPTY_PHRASES, RELATION_KINDS, RELATION_TYPES, isConceptKind, isRelationKind } from "./concepts.ts";
export type { ConceptDefinition, ConceptKind, RelationKind, RelationTypeRule } from "./concepts.ts";
export { CONCEPT_MAX_LENGTH, checkConceptConsistency, checkRelationConcepts, mapLegacyKind, validateConcept, validateConceptBody } from "./validation.ts";
export type { ConceptConsistencyIssue, ConceptValidationResult, RelationConceptCheck } from "./validation.ts";
export { EVOLUTION_VALUE_ACTIONS, evaluateEvolutionValue } from "./value-gate.ts";
export type { EvolutionValueAction, EvolutionValueDecision, EvolutionValueInput } from "./value-gate.ts";
export { appendClassificationRevision, createOntologyVersion, ONTOLOGY_CONTRACT_VERSION } from "./evolution.ts";
export type { ClassificationRevision, ClassificationRevisionDecision, OntologyVersion, SemanticClassification } from "./evolution.ts";
