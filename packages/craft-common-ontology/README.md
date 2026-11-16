# @craft/craft-common-ontology

The one concept taxonomy that Knowledge, Memory and Experience all map into, so a
record means the same thing no matter which surface wrote it.

Six concept kinds, each with a one-line test a statement must pass before it is
stored. Strong validation: a statement that fails the test is rejected at write
time instead of becoming prose nobody can use later.

| Kind | Test |
|---|---|
| `fact` | Someone could independently confirm or refute it with evidence. |
| `rule` | Breaking it is a mistake a reviewer would flag. |
| `decision` | It names what was chosen, what was rejected, and why. |
| `term` | It maps one vocabulary entry to one meaning. |
| `preference` | Both options work; the choice reflects taste or convention. |
| `procedure` | It can be followed again and reach the same verified result. |

Statements are capped at 300 characters and reject filler phrases
(“待补充”, “相关内容”, “见上文”…), because durable records must stand on
their own.

## Relations and consistency (additive, diagnostic)

`RELATION_TYPES` declares which concept kinds a typed Knowledge relation may
connect (`derives_from`, `supersedes`, `contradicts`, `supports`, `refines`,
`references`). `checkRelationConcepts(relation, from, to)` is a soft check: an
unknown concept (a historical, untagged record) passes; a known concept that
the relation forbids fails. `checkConceptConsistency(records)` is a read-only
diagnostic for two readability failures — one `term` with two definitions, and
rules that both require and forbid the same action. Neither API writes or
rewrites a record; an inference is never promoted to a fact.

## Usage

```ts
import { validateConcept, mapLegacyKind } from "craft-common-ontology";

const { kind, statement } = validateConcept("rule", "Use pnpm, not npm, for this monorepo.");
const legacyKind = mapLegacyKind("memory", "preference"); // → "preference"
```

## License

MIT
