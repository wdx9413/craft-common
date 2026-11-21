# craft-common-store-local

Local versioned SQLite records, migrations, Craft-compatible data paths, and Markdown content storage. `CraftStore` lives here; `core/infrastructure/*` are compatibility exports. Opening an existing Craft data directory retains the schema and migration backup behavior. Node >=23 is required for `node:sqlite`.

```ts
import { CraftStore, craftPaths } from "craft-common-store-local";
const store = await new CraftStore(craftPaths("/path/to/data")).open();
try { store.create("external_record", "id", { status: "candidate" }); } finally { store.close(); }
```

## 1. 文件权威与模式识别

`open({ fileRecords: true })` 将完整结构移到当前 catalog 同目录的 `records/`。`open({ ownerRecords: true })` 同时启用文件模式，并让普通记录直接在本 catalog 提交；不再按记录 kind 写旧共享分区。Host 负责提供 owner 的 publication 路径、所有者标记与旧写入者 fence。Trace 与 Codebase 专用分片也位于本 owner 目录。

新目录持久化 `owner_records=v1`、`record_files=v2`。新 reader 接受旧 `record_files=v1`，首次打开升级标记；已有 v2 不重复更新。禁止显式关闭已启用模式，未知版本拒绝。旧 inline 记录与 v1 文件仍可读取；有旧分区指针的 catalog 必须先完成迁移，不能直接改为 owner 模式。

人读正文按明确 kind/字段写为 `records/prose/<文本摘要>.md`，JSON envelope v2 只留 prose refs 与结构。适用 Notes 正文及兼容描述、Device 备注、Program Memory statement、Task prompt/description/goal、Evidence claim，以及历史 Knowledge/Memory content。结构化步骤、合同和 Codebase 图不拆 Markdown。相同文本跨字段、跨版本复用 MD；reader 保留原字段顺序。无法无损转成 UTF-8 的历史字符串保留 JSON 转义。原始迁移归档不因此改写。

## 2. SQLite 字段用途及类型

索引不是第二份完整 payload。字符串字段只接受字符串或 null；数字字段只接受有限数字。对象或数组不能借 `state`、`workspace`、`author` 等标量字段进入 SQLite。

| 字段组 | 字段 | 已确认用途 |
| --- | --- | --- |
| 归属、访问及生命周期 | `scope`、`scope_envelope`、`source_id`、`workspace_id`、`sensitivity`、`trust`、`valid_until`、`host_kind`、`device_id`、`project_id`、`project_scope_id`、`scope_id`、`scope_kind`、`session_id`、`session_host`、`session_scope_id` | Store 分区兼容、ContextReadGuard 与资产预授权。只作预授权，使用正文前仍须核对完整记录的当前权限。 |
| 关联身份 | `document_id`、`claim_id`、`memory_id`、`procedure_id`、`scenario_key`、`source_session_id`、`turn_id`、`task_id`、`trace_id`、`link_id`、`kind`、`id`、`_craft_logical_record_id` | 依赖筛选、精确版本及迁移物理 revision 兼容。 |
| 队列、事件及时间 | `status`、`state`、`workspace`、`transition_id`、`request_digest`、`last_event_at`、`started_at` | Store 事件幂等；Workbench message queue / queue runner 按 state 检索，agent-session links 按 workspace 检索。 |
| 数字 | `memory_version`、`observed_at_ms`、`sequence` | 版本关联、Hook 时间及事件顺序。 |
| 项目身份 | `alias_kind`、`alias`、`alias_digest`、`canonical_scope`、`identity_digest`、`project_kind`、`remote_digest`、`local_path_alias`、`root_path`、`canonical_root_path` | `projectRoots` 的别名/身份校验、工作区绑定与归属判定。 |
| 摘要与简要元数据 | `content_digest`、`definition_digest`、`source_revision_digest`、`input_digest`、`author`、`source_type` | 历史摘要、来源筛选及一致性检查；不含正文、完整报告或定义。 |

结构字段也按子字段投影：

- `scope` 仅字符串/null 或 `{kind,id}`；`canonical_scope` 仅 `{kind,id}`。
- `scope_envelope` 仅 applicability、custody、audience.mode / principal_ids、purpose、retention、tenant_id；作用域对象仅 kind/id，principal_ids 必须全部为字符串。
- `content_ref` 仅 kind、record_id、version、path、digest、bytes、format、title、scope；`knowledge_binding` 仅 scope。
- `metadata` 仅字符串 capability_owner、provenance、review_id。其他报告、对象与正文始终留在权威文件。

畸形授权字段投影为明确的无效 envelope 标记，不能因字段被丢弃而采用宽松默认权限。完整原值仍保留在文件供诊断和修复。新增索引字段前须找到实际 SQL / 授权调用点并补类型与覆盖验证。

## 3. 冷历史、预授权读取及一致快照

`RecordFileStore.writeColdBatch(entries)` 返回必要字段和 `{path,digest,offset,bytes}`。一块最多 1000 条，多条合计最多 8 MiB；超大单条完整保留。正文仍走同一 Markdown seam。offset/bytes 是 UTF-8 字节范围，digest 针对该条 envelope，不能当成整块摘要。日常 `write` 仍写不可变热文件。

`payload` 核验 owner 范围、普通文件、边界、摘要与 kind/id/version。`referencedFiles` 枚举 record/chunk 与 prose MD 的物理依赖；冷块不返回伪造的整块 digest，快照调用方须对每个去重后的文件实际计算摘要。

`findMetadata` / `historyMetadata` 只读已提交 SQL 索引。旧 published partition 会读取对应 SQL 行的元数据，绝不为预授权打开 record 文件或 MD。它们不是权限授予或正文完整性证明。完整读取后仍须复验当前权限。

文件先发布，SQL 提交决定可见性。事务失败可能保留没有索引的不可变孤立文件，不得据此生成已发布历史。独立备份必须带本 owner 文件以及本域权威正文、定义和受管结果；仅复制 publication.db 不能算完整备份。

### 6. 按记录类型索引字段

`recordMetadata(kind,payload)` 对未知类型只保留共同授权定位字段（scope、Source、状态、内容摘要、作者、项目/会话与访问约束），不保留 state、workspace 等同名业务字段。类型专用字段经当前SQL入口核验：Experience experience_procedure 的 lifecycle 用于稳定引用的当前撤回/拒绝预授权；Knowledge 的 document_id 用于依赖过滤；memory_confirmation 的 memory_id/memory_version 用于最新独立确认；codex_hook_signal 的 turn_id/observed_at_ms 用于 Hook 查询；context_ephemeral_index/context_resume_snapshot 保留会话定位；trace 时间字段用于归档队列，trace_event/trace_feedback/telemetry_event 的 trace_id 用于分片子记录查询；workbench_message_queue 的 state/link_id/sequence 用于未发送队列；workbench_agent_session_link 的 workspace 用于会话分页；scope_alias/project_identity 保留身份摘要和路径定位；event:* 仅额外保留 transition_id 用于状态机幂等。

每个字段同时受值类型限制。任意对象不能借标量同名字段进入库；结构授权元数据只保留已声明子字段，错误类型以无效授权标记拒绝后续正文读取。完整原对象仍保存在权威文件中。
