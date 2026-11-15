/**
 * The one concept taxonomy that Knowledge, Memory and Experience all map into.
 *
 * Before this package existed each component invented its own kind list, so
 * "this project uses pnpm" could legitimately be stored as a Knowledge `fact`,
 * a Memory `preference` or a Knowledge `rule` depending on which surface the
 * writer used. The taxonomy below is the shared contract: every durable record
 * names exactly one of these concepts, and each concept names the one test a
 * statement must pass before it is written in that shape.
 *
 * The one-line tests are the whole point. A writer (human or model) that cannot
 * answer the test for the type it picked has picked the wrong type, and the
 * validation module rejects the write instead of storing prose nobody can use.
 */

export const CONCEPT_KINDS = [
  "fact",
  "rule",
  "decision",
  "term",
  "preference",
  "procedure",
] as const;

export type ConceptKind = (typeof CONCEPT_KINDS)[number];

export interface ConceptDefinition {
  /** What this concept is, in one sentence a person or a model can act on. */
  readonly is: string;
  /** The test a statement must pass to be recorded as this concept. */
  readonly test: string;
  /** One counter-example that must NOT be stored as this concept. */
  readonly not: string;
  /** Which components historically used a different local name for it. */
  readonly legacyNames: readonly string[];
}

export const CONCEPTS: Readonly<Record<ConceptKind, ConceptDefinition>> = {
  fact: {
    is: "A verifiable statement about the world or the project that can be checked.",
    test: "Someone could independently confirm or refute it with evidence.",
    not: "An opinion about what the team should prefer — that is a preference.",
    legacyNames: ["fact (knowledge)", "working (memory)", "episodic (memory)"],
  },
  rule: {
    is: "A constraint the work must obey, agreed by the team rather than observed.",
    test: "Breaking it is a mistake a reviewer would flag, even if the build passes.",
    not: "A fact about what currently happens — that is a fact.",
    legacyNames: ["rule (knowledge)"],
  },
  decision: {
    is: "A trade-off that was settled, with the reason the alternative was rejected.",
    test: "It names what was chosen, what was rejected, and why.",
    not: "An aspiration that has not been acted on — that is a preference.",
    legacyNames: ["decision (knowledge)"],
  },
  term: {
    is: "A word the project gives a specific meaning to, defined so others can use it the same way.",
    test: "It maps one vocabulary entry to one meaning, not to an implementation detail.",
    not: "A general English word used in its ordinary sense — that needs no entry.",
    legacyNames: ["term (knowledge)"],
  },
  preference: {
    is: "A person's or team's choice between acceptable options that evidence cannot settle.",
    test: "Both options work; the choice reflects taste or convention, not correctness.",
    not: "A rule the team enforces on everyone — rules are not optional.",
    legacyNames: ["preference (memory)"],
  },
  procedure: {
    is: "A repeatable step sequence that produced a verified outcome at least once.",
    test: "It can be followed again and reach the same verified result.",
    not: "An idea for how something might be done — unverified intent stays out.",
    legacyNames: ["procedural (memory)", "scenario (experience)"],
  },
};

/** Filler phrases that make a record unreadable; a statement containing one of these is rejected. */
export const EMPTY_PHRASES: readonly string[] = [
  "相关内容",
  "一些东西",
  "待补充",
  "待定",
  "待更新",
  "以后再说",
  "和其他内容一样",
  "见上文",
  "见下文",
  "同上",
  " miscellaneous ",
  " tbd ",
  " tbc ",
];

export function isConceptKind(value: unknown): value is ConceptKind {
  return typeof value === "string" && (CONCEPT_KINDS as readonly string[]).includes(value);
}
