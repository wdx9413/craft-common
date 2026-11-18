import { CONCEPTS, EMPTY_PHRASES, isConceptKind, isRelationKind, RELATION_TYPES, type ConceptKind, type RelationKind } from "./concepts.ts";

/** Maximum characters for one durable statement; longer prose belongs in a document, not the ledger. */
export const CONCEPT_MAX_LENGTH = 300;

export interface ConceptValidationResult {
  readonly kind: ConceptKind;
  readonly statement: string;
}

/**
 * Validate one durable statement against the shared taxonomy.
 *
 * Strong validation is deliberate: a record that fails here would otherwise be
 * stored as unreadable prose that every later reader has to interpret. The
 * caller reports the thrown message to the writer, who can then rephrase or
 * pick the right concept kind. Historical records are never rewritten by this
 * module — it only gates new writes.
 */
export function validateConcept(kind: unknown, statement: unknown): ConceptValidationResult {
  if (!isConceptKind(kind)) {
    throw new Error(`concept kind must be one of: ${Object.keys(CONCEPTS).join(", ")}`);
  }
  if (typeof statement !== "string" || !statement.trim()) {
    throw new Error("concept statement must be a non-empty string");
  }
  const normalized = statement.trim().replace(/\s+/gu, " ");
  if (normalized.length > CONCEPT_MAX_LENGTH) {
    throw new Error(`concept statement must be ${CONCEPT_MAX_LENGTH} characters or fewer; put longer material in a document and reference it`);
  }
  const lower = ` ${normalized.toLowerCase()} `;
  for (const phrase of EMPTY_PHRASES) {
    if (lower.includes(phrase.toLowerCase())) {
      throw new Error(`concept statement must not contain the filler phrase "${phrase.trim()}" — say what the record actually means`);
    }
  }
  if (/^(?:这|the |this |it )?(?:个|条|些)?(?:相关的?|其他的?|上面|下面|以上)/u.test(normalized)) {
    throw new Error("concept statement must stand on its own — it cannot rely on surrounding text the reader may not have");
  }
  return { kind: kind as ConceptKind, statement: normalized };
}

/** Map a legacy component-local kind onto the shared taxonomy. Unknown kinds are rejected, not guessed. */
export function mapLegacyKind(component: "knowledge" | "memory" | "experience", legacyKind: string): ConceptKind {
  const table: Record<string, ConceptKind> = {
    "knowledge:fact": "fact",
    "knowledge:rule": "rule",
    "knowledge:decision": "decision",
    "knowledge:term": "term",
    "knowledge:failure_mode": "rule",
    "memory:working": "fact",
    "memory:episodic": "fact",
    "memory:preference": "preference",
    "memory:procedural": "procedure",
    "experience:scenario": "procedure",
  };
  const key = `${component}:${legacyKind}`;
  const mapped = table[key];
  if (!mapped) throw new Error(`unsupported ${component} kind: ${legacyKind}`);
  return mapped;
}

/**
 * Readability gate for a long-form concept body (for example a self-evolved
 * Mod overlay). Unlike `validateConcept`, this does not cap length at 300
 * characters; it rejects only the phrases and deferred references that make a
 * durable statement unreadable on its own.
 */
export function validateConceptBody(body: unknown, name = "body"): string {
  if (typeof body !== "string" || !body.trim()) throw new Error(`${name} must be a non-empty string`);
  const lower = ` ${body.toLowerCase()} `;
  for (const phrase of EMPTY_PHRASES) {
    if (lower.includes(phrase.toLowerCase())) {
      throw new Error(`${name} must not contain the filler phrase "${phrase.trim()}" — say what the rule actually means`);
    }
  }
  if (/^(?:这|the |this |it )?(?:个|条|些)?(?:相关的?|其他的?|上面|下面|以上)/u.test(body.trim())) {
    throw new Error(`${name} must stand on its own — it cannot rely on surrounding text`);
  }
  return body;
}

export interface RelationConceptCheck {
  readonly valid: boolean;
  readonly reason: string | null;
}

/**
 * Check a typed relation against the concept constraints, when both endpoint
 * concepts are known. Unknown concepts are *not* an error here: historical
 * records predate concept tags, and the shared taxonomy never rewrites them.
 * A check only fails when both concepts are known and the relation's declared
 * constraint excludes one of them.
 */
export function checkRelationConcepts(relation: unknown, fromConcept: unknown, toConcept: unknown): RelationConceptCheck {
  if (!isRelationKind(relation)) {
    throw new Error(`relation must be one of: ${Object.keys(RELATION_TYPES).join(", ")}`);
  }
  const rule = RELATION_TYPES[relation as RelationKind];
  const fromKnown = isConceptKind(fromConcept);
  const toKnown = isConceptKind(toConcept);
  if (!fromKnown || !toKnown) return { valid: true, reason: null };
  if (rule.from && !rule.from.includes(fromConcept as ConceptKind))
    return { valid: false, reason: `${relation} cannot start at a ${String(fromConcept)}` };
  if (rule.to && !rule.to.includes(toConcept as ConceptKind))
    return { valid: false, reason: `${relation} cannot end at a ${String(toConcept)}` };
  return { valid: true, reason: null };
}

export interface ConceptConsistencyIssue {
  readonly kind: "duplicate_term_definition" | "conflicting_rule";
  readonly detail: string;
  readonly recordIds: readonly string[];
}

/**
 * Cross-record readability check over already-tagged concept records.
 *
 * This is intentionally *diagnostic* and read-only. The shared taxonomy does
 * not own any component's write gate, so it reports issues for a caller to
 * surface; it never deletes, merges, or rewrites a record. Two rules are
 * checked because they are the ones that silently destroy readability:
 * a `term` with two different meanings, and two rules whose statements are
 * exact opposites ("do X" / "never X").
 */
export function checkConceptConsistency(records: readonly { id: string; concept_kind: unknown; statement: string; subject?: string }[]): ConceptConsistencyIssue[] {
  const issues: ConceptConsistencyIssue[] = [];
  const terms = new Map<string, { id: string; statement: string }[]>();
  const rules = new Map<string, { id: string; statement: string }[]>();
  for (const record of records) {
    if (typeof record.statement !== "string" || !record.statement.trim()) continue;
    if (record.concept_kind === "term") {
      // A term's identity is the vocabulary entry it defines (`subject`), not
      // the full statement. Two different definitions of one term collide even
      // though their statements differ — that is the failure this check exists for.
      const key = (record.subject ?? record.statement).trim().replace(/\s+/gu, " ").toLowerCase();
      const bucket = terms.get(key) ?? [];
      bucket.push({ id: record.id, statement: record.statement });
      terms.set(key, bucket);
    }
    if (record.concept_kind === "rule") {
      const key = record.statement.trim().replace(/\s+/gu, " ").toLowerCase();
      // Strip both leading politeness and leading negation so "Use pnpm" and
      // "Never use pnpm" share a key and land in the same bucket.
      const normalized = key
        .replace(/^(?:please\s+|always\s+|must\s+)/u, "")
        .replace(/^(?:never\s+|do not\s+|don't\s+|不要\s*|禁止\s*|严禁\s*)/u, "")
        .replace(/[。.!！]$/u, "");
      const bucket = rules.get(normalized) ?? [];
      bucket.push({ id: record.id, statement: record.statement });
      rules.set(normalized, bucket);
    }
  }
  for (const [key, bucket] of terms) {
    const distinct = new Set(bucket.map((item) => item.statement.trim().replace(/\s+/gu, " ").toLowerCase()));
    if (distinct.size > 1) {
      issues.push({ kind: "duplicate_term_definition", detail: `term "${key}" has ${distinct.size} distinct definitions`, recordIds: bucket.map((item) => item.id) });
    }
  }
  for (const [key, bucket] of rules) {
    if (bucket.length < 2) continue;
    const affirmative = bucket.filter((item) => !/^(?:(?:never|do not|don't)\b|(?:不要|禁止|严禁|不得|不能|不可以))/u.test(item.statement.trim().replace(/\s+/gu, " ").toLowerCase()));
    const negative = bucket.filter((item) => /^(?:(?:never|do not|don't)\b|(?:不要|禁止|严禁|不得|不能|不可以))/u.test(item.statement.trim().replace(/\s+/gu, " ").toLowerCase()));
    if (affirmative.length && negative.length) {
      issues.push({ kind: "conflicting_rule", detail: `rules both require and forbid "${key}"`, recordIds: bucket.map((item) => item.id) });
    }
  }
  return issues;
}
