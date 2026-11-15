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

## Usage

```ts
import { validateConcept, mapLegacyKind } from "craft-common-ontology";

const { kind, statement } = validateConcept("rule", "Use pnpm, not npm, for this monorepo.");
const legacyKind = mapLegacyKind("memory", "preference"); // → "preference"
```

## License

MIT
