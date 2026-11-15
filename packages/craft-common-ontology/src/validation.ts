import { CONCEPTS, EMPTY_PHRASES, type ConceptKind } from "./concepts.ts";

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
  if (typeof kind !== "string" || !(kind in CONCEPTS)) {
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
