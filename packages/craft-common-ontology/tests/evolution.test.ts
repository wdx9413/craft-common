import assert from "node:assert/strict";
import test from "node:test";
import { CONCEPT_KINDS, RELATION_KINDS } from "../src/concepts.ts";
import { appendClassificationRevision, createOntologyVersion, ONTOLOGY_CONTRACT_VERSION } from "../src/evolution.ts";
import type { ClassificationRevision, OntologyVersion } from "../src/evolution.ts";

const ontology = (version = "v1", parent_digest: string | null = null): OntologyVersion => createOntologyVersion({
  version, parent_digest, concept_kinds: [...CONCEPT_KINDS, "observation"], relation_kinds: [...RELATION_KINDS, "causes"],
});
const record = (extra: Record<string, unknown> = {}) => ({ id: "record-1", statement: "Original statement.", source_refs: ["source-1"], ...extra });
const proposal = (version: string, extra: Record<string, unknown> = {}) => ({ ontology_version: version, concept_kind: "fact",
  confidence: 0.95, rationale: "Evidence supports this classification.", created_at: "2026-11-19T12:00:00.000Z", ...extra });
const classify = (extra: Record<string, unknown> = {}) => appendClassificationRevision({ ontology: ontology(), record: record(), revisions: [],
  proposal: proposal("v1"), ...extra });

test("Ontology versions are canonical, content-addressed, and extensible without dropping shared terms", () => {
  const first = ontology();
  const reordered = createOntologyVersion({ version: "v1", relation_kinds: [...RELATION_KINDS, "causes"].reverse(),
    concept_kinds: [...CONCEPT_KINDS, "observation"].reverse() });
  assert.equal(first.contract_version, ONTOLOGY_CONTRACT_VERSION);
  assert.equal(first.digest, reordered.digest);
  assert.equal(first.parent_digest, null);
  assert.equal(ontology("v2", first.digest).parent_digest, first.digest);
  assert.deepEqual(first.concept_kinds, [...first.concept_kinds].sort());
});

test("Ontology version input rejects malformed versions, parent digests, identifiers, duplicates and removed shared terms", () => {
  for (const input of [null, [], "text"]) assert.throws(() => createOntologyVersion(input), /ontology must be an object/u);
  assert.throws(() => createOntologyVersion({ version: " " }), /version must be a non-empty string/u);
  assert.throws(() => createOntologyVersion({ version: "v".repeat(129) }), /version must be 128 characters or fewer/u);
  assert.throws(() => createOntologyVersion({ version: "v2", parent_digest: "bad", concept_kinds: CONCEPT_KINDS, relation_kinds: RELATION_KINDS }), /SHA-256/u);
  assert.throws(() => createOntologyVersion({ version: "v2", parent_digest: " ".repeat(64), concept_kinds: CONCEPT_KINDS, relation_kinds: RELATION_KINDS }), /non-empty/u);
  for (const concept_kinds of [undefined, null, [], [null], [""], ["bad-kind"], ["fact", ...CONCEPT_KINDS]]) {
    assert.throws(() => createOntologyVersion({ version: "v2", concept_kinds, relation_kinds: RELATION_KINDS }));
  }
  assert.throws(() => createOntologyVersion({ version: "v2", concept_kinds: CONCEPT_KINDS.filter((item) => item !== "fact"), relation_kinds: RELATION_KINDS }), /retain the shared concept/u);
  for (const relation_kinds of [undefined, null, [], [null], [""], ["bad-kind"], ["references", ...RELATION_KINDS]]) {
    assert.throws(() => createOntologyVersion({ version: "v2", concept_kinds: CONCEPT_KINDS, relation_kinds }));
  }
  assert.throws(() => createOntologyVersion({ version: "v2", concept_kinds: CONCEPT_KINDS,
    relation_kinds: RELATION_KINDS.filter((item) => item !== "supports") }), /retain the shared relation/u);
});

test("classification appends a revision and preserves identity, content, sources and the previous class", () => {
  const first = classify();
  assert.equal(first.status, "appended");
  assert.equal(first.record_id, "record-1");
  assert.equal(first.revisions.length, 1);
  assert.equal(first.revisions[0]!.record_id, "record-1");
  assert.equal(first.revisions[0]!.previous_classification, null);
  assert.deepEqual(first.revisions[0]!.source_refs, ["source-1"]);
  assert.equal(first.effective_classification?.concept_kind, "fact");

  const nextOntology = ontology("v2", first.revisions[0]!.ontology_digest);
  const next = appendClassificationRevision({ ontology: nextOntology, record: record({ current_classification: first.effective_classification }),
    revisions: first.revisions, proposal: proposal("v2", { concept_kind: "observation", rationale: "New ontology separates observations." }) });
  assert.equal(next.status, "appended");
  assert.equal(next.record_digest, first.record_digest);
  assert.equal(next.revisions[0]!.id, first.revisions[0]!.id);
  assert.equal(next.revisions[1]!.previous_revision_id, first.revisions[0]!.id);
  assert.deepEqual(next.revisions[1]!.previous_classification, first.effective_classification);
  assert.equal(next.effective_classification?.concept_kind, "observation");
});

test("unresolved classification preserves the prior effective class and duplicate proposals are idempotent", () => {
  const first = classify();
  const unresolved = appendClassificationRevision({ ontology: ontology("v2", first.revisions[0]!.ontology_digest),
    record: record({ current_classification: first.effective_classification }), revisions: first.revisions,
    proposal: proposal("v2", { concept_kind: "observation", confidence: 0.4, rationale: "Evidence is ambiguous." }) });
  assert.equal(unresolved.status, "unresolved");
  assert.equal(unresolved.revisions.length, 1);
  assert.deepEqual(unresolved.effective_classification, first.effective_classification);
  assert.equal(unresolved.unresolved?.reason, "below_confidence_threshold");

  const created = appendClassificationRevision({ ontology: ontology("v2", first.revisions[0]!.ontology_digest),
    record: record({ current_classification: first.effective_classification }), revisions: first.revisions,
    proposal: proposal("v2", { concept_kind: "observation" }) });
  const duplicate = appendClassificationRevision({ ontology: ontology("v2", first.revisions[0]!.ontology_digest),
    record: record({ current_classification: created.effective_classification }), revisions: created.revisions,
    proposal: proposal("v2", { concept_kind: "observation" }) });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.revisions.length, 2);
  assert.deepEqual(duplicate.effective_classification, created.effective_classification);
});

test("unresolved classification without an old category does not invent an effective category", () => {
  const result = classify({ proposal: proposal("v1", { confidence: 0.2 }) });
  assert.equal(result.status, "unresolved");
  assert.equal(result.effective_classification, null);
});

test("classification request validates identity, ontology, proposal, confidence, timestamp and thresholds", () => {
  for (const input of [null, [], "text"]) assert.throws(() => appendClassificationRevision(input), /classification revision input must be an object/u);
  assert.throws(() => classify({ record: null }), /record must be an object/u);
  assert.throws(() => classify({ record: record({ id: " " }) }), /record.id must be a non-empty string/u);
  assert.throws(() => classify({ record: record({ id: "x".repeat(257) }) }), /record.id must be 256 characters or fewer/u);
  assert.throws(() => classify({ record: record({ statement: " " }) }), /record.statement must be a non-empty string/u);
  assert.throws(() => classify({ record: record({ statement: "x".repeat(100_001) }) }), /record.statement must be 100000 characters or fewer/u);
  assert.throws(() => classify({ record: record({ source_refs: "source" }) }), /source_refs must be an array/u);
  assert.throws(() => classify({ record: record({ source_refs: [null] }) }), /source_refs\[0\] must be a non-empty string/u);
  assert.throws(() => classify({ record: record({ source_refs: ["same", "same"] }) }), /must not contain duplicates/u);
  assert.throws(() => classify({ ontology: { ...ontology(), digest: "0".repeat(64) } }), /digest does not match/u);
  assert.throws(() => classify({ ontology: { ...ontology(), contract_version: "future" } }), /contract_version is unsupported/u);
  assert.throws(() => classify({ proposal: null }), /proposal must be an object/u);
  assert.throws(() => classify({ proposal: proposal("v2") }), /does not match the supplied ontology/u);
  for (const concept_kind of ["", "Bad-kind", "not-in-ontology", "unregistered"]) {
    assert.throws(() => classify({ proposal: proposal("v1", { concept_kind }) }));
  }
  for (const confidence of ["0.9", Number.NaN, -0.1, 1.1]) {
    assert.throws(() => classify({ proposal: proposal("v1", { confidence }) }), /finite number from 0 through 1/u);
  }
  assert.throws(() => classify({ proposal: proposal("v1", { rationale: " " }) }), /rationale must be a non-empty string/u);
  assert.throws(() => classify({ proposal: proposal("v1", { rationale: "x".repeat(2_001) }) }), /rationale must be 2000 characters or fewer/u);
  for (const created_at of ["not-a-date", "2026-11-19T12:00:00+08:00"]) {
    assert.throws(() => classify({ proposal: proposal("v1", { created_at }) }), /canonical ISO timestamp/u);
  }
  assert.throws(() => classify({ minimum_confidence: "0.8" }), /finite number from 0 through 1/u);
  assert.throws(() => classify({ minimum_confidence: -1 }), /finite number from 0 through 1/u);
  assert.throws(() => classify({ minimum_confidence: 2 }), /finite number from 0 through 1/u);
  assert.throws(() => classify({ revisions: null }), /revisions must be an array/u);
});

test("existing revision history must preserve record digest, source, ontology lineage and current classification", () => {
  const first = classify();
  const valid = first.revisions[0]!;
  const append = (revision: ClassificationRevision, args: Record<string, unknown> = {}) => appendClassificationRevision({ ontology: ontology("v2", valid.ontology_digest),
    record: record({ current_classification: first.effective_classification }), revisions: [revision],
    proposal: proposal("v2", { concept_kind: "observation" }), ...args });
  assert.throws(() => append({ ...valid, record_id: "other" }), /different record/u);
  assert.throws(() => append({ ...valid, record_digest: "0".repeat(64) }), /does not match the original record/u);
  assert.throws(() => append({ ...valid, ontology_version: " " }), /ontology_version must be a non-empty string/u);
  assert.throws(() => append({ ...valid, ontology_digest: "bad" }), /SHA-256/u);
  assert.throws(() => append({ ...valid, concept_kind: "Bad-kind" }), /semantic identifier/u);
  for (const confidence of ["high", Number.NaN, -1, 2]) assert.throws(() => append({ ...valid, confidence }), /finite number/u);
  assert.throws(() => append({ ...valid, rationale: " " }), /rationale must be a non-empty string/u);
  assert.throws(() => append({ ...valid, created_at: "bad-date" }), /canonical ISO timestamp/u);
  assert.throws(() => append({ ...valid, previous_revision_id: "not-the-previous" }), /append-only chain/u);
  assert.throws(() => append({ ...valid, source_refs: "source-1" }), /source_refs must be an array/u);
  assert.throws(() => append({ ...valid, source_refs: ["other-source"] }), /do not match the original record/u);
  assert.throws(() => append({ ...valid, rationale: "tampered but still valid" }), /ID does not match its immutable contents/u);
  assert.throws(() => append({ ...valid, previous_classification: "bad" }), /previous_classification must be an object/u);
  assert.throws(() => append({ ...valid, previous_classification: { ontology_version: "old", concept_kind: "fact", revision_id: " " } }), /revision_id must be a non-empty string/u);
  assert.throws(() => append({ ...valid, previous_classification: { ontology_version: "old", concept_kind: "Bad", revision_id: valid.id } }), /semantic identifier/u);
  const second = append(valid);
  const secondRevision = second.revisions[1]!;
  assert.throws(() => appendClassificationRevision({ ontology: ontology("v3", secondRevision.ontology_digest),
    record: record({ current_classification: second.effective_classification }),
    revisions: [valid, { ...secondRevision, previous_classification: { ontology_version: "v1", concept_kind: "rule", revision_id: valid.id } }],
    proposal: proposal("v3", { concept_kind: "observation" }) }), /does not match the prior revision/u);
  assert.throws(() => appendClassificationRevision({ ontology: ontology("v3", secondRevision.ontology_digest),
    record: record({ current_classification: second.effective_classification }),
    revisions: [valid, { ...secondRevision, previous_classification: null }], proposal: proposal("v3", { concept_kind: "observation" }) }),
  /previous classification does not match its history link/u);
});

test("classification rejects malformed legacy classes and inconsistent append state", () => {
  const first = classify();
  const append = (recordExtra: Record<string, unknown>, revisions: readonly ClassificationRevision[] = first.revisions) => appendClassificationRevision({ ontology: ontology("v2", first.revisions[0]!.ontology_digest),
    record: record({ current_classification: first.effective_classification, ...recordExtra }), revisions,
    proposal: proposal("v2", { concept_kind: "observation" }) });
  assert.throws(() => classify({ record: record({ current_classification: "fact" }) }), /current_classification must be an object/u);
  assert.throws(() => classify({ record: record({ current_classification: { ontology_version: " ", concept_kind: "fact" } }) }), /ontology_version must be a non-empty string/u);
  assert.throws(() => classify({ record: record({ current_classification: { ontology_version: "v0", concept_kind: "Bad-kind", revision_id: null } }) }), /semantic identifier/u);
  assert.throws(() => classify({ record: record({ current_classification: { ontology_version: "v0", concept_kind: "fact", revision_id: "legacy-id" } }) }), /references a missing revision/u);
  assert.throws(() => append({ current_classification: { ontology_version: "v1", concept_kind: "rule", revision_id: first.revisions[0]!.id } }), /does not match the latest revision/u);
});

test("legacy classifications are retained as the prior meaning when the first revision is appended", () => {
  const legacy = { ontology_version: "legacy-v0", concept_kind: "term", revision_id: null };
  const result = classify({ record: record({ current_classification: legacy }) });
  assert.equal(result.status, "appended");
  assert.deepEqual(result.revisions[0]!.previous_classification, legacy);
});
