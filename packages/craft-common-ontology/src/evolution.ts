import { createHash } from "node:crypto";
import { CONCEPT_KINDS, RELATION_KINDS } from "./concepts.ts";

/** Version of the public Evolution Ontology data contract. */
export const ONTOLOGY_CONTRACT_VERSION = "craft.ontology.v1";

export interface OntologyVersion {
  readonly contract_version: typeof ONTOLOGY_CONTRACT_VERSION;
  readonly version: string;
  readonly parent_digest: string | null;
  readonly concept_kinds: readonly string[];
  readonly relation_kinds: readonly string[];
  readonly digest: string;
}

export interface SemanticClassification {
  readonly ontology_version: string;
  readonly concept_kind: string;
  readonly revision_id: string | null;
}

export interface ClassificationRevision {
  readonly id: string;
  readonly record_id: string;
  readonly record_digest: string;
  readonly ontology_version: string;
  readonly ontology_digest: string;
  readonly concept_kind: string;
  readonly confidence: number;
  readonly rationale: string;
  readonly created_at: string;
  readonly previous_revision_id: string | null;
  readonly previous_classification: SemanticClassification | null;
  readonly source_refs: readonly string[];
}

export interface ClassificationRevisionDecision {
  readonly status: "appended" | "unresolved" | "duplicate";
  readonly record_id: string;
  readonly record_digest: string;
  readonly revisions: readonly ClassificationRevision[];
  readonly effective_classification: SemanticClassification | null;
  readonly unresolved: {
    readonly ontology_version: string;
    readonly proposed_concept_kind: string;
    readonly confidence: number;
    readonly rationale: string;
    readonly reason: "below_confidence_threshold";
  } | null;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, name: string, maxLength = 256): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${name} must be ${maxLength} characters or fewer`);
  return normalized;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function uniqueNames(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be a non-empty array`);
  const names = value.map((item, index) => {
    const normalized = requiredText(item, `${name}[${index}]`, 64);
    if (!/^[a-z][a-z0-9_]*$/u.test(normalized)) throw new Error(`${name}[${index}] must be a lowercase semantic identifier`);
    return normalized;
  });
  if (new Set(names).size !== names.length) throw new Error(`${name} must not contain duplicates`);
  return [...names].sort();
}

function ontologyDigest(input: Omit<OntologyVersion, "digest">): string {
  return digest({ contract_version: input.contract_version, version: input.version, parent_digest: input.parent_digest,
    concept_kinds: [...input.concept_kinds], relation_kinds: [...input.relation_kinds] });
}

/**
 * Create an immutable, content-addressed Ontology version. New schemas must
 * retain the current shared vocabulary while they add concepts or relations.
 */
export function createOntologyVersion(input: unknown): OntologyVersion {
  const value = object(input, "ontology");
  const version = requiredText(value.version, "ontology.version", 128);
  const parentDigest = value.parent_digest === undefined || value.parent_digest === null
    ? null
    : requiredText(value.parent_digest, "ontology.parent_digest", 64);
  if (parentDigest !== null && !/^[a-f0-9]{64}$/u.test(parentDigest)) {
    throw new Error("ontology.parent_digest must be a SHA-256 hex digest");
  }
  const conceptKinds = uniqueNames(value.concept_kinds, "ontology.concept_kinds");
  const relationKinds = uniqueNames(value.relation_kinds, "ontology.relation_kinds");
  if (!CONCEPT_KINDS.every((kind) => conceptKinds.includes(kind))) {
    throw new Error("ontology.concept_kinds must retain the shared concept vocabulary");
  }
  if (!RELATION_KINDS.every((kind) => relationKinds.includes(kind))) {
    throw new Error("ontology.relation_kinds must retain the shared relation vocabulary");
  }
  const withoutDigest = { contract_version: ONTOLOGY_CONTRACT_VERSION, version, parent_digest: parentDigest,
    concept_kinds: conceptKinds, relation_kinds: relationKinds } as const;
  return { ...withoutDigest, digest: ontologyDigest(withoutDigest) };
}

function validateOntology(value: unknown): OntologyVersion {
  const raw = object(value, "ontology");
  if (raw.contract_version !== ONTOLOGY_CONTRACT_VERSION) throw new Error("ontology contract_version is unsupported");
  const validated = createOntologyVersion(raw);
  if (raw.digest !== validated.digest) throw new Error("ontology digest does not match its content");
  return validated;
}

function sourceRefs(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("record.source_refs must be an array");
  const refs = value.map((item, index) => requiredText(item, `record.source_refs[${index}]`, 512));
  if (new Set(refs).size !== refs.length) throw new Error("record.source_refs must not contain duplicates");
  return refs;
}

function classification(value: unknown, name: string): SemanticClassification {
  const raw = object(value, name);
  const ontologyVersion = requiredText(raw.ontology_version, `${name}.ontology_version`, 128);
  const conceptKind = requiredText(raw.concept_kind, `${name}.concept_kind`, 64);
  if (!/^[a-z][a-z0-9_]*$/u.test(conceptKind)) throw new Error(`${name}.concept_kind must be a lowercase semantic identifier`);
  const revisionId = raw.revision_id === undefined || raw.revision_id === null
    ? null
    : requiredText(raw.revision_id, `${name}.revision_id`, 128);
  return { ontology_version: ontologyVersion, concept_kind: conceptKind, revision_id: revisionId };
}

function isIsoDate(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function validateConfidence(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite number from 0 through 1`);
  }
  return value;
}

function validateRevision(value: unknown, recordId: string, recordDigest: string, sources: readonly string[], previous: ClassificationRevision | null): ClassificationRevision {
  const raw = object(value, "existing revision");
  const id = requiredText(raw.id, "revision.id", 128);
  if (raw.record_id !== recordId) throw new Error("revision belongs to a different record");
  if (raw.record_digest !== recordDigest) throw new Error("revision record digest does not match the original record");
  const ontologyVersion = requiredText(raw.ontology_version, "revision.ontology_version", 128);
  const ontologyDigest = requiredText(raw.ontology_digest, "revision.ontology_digest", 64);
  if (!/^[a-f0-9]{64}$/u.test(ontologyDigest)) throw new Error("revision ontology_digest must be a SHA-256 hex digest");
  const conceptKind = requiredText(raw.concept_kind, "revision.concept_kind", 64);
  if (!/^[a-z][a-z0-9_]*$/u.test(conceptKind)) throw new Error("revision.concept_kind must be a lowercase semantic identifier");
  const confidence = validateConfidence(raw.confidence, "revision.confidence");
  const rationale = requiredText(raw.rationale, "revision.rationale", 2_000);
  const createdAt = requiredText(raw.created_at, "revision.created_at", 64);
  if (!isIsoDate(createdAt)) throw new Error("revision.created_at must be a canonical ISO timestamp");
  const previousId = raw.previous_revision_id === undefined || raw.previous_revision_id === null
    ? null
    : requiredText(raw.previous_revision_id, "revision.previous_revision_id", 128);
  if (previousId !== (previous?.id ?? null)) throw new Error("revision history must be an append-only chain");
  const previousClass = raw.previous_classification === undefined || raw.previous_classification === null
    ? null
    : classification(raw.previous_classification, "revision.previous_classification");
  if ((previousClass?.revision_id ?? null) !== (previous?.id ?? null)) throw new Error("revision previous classification does not match its history link");
  if (previous && (!previousClass || previousClass.ontology_version !== previous.ontology_version
    || previousClass.concept_kind !== previous.concept_kind)) {
    throw new Error("revision previous classification does not match the prior revision");
  }
  if (!Array.isArray(raw.source_refs)) throw new Error("revision.source_refs must be an array");
  const revisionSources = sourceRefs(raw.source_refs);
  if (JSON.stringify(revisionSources) !== JSON.stringify(sources)) throw new Error("revision source references do not match the original record");
  const validated = { id, record_id: recordId, record_digest: recordDigest, ontology_version: ontologyVersion,
    ontology_digest: ontologyDigest, concept_kind: conceptKind, confidence, rationale, created_at: createdAt,
    previous_revision_id: previousId, previous_classification: previousClass, source_refs: revisionSources };
  const expectedId = `classification_${digest({ record_id: recordId, record_digest: recordDigest, ontology_version: ontologyVersion,
    ontology_digest: ontologyDigest, concept_kind: conceptKind, confidence, rationale, created_at: createdAt,
    previous_revision_id: previousId, previous_classification: previousClass, source_refs: revisionSources }).slice(0, 32)}`;
  if (id !== expectedId) throw new Error("revision ID does not match its immutable contents");
  return validated;
}

/**
 * Append a semantic interpretation without changing the record's stable ID,
 * statement, source references, or earlier classification revisions. A weak
 * classification is returned as unresolved and leaves the effective class
 * unchanged, so callers can keep current retrieval and promotion behavior.
 */
export function appendClassificationRevision(input: unknown): ClassificationRevisionDecision {
  const value = object(input, "classification revision input");
  const record = object(value.record, "record");
  const recordId = requiredText(record.id, "record.id", 256);
  if (typeof record.statement !== "string" || !record.statement.trim()) throw new Error("record.statement must be a non-empty string");
  if (record.statement.length > 100_000) throw new Error("record.statement must be 100000 characters or fewer");
  const statement = record.statement;
  const sources = sourceRefs(record.source_refs);
  const recordDigest = digest({ id: recordId, statement, source_refs: sources });
  const ontology = validateOntology(value.ontology);
  const rawProposal = object(value.proposal, "proposal");
  const ontologyVersion = requiredText(rawProposal.ontology_version, "proposal.ontology_version", 128);
  if (ontologyVersion !== ontology.version) throw new Error("proposal ontology_version does not match the supplied ontology");
  const conceptKind = requiredText(rawProposal.concept_kind, "proposal.concept_kind", 64);
  if (!/^[a-z][a-z0-9_]*$/u.test(conceptKind)) throw new Error("proposal.concept_kind must be a lowercase semantic identifier");
  if (!ontology.concept_kinds.includes(conceptKind)) throw new Error("proposal concept_kind is not in the supplied ontology");
  const confidence = validateConfidence(rawProposal.confidence, "proposal.confidence");
  const rationale = requiredText(rawProposal.rationale, "proposal.rationale", 2_000);
  const createdAt = requiredText(rawProposal.created_at, "proposal.created_at", 64);
  if (!isIsoDate(createdAt)) throw new Error("proposal.created_at must be a canonical ISO timestamp");
  const minConfidence = value.minimum_confidence === undefined ? 0.8 : validateConfidence(value.minimum_confidence, "minimum_confidence");

  if (!Array.isArray(value.revisions)) throw new Error("revisions must be an array");
  const revisions: ClassificationRevision[] = [];
  for (const rawRevision of value.revisions) {
    const previous = revisions.at(-1) ?? null;
    const revision = validateRevision(rawRevision, recordId, recordDigest, sources, previous);
    revisions.push(revision);
  }

  const suppliedCurrent = record.current_classification === undefined || record.current_classification === null
    ? null
    : classification(record.current_classification, "record.current_classification");
  const lastRevision = revisions.at(-1) ?? null;
  const current = lastRevision
    ? { ontology_version: lastRevision.ontology_version, concept_kind: lastRevision.concept_kind, revision_id: lastRevision.id }
    : suppliedCurrent;
  if (lastRevision && suppliedCurrent && (suppliedCurrent.revision_id !== lastRevision.id
    || suppliedCurrent.ontology_version !== lastRevision.ontology_version || suppliedCurrent.concept_kind !== lastRevision.concept_kind)) {
    throw new Error("record.current_classification does not match the latest revision");
  }
  if (!lastRevision && suppliedCurrent?.revision_id !== null && suppliedCurrent?.revision_id !== undefined) {
    throw new Error("record.current_classification references a missing revision");
  }

  const revisionPayload = { record_id: recordId, record_digest: recordDigest, ontology_version: ontology.version,
    ontology_digest: ontology.digest, concept_kind: conceptKind, confidence, rationale, created_at: createdAt,
    previous_revision_id: lastRevision?.id ?? null, previous_classification: current, source_refs: sources };
  const duplicate = revisions.find((item) => item.ontology_version === ontology.version && item.ontology_digest === ontology.digest
    && item.concept_kind === conceptKind && item.confidence === confidence && item.rationale === rationale && item.created_at === createdAt);
  if (duplicate) {
    return { status: "duplicate", record_id: recordId, record_digest: recordDigest, revisions,
      effective_classification: current, unresolved: null };
  }
  const revisionId = `classification_${digest(revisionPayload).slice(0, 32)}`;

  if (confidence < minConfidence) {
    return { status: "unresolved", record_id: recordId, record_digest: recordDigest, revisions,
      effective_classification: current, unresolved: { ontology_version: ontology.version, proposed_concept_kind: conceptKind,
        confidence, rationale, reason: "below_confidence_threshold" } };
  }

  const next: ClassificationRevision = { id: revisionId, ...revisionPayload };
  return { status: "appended", record_id: recordId, record_digest: recordDigest, revisions: [...revisions, next],
    effective_classification: { ontology_version: ontology.version, concept_kind: conceptKind, revision_id: revisionId }, unresolved: null };
}
