# craft-common

独立公共基础包仓库。三个包各自可单独发布：

| 包 | 职责 |
|---|---|
| `packages/craft-common-base` | 契约、校验、digest、scope、检索原语 |
| `packages/craft-common-log` | 无内容遥测、评测与 OTLP 观测 SDK |
| `packages/craft-common-store-local` | 版本化 SQLite / Markdown 本地持久化 |

## 依赖方向

```text
craft-common-store-local  (无内部依赖)
        ↑
craft-common-base
        ↑
craft-common-log
```

`craft-capability` 与 `craft` 内核依赖这三个包；本仓库不依赖任何
capability 或 core 源码，因此不存在循环依赖。

## 验证

```text
pnpm install
node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p packages/craft-common-base/tsconfig.json
node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p packages/craft-common-log/tsconfig.json
node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p packages/craft-common-store-local/tsconfig.json
```
