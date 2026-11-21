import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RecordFileStore } from "../src/record-files.ts";
import { CraftStore } from "../src/store.ts";
import { craftPaths, sessionStorageScopeId } from "../src/paths.ts";

test("file-backed Knowledge revisions retain their public behavior and keep full payloads outside SQLite", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-file-records-"));
  let store = await new CraftStore(craftPaths(root)).open({ fileRecords: true });
  try {
    store.create("context_ephemeral_index", "context", { session_host: "craft-mcp", session_id: "session", session_scope_id: sessionStorageScopeId("craft-mcp", "session"), content: "Context file body." });
    assert.equal(store.get("context_ephemeral_index", "context").content, "Context file body.");
    assert.deepEqual(store.migrateLegacyContextVersions([{ kind: "context_ephemeral_index", id: "context", version: 1 }]), { migrated: 0, already_current: 1 });
    store.database.prepare("UPDATE records SET payload_json=json_set(payload_json,'$.context_payload_digest','sha256:invalid') WHERE kind='context_ephemeral_index'").run();
    assert.throws(() => store.get("context_ephemeral_index", "context"), /digest mismatch/u);
    assert.throws(() => store.migrateLegacyContextVersions([{ kind: "context_ephemeral_index", id: "context", version: 1 }]), /not verified/u);
    const contextPointer = JSON.parse(String(store.database.prepare("SELECT payload_json FROM records WHERE kind='context_ephemeral_index'").get()!.payload_json))._context_partition;
    const contextDatabase = new (await import("node:sqlite")).DatabaseSync(contextPointer.file);
    contextDatabase.prepare("DELETE FROM records WHERE id='context'").run();
    contextDatabase.close();
    assert.throws(() => store.migrateLegacyContextVersions([{ kind: "context_ephemeral_index", id: "context", version: 1 }]), /current partition is not verified/u);
    const definition = { format: "json", procedure_id: "procedure", procedure_version: 1, kind: "experience", digest: "fixture", path: "before", scope: "global" };
    store.create("experience_procedure", "procedure", { scope: "global", definition_ref: definition });
    store.relocateExperienceDefinition("procedure", 1, definition, { ...definition, path: "after" });
    const inlineRoot = join(root, "inline");
    const inlineStore = await new CraftStore(craftPaths(inlineRoot)).open();
    try {
      assert.throws(() => inlineStore.advanceEvolutionCycle("absent", 1, {}, "advanced", {}), /unavailable/u);
      assert.throws(() => inlineStore.events("evolution:absent"), /unavailable/u);
      assert.throws(() => inlineStore.relocateExperienceDefinition("absent", 1, definition, { ...definition, path: "after" }), /missing/u);
      inlineStore.create("knowledge_claim", "scoped-save", { scope: "global", content: "Scoped fixture." });
      inlineStore.save("knowledge_claim", "scoped-save", { scope: "global", content: "Scoped fixture.", status: "expired" });
      inlineStore.create("experience_procedure", "procedure", { scope: "global", definition_ref: definition });
      inlineStore.relocateExperienceDefinition("procedure", 1, definition, { ...definition, path: "after" });
    } finally { inlineStore.close(); }

    assert.equal((store.get("experience_procedure", "procedure").definition_ref as Record<string, unknown>).path, "after");
    assert.equal(store.ownerRecords, false);
    const body = "A verified fixture statement retained in the authoritative record file.";
    const first = store.create("knowledge_claim", "fixture", { scope: "global", status: "candidate", content: body, evidence_ids: [] });
    assert.equal(store.get("knowledge_claim", "fixture").content, body);
    assert.equal(store.list("knowledge_claim", 5, item => item.content === body)[0]?.id, "fixture");
    const row = store.database.prepare("SELECT payload_json FROM records WHERE kind='knowledge_claim'").get()!;
    assert(!String(row.payload_json).includes(body));
    const indexed = JSON.parse(String(row.payload_json));
    assert(indexed._knowledge_partition);
    const partition = new (await import("node:sqlite")).DatabaseSync(indexed._knowledge_partition.file, { readOnly: true });
    let projection;
    try { projection = JSON.parse(String(partition.prepare("SELECT payload_json FROM records WHERE kind='knowledge_claim'").get()!.payload_json)); }
    finally { partition.close(); }
    assert(!JSON.stringify(projection).includes(body));
    assert(projection._record_file);
    const envelope = JSON.parse(readFileSync(join(root, projection._record_file.path), "utf8"));
    assert(!JSON.stringify(envelope).includes(body));
    assert.equal(readFileSync(join(root, envelope.prose_refs.content.path), "utf8"), body);
    const { RecordFileStore } = await import("../src/record-files.ts");
    const { dirname } = await import("node:path");
    const files = new RecordFileStore(root, dirname(store.paths.databaseFile));
    const pendingPayload = { scope: "global", status: "expired", content: body, evidence_ids: [] };
    const pendingProjection = files.write("knowledge_claim", "fixture", 2, pendingPayload, "fixture-time", "fixture-time");
    const pendingDb = new (await import("node:sqlite")).DatabaseSync(indexed._knowledge_partition.file);
    pendingDb.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("knowledge_claim", "fixture", 2, JSON.stringify(pendingProjection), "fixture-time", "fixture-time");
    pendingDb.close();
    const second = store.updateIfVersion("knowledge_claim", "fixture", 1, { ...first, status: "expired" });
    assert.equal(second.version, 2);
    const conflictingDb = new (await import("node:sqlite")).DatabaseSync(indexed._knowledge_partition.file);
    conflictingDb.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("knowledge_claim", "fixture", 3, JSON.stringify(files.write("knowledge_claim", "fixture", 3, { ...pendingPayload, status: "conflicting" }, "fixture-time", "fixture-time")), "fixture-time", "fixture-time");
    assert.throws(() => store.updateIfVersion("knowledge_claim", "fixture", 2, { ...second, status: "next" }), /Unpublished partition version conflicts/u);
    conflictingDb.prepare("DELETE FROM records WHERE kind='knowledge_claim' AND version=3").run();
    conflictingDb.close();

    assert.equal(store.get("knowledge_claim", "fixture", 1).status, "candidate");
    assert.equal(store.history("knowledge_claim", "fixture", 3, 5).length, 2);
    assert.throws(() => store.updateIfVersion("knowledge_claim", "fixture", 1, { ...first, status: "stale" }), /Concurrent update/u);
    assert.throws(() => store.transaction(() => { store.create("knowledge_claim", "rolled-back", { scope: "global", content: "Not published." }); throw new Error("fixture rollback"); }), /fixture rollback/u);
    assert.equal(store.find("knowledge_claim", "rolled-back"), null);
    assert.equal(store.rawRecords("knowledge_claim").length, 2);
    store.close();
    store = await new CraftStore(craftPaths(root)).open();
    assert.equal(store.get("knowledge_claim", "fixture").status, "expired");
    assert.equal(store.get("knowledge_claim", "fixture").content, body);
    const path = join(root, projection._record_file.path);
    writeFileSync(path, "tampered");
    assert.throws(() => store.get("knowledge_claim", "fixture", 1), /Record file/u);
    assert.equal(store.findMetadata("knowledge_claim", "fixture", 1)?.status, "candidate");
    assert.equal(store.findMetadata("knowledge_claim", "fixture")?.content, undefined);
    assert.equal(store.findMetadata("fixture", "missing"), null);
    assert.equal(store.historyMetadata("knowledge_claim", "fixture", 3, 5).length, 2);
    assert(store.historyMetadata("knowledge_claim", "fixture", 3, 5).every(item => item.content === undefined));
    assert.throws(() => store.historyMetadata("knowledge_claim", "fixture", 0, 5), /bounds/u);

  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("file-backed createBatch stores prose outside SQLite", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-file-batch-"));
  const store = await new CraftStore(craftPaths(root)).open({ fileRecords: true });
  try {
    store.createBatch([{ kind: "craft_note", id: "batch-note", payload: { text: "Batch prose stays in a record file." } }]);
    const row = store.database.prepare("SELECT payload_json FROM records WHERE kind='craft_note' AND id='batch-note'").get() as { payload_json: string };
    assert(!row.payload_json.includes("Batch prose stays in a record file."));
    assert.equal(store.get("craft_note", "batch-note").text, "Batch prose stays in a record file.");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("record file versions must be positive safe integers", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-file-version-"));
  try {
    const files = new RecordFileStore(root, join(root, "catalog"));
    for (const version of [0, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => files.write("fixture", `bad-version-${String(version)}`, version, {}, "now", "now"), /positive safe integer/u);
    }
    assert.throws(() => files.writeColdBatch([{ kind: "fixture", id: "bad-cold-version", version: -1, payload: {}, created_at: "now", updated_at: "now" }]), /positive safe integer/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("file mode keeps historical inline records readable and makes migration replacement file-backed", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-file-compat-"));
  let store = await new CraftStore(craftPaths(root)).open();
  try {
    store.create("knowledge_claim", "legacy", { scope: "global", status: "candidate", content: "Legacy statement." });
    store.replacePayload("knowledge_claim", "legacy", 1, { scope: "global", content: "Legacy statement." });
    store.create("fixture", "old-inline", { content: "Old." });
    store.replacePayload("fixture", "old-inline", 1, { content: "Updated old." });
    store.close();
    store = await new CraftStore(craftPaths(root)).open({ fileRecords: true });
    assert.equal(store.get("knowledge_claim", "legacy").content, "Legacy statement.");
    store.replacePayload("knowledge_claim", "legacy", 1, { scope: "global", status: "expired", content: "Migrated statement." });
    assert.equal(store.get("knowledge_claim", "legacy").content, "Migrated statement.");
    assert.equal(store.findMetadata("knowledge_claim", "legacy", 1)?.status, "expired");
    assert.equal(store.historyMetadata("knowledge_claim", "legacy", 2, 5)[0]?.status, "expired");
    store.create("fixture", "plain", { content: "Plain fixture.", status: "candidate" });
    store.replacePayload("fixture", "plain", 1, { content: "Replacement.", status: "active" });
    assert.equal(store.get("fixture", "plain").content, "Replacement.");
    const metadata = store.create("fixture", "indexed", { metadata: { provenance: "fixture", detail: "Full report omitted." }, knowledge_binding: { scope: "global", content: "Large body." }, scope: "global" });
    assert.equal((metadata.metadata as Record<string, unknown>).detail, "Full report omitted.");
    const indexed = JSON.parse(String(store.database.prepare("SELECT payload_json FROM records WHERE kind='fixture' AND id='indexed'").get()!.payload_json));
    assert.deepEqual(indexed.metadata, { provenance: "fixture" });
    assert.deepEqual(indexed.knowledge_binding, { scope: "global" });
    store.database.prepare("UPDATE meta SET value='v1' WHERE key='record_files'").run();
    store.close();
    store = await new CraftStore(craftPaths(root)).open();
    assert.equal(store.database.prepare("SELECT value FROM meta WHERE key='record_files'").get()!.value, "v2");
    store.close();
    await assert.rejects(new CraftStore(craftPaths(root)).open({ fileRecords: false }), /cannot be disabled/u);
    store = await new CraftStore(craftPaths(root)).open();
    store.database.prepare("UPDATE meta SET value='future' WHERE key='record_files'").run();
    store.close();
    await assert.rejects(new CraftStore(craftPaths(root)).open(), /Unsupported record file/u);
    store = await new CraftStore(craftPaths(join(root, "separate"))).open();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("record files reject foreign paths, unsafe directories and changed or forged identities", async () => {
  const { createHash } = await import("node:crypto");
  const { mkdirSync, symlinkSync, unlinkSync, statSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const { RecordFileStore } = await import("../src/record-files.ts");
  const root = mkdtempSync(join(tmpdir(), "craft-record-file-security-"));
  const files = new RecordFileStore(root, join(root, "knowledge"));
  try {
    assert.throws(() => new RecordFileStore(root, dirname(root)), /must remain/u);
    const objectMetadata = files.write("fixture", "object-meta", 1, { metadata: { provenance: { report: "Only in file." } } }, "time", "time");
    assert.deepEqual(objectMetadata.metadata, {});
    assert.deepEqual(files.payload("fixture", "object-meta", 1, objectMetadata).metadata, { provenance: { report: "Only in file." } });
    const input = { content: "Only in authoritative file.", scope: "global", state: "queued", workspace: "/fixture" };
    const projection = files.write("fixture", "record", 1, input, "2026-01-01", "2026-01-01");
    assert.deepEqual(files.write("fixture", "record", 1, input, "2026-01-01", "2026-01-01"), projection);
    assert.deepEqual(files.payload("fixture", "record", 1, projection), input);
    assert.equal(projection.state, undefined); assert.equal(projection.workspace, undefined);
    assert.equal(files.write("workbench_message_queue", "queue", 1, input, "time", "time").state, "queued");
    assert.equal(files.write("workbench_agent_session_link", "link", 1, input, "time", "time").workspace, "/fixture");
    assert.deepEqual(files.payload("fixture", "inline", 1, input), input);
    assert.equal(statSync(join(root, (projection._record_file as { path: string }).path)).mode & 0o777, 0o600);
    for (const invalid of [null, [], "path"]) assert.throws(() => files.payload("fixture", "record", 1, { _record_file: invalid }), /Invalid record file reference/u);
    const ref = projection._record_file as { path: string; digest: string; bytes: number };
    for (const changes of [{ path: 1 }, { path: join(root, ref.path) }, { path: "../outside.json" }, { path: "knowledge/records/invalid" }, { digest: null }, { digest: "no" }, { bytes: -1 }, { bytes: 0.5 }, { offset: 0 }]) {
      assert.throws(() => files.payload("fixture", "record", 1, { _record_file: { ...ref, ...changes } }), /Invalid record file reference/u);
    }
    assert.throws(() => files.payload("foreign", "record", 1, projection), /identity mismatch/u);
    assert.throws(() => files.payload("fixture", "foreign", 1, projection), /identity mismatch/u);
    assert.throws(() => files.payload("fixture", "record", 2, projection), /identity mismatch/u);
    const path = join(root, ref.path);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace("Only", "None"));
    assert.throws(() => files.payload("fixture", "record", 1, projection), /digest mismatch/u);
    writeFileSync(path, "changed");
    assert.throws(() => files.write("fixture", "record", 1, input, "2026-01-01", "2026-01-01"), /size mismatch/u);
    writeFileSync(path, original);
    unlinkSync(path);
    symlinkSync(join(root, "missing"), path);
    assert.throws(() => files.payload("fixture", "record", 1, projection));
    unlinkSync(path);
    mkdirSync(path);
    assert.throws(() => files.payload("fixture", "record", 1, projection), /size mismatch/u);
    rmSync(path, { recursive: true });
    const branch = dirname(path);
    rmSync(branch, { recursive: true });
    mkdirSync(join(root, "foreign"));
    symlinkSync(join(root, "foreign"), branch);
    assert.throws(() => files.write("fixture", "record", 2, input, "2026-01-01", "2026-01-01"), /directory must be regular/u);
    unlinkSync(branch);
    assert.throws(() => files.payload("fixture", "record", 1, projection), /directory must be regular/u);

    const forged = { schema: "wrong", kind: "fixture", id: "record", version: 1, payload: input };
    const good = { ...forged, schema: "craft.record-file.v1" };
    for (const body of [forged, null, { ...good, payload: [] }, { ...good, payload: null }, { ...good, payload: "body" }, { ...good, id: "other", payload: { ...input, _craft_logical_record_id: "record" } }]) {
      const content = JSON.stringify(body), digest = createHash("sha256").update(content).digest("hex");
      const identity = { path: ref.path, digest, bytes: Buffer.byteLength(content) };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      assert.throws(() => files.payload("fixture", "record", 1, { _record_file: identity }), /identity mismatch/u);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("a record publication I/O failure does not publish a reference or leave a temporary file", async () => {
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const { RecordFileStore } = await import("../src/record-files.ts");
  const root = mkdtempSync(join(tmpdir(), "craft-record-file-io-"));
  const link = fs.linkSync;
  const write = fs.writeFileSync;
  try {
    const files = new RecordFileStore(root, join(root, "knowledge"));
    fs.writeFileSync = () => { throw new Error("write unavailable"); }; syncBuiltinESMExports();
    assert.throws(() => files.write("fixture", "failed-write", 1, {}, "now", "now"), /write unavailable/u);
    assert.throws(() => files.writeColdBatch([{ kind: "fixture", id: "failed-cold-write", version: 1, payload: {}, created_at: "now", updated_at: "now" }]), /write unavailable/u);
    fs.writeFileSync = write; syncBuiltinESMExports();
    fs.linkSync = () => { throw Object.assign(new Error("storage unavailable"), { code: "EIO" }); };
    syncBuiltinESMExports();
    assert.throws(() => files.write("fixture", "failed", 1, { content: "Not committed." }, "now", "now"), /storage unavailable/u);
    assert.throws(() => files.writeColdBatch([{ kind: "fixture", id: "failed-cold", version: 1, payload: {}, created_at: "now", updated_at: "now" }]), /storage unavailable/u);
    const all = fs.readdirSync(root, { recursive: true }) as string[];
    assert(!all.some(path => path.endsWith(".tmp") || path.endsWith(".json") || path.endsWith(".jsonl")));
  } finally {
    fs.linkSync = link; fs.writeFileSync = write;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("file-backed events publish only committed JSONL references and retain stream ordering", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-event-files-"));
  const store = await new CraftStore(craftPaths(root)).open({ fileRecords: true });
  try {
    const first = store.appendEvent("fixture", "observed", { content: "Full event report.", transition_id: "transition-1" });
    assert.equal(first.sequence, 1);
    const indexed = JSON.parse(String(store.database.prepare("SELECT payload_json FROM events WHERE stream='fixture'").get()!.payload_json));
    assert(!JSON.stringify(indexed).includes("Full event report."));
    assert(indexed._record_file.path.endsWith(".jsonl"));
    assert.equal(readFileSync(join(root, indexed._record_file.path), "utf8").split("\n").length, 2);
    assert.deepEqual(store.events("fixture")[0]?.payload, { content: "Full event report.", transition_id: "transition-1" });
    assert.throws(() => store.transaction(() => { store.appendEvent("fixture", "observed", { content: "Aborted event." }); throw new Error("rollback"); }), /rollback/u);
    assert.equal(store.events("fixture").length, 1);
    const retry = store.appendEvent("fixture", "observed", { content: "Committed retry." });
    assert.equal(retry.sequence, 2);
    assert.equal((store.events("fixture")[1]?.payload as Record<string, unknown>).content, "Committed retry.");
    assert.equal(store.events("fixture", 1).length, 1);
    const { mkdirSync } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const projectRoot = join(root, "workspace"); mkdirSync(projectRoot);
    store.create("scope_alias", "project", { status: "active", alias_kind: "path", alias: projectRoot, alias_digest: `sha256:${createHash("sha256").update(JSON.stringify(projectRoot)).digest("hex")}`, scope: { kind: "project", id: "p" } });
    store.create("evolution_cycle", "cycle", { scope: { kind: "project", id: "p" }, status: "active" });
    const payload = { transition_id: "t", request_digest: "digest", cycle_id: "cycle", sequence: 1, content: "Evolution event." };
    const advanced = store.advanceEvolutionCycle("cycle", 1, { scope: { kind: "project", id: "p" }, status: "done" }, "advanced", payload);
    assert.equal(advanced.idempotent, false);
    assert.equal(store.findMetadata("evolution_cycle", "cycle")?.version, 2);
    assert.equal(store.findMetadata("evolution_cycle", "cycle", 2)?.version, 2);
    assert.throws(() => store.findMetadata("evolution_cycle", "cycle", 999), /metadata is unavailable/u);
    assert.equal(store.advanceEvolutionCycle("cycle", 1, {}, "advanced", payload).idempotent, true);
    assert.throws(() => store.advanceEvolutionCycle("cycle", 1, {}, "advanced", { ...payload, request_digest: "changed" }), /idempotency conflict/u);
    assert.deepEqual(store.events("evolution:cycle")[0]?.payload, payload);
    assert.equal(store.appendEvent("evolution:cycle", "advanced", payload).sequence, 1);
    assert.throws(() => store.appendEvent("evolution:cycle", "advanced", { ...payload, content: "Changed." }), /conflicts/u);
    assert.equal(store.appendEvent("evolution:cycle", "advanced", { sequence: 2, content: "Next." }).sequence, 2);

  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("special shards keep indexed payloads small and reject opening file mode without its owner", async () => {
  const { RecordFileStore } = await import("../src/record-files.ts");
  const { CodebaseShardStore } = await import("../src/codebase-shards.ts");
  const { TraceShardStore } = await import("../src/trace-shards.ts");
  const root = mkdtempSync(join(tmpdir(), "craft-file-shards-"));
  const files = new RecordFileStore(root, join(root, "catalog"));
  let codebase = new CodebaseShardStore(root), trace = new TraceShardStore(root);
  codebase.configureRecordFiles(files); trace.configureRecordFiles(files);
  try {
    assert.equal(codebase.findMetadata("codebase_index_shard", "graph"), null);
    assert.deepEqual(codebase.historyMetadata("codebase_index_shard", "graph", 3, 5), []);
    assert.equal(trace.findMetadata("trace", "trace"), null);
    assert.deepEqual(trace.historyMetadata("trace", "trace", 3, 5), []);
    codebase.save("codebase_index_shard", "graph", { definition: "Large graph definition." });
    codebase.save("codebase_index_shard", "graph", { definition: "Revised graph definition." });
    assert.equal(codebase.raw("codebase_index_shard", "graph", 999), null);
    assert.equal(codebase.find("codebase_index_shard", "graph")?.definition, "Revised graph definition.");
    assert.equal(codebase.history("codebase_index_shard", "graph", 2, 5)[0]?.definition, "Large graph definition.");
    assert.equal(codebase.findMetadata("codebase_index_shard", "graph", 1)?.definition, undefined);
    assert.equal(codebase.findMetadata("codebase_index_shard", "graph")?.version, 2);
    assert.equal(codebase.findMetadata("codebase_index_shard", "graph", 99), null);
    assert.equal(codebase.historyMetadata("codebase_index_shard", "graph", 3, 5).length, 2);
    assert.equal(codebase.list("codebase_index_shard", 5, value => value.definition === "Revised graph definition.").length, 1);
    const graphRows = [{ kind: "codebase_index_shard", id: "legacy", version: 1, payload_json: JSON.stringify({ definition: "Legacy graph." }, null, 2), created_at: "time", updated_at: "time" }];
    codebase.importLegacy("legacy", graphRows); codebase.importLegacy("legacy", graphRows);
    const inlineCodebase = new CodebaseShardStore(join(root, "inline-codebase"));
    try { inlineCodebase.importLegacy("legacy", graphRows); inlineCodebase.importLegacy("legacy", graphRows); } finally { inlineCodebase.close(); }
    assert.equal(codebase.find("codebase_index_shard", "legacy")?.definition, "Legacy graph.");
    trace.create("trace", "trace", { status: "open", report: "Large trace report." });
    trace.save("trace", "trace", { status: "closed", report: "Revised trace report." });
    assert.equal(trace.find("trace", "trace")?.report, "Revised trace report.");
    assert.equal(trace.history("trace", "trace", 2, 5)[0]?.report, "Large trace report.");
    assert.equal(trace.findMetadata("trace", "trace")?.status, "closed");
    assert.equal(trace.findMetadata("trace", "trace", 1)?.status, "open");
    assert.equal(trace.findMetadata("trace_event", "missing"), null);
    assert.equal(trace.findMetadata("trace_event", "missing", 99), null);
    assert.equal(trace.historyMetadata("trace", "trace", 3, 5).length, 2);
    assert.deepEqual(trace.historyMetadata("trace_event", "missing", 3, 5), []);
    assert.deepEqual(trace.history("trace", "missing", 2, 5), []);
    assert.deepEqual(trace.history("trace_event", "missing", 2, 5), []);
    assert.equal(trace.list("trace", 5, value => value.report === "Revised trace report.").length, 1);
    assert.equal(trace.hasEvent("no-events", 1), false);
    trace.appendEvent("trace", "observed", { report: "Event report." });
    assert.equal(trace.hasEvent("trace", 1), true);
    assert.equal(trace.hasEvent("trace", 2), false);
    assert.equal((trace.events("trace")[0]?.payload as Record<string, unknown>).report, "Event report.");
    const traceRows = [{ kind: "trace", id: "legacy", version: 1, payload_json: JSON.stringify({ status: "closed", report: "Legacy report." }, null, 2), created_at: "time", updated_at: "time" }];
    const events = [{ stream: "trace:legacy", sequence: 1, event_type: "observed", payload_json: JSON.stringify({ report: "Legacy event." }, null, 2), created_at: "time" }];
    trace.importLegacy("legacy", traceRows, events); trace.importLegacy("legacy", traceRows, events);
    assert.throws(() => trace.importLegacy("legacy", traceRows, [{ ...events[0]!, payload_json: JSON.stringify({ report: "Conflicting." }) }]), /event conflicts/u);
    const inlineTrace = new TraceShardStore(join(root, "inline"));
    try { inlineTrace.importLegacy("legacy", traceRows, events); inlineTrace.importLegacy("legacy", traceRows, events); }
    finally { inlineTrace.close(); }

    assert.equal(trace.find("trace", "legacy")?.report, "Legacy report.");
    assert.equal((trace.events("legacy")[0]?.payload as Record<string, unknown>).report, "Legacy event.");
    codebase.close(); trace.close();
    codebase = new CodebaseShardStore(root); trace = new TraceShardStore(root);
    assert.throws(() => codebase.find("codebase_index_shard", "graph"), /requires its owner/u);
    assert.throws(() => trace.find("trace", "trace"), /requires its owner/u);
    codebase.configureRecordFiles(files); trace.configureRecordFiles(files);
    assert.equal(codebase.find("codebase_index_shard", "graph")?.definition, "Revised graph definition.");
    assert.equal(trace.find("trace", "trace")?.report, "Revised trace report.");
  } finally { codebase.close(); trace.close(); rmSync(root, { recursive: true, force: true }); }
});

test("owner catalogs commit identical source identities independently without legacy partitions", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-owner-records-"));
  const paths = (owner: string) => ({ ...craftPaths(root), databaseDir: join(root, owner), databaseFile: join(root, owner, "publication.db") });
  let knowledge = await new CraftStore(paths("knowledge")).open({ ownerRecords: true });
  const memory = await new CraftStore(paths("memory")).open({ ownerRecords: true });
  try {
    assert.equal(knowledge.ownerRecords, true);
    knowledge.create("trace", "same-trace", { status: "completed", report: "Knowledge trace." });
    memory.create("trace", "same-trace", { status: "completed", report: "Memory trace." });
    assert.equal(knowledge.get("trace", "same-trace").report, "Knowledge trace.");
    assert.equal(memory.get("trace", "same-trace").report, "Memory trace.");
    assert.equal(memory.history("trace", "same-trace", 2, 5).length, 1);
    assert.equal(memory.findMetadata("trace", "same-trace")?.status, "completed");
    assert.equal(memory.historyMetadata("trace", "same-trace", 2, 5).length, 1);
    assert(knowledge.traceShards.directory.startsWith(join(root, "knowledge")));
    assert(memory.traceShards.directory.startsWith(join(root, "memory")));
    knowledge.codebaseShards.save("codebase_index_shard", "same-graph", { definition: "Knowledge graph." });
    memory.codebaseShards.save("codebase_index_shard", "same-graph", { definition: "Memory graph." });
    assert.equal(knowledge.codebaseShards.find("codebase_index_shard", "same-graph")?.definition, "Knowledge graph.");
    assert.equal(memory.codebaseShards.find("codebase_index_shard", "same-graph")?.definition, "Memory graph.");
    assert.equal(memory.findMetadata("codebase_index_shard", "same-graph")?.version, 1);
    assert.equal(memory.historyMetadata("codebase_index_shard", "same-graph", 2, 5).length, 1);
    knowledge.create("knowledge_source", "builtin", { scope: "global", label: "Knowledge source." });
    memory.create("knowledge_source", "builtin", { scope: "global", label: "Memory source." });
    assert.equal(knowledge.get("knowledge_source", "builtin").label, "Knowledge source.");
    assert.equal(memory.get("knowledge_source", "builtin").label, "Memory source.");
    const indexed = JSON.parse(String(memory.database.prepare("SELECT payload_json FROM records WHERE kind='knowledge_source'").get()!.payload_json));
    assert(indexed._record_file.path.startsWith("memory/records/"));
    assert.equal(indexed._knowledge_partition, undefined);
    memory.updateIfVersion("knowledge_source", "builtin", 1, { scope: "global", label: "Memory source revision." });
    assert.equal(memory.get("knowledge_source", "builtin").version, 2);
    memory.save("knowledge_source", "builtin", { scope: "global", label: "Memory source saved." });
    memory.create("context_ephemeral_index", "valid-context", { session_host: "codex", session_id: "one", session_scope_id: sessionStorageScopeId("codex", "one") });
    assert.throws(() => memory.migrateLegacyContextVersions([{ kind: "context_ephemeral_index", id: "valid-context", version: 1 }]), /Host session identity/u);
    memory.save("fixture", "new-via-save", {});

    assert.throws(() => memory.save("knowledge_source", "builtin", { scope: "project:other", label: "Scope changed." }), /cannot change storage scope/u);
    assert.throws(() => memory.create("context_ephemeral_index", "invalid-context", { session_host: "codex", session_id: "one", session_scope_id: sessionStorageScopeId("codex", "two") }), /identity is invalid/u);
    assert.throws(() => memory.createBatch([{ kind: "fixture", id: "batch-before-invalid", payload: {} }, { kind: "context_ephemeral_index", id: "batch-invalid", payload: { session_host: "codex", session_id: "one", session_scope_id: sessionStorageScopeId("codex", "two") } }]), /identity is invalid/u);
    assert.equal(memory.find("fixture", "batch-before-invalid"), null);
    const contentRef = memory.contentStore.writeSync({ kind: "knowledge", record_id: "claim", version: 1, scope: "global", status: "candidate", sensitivity: "internal", source_id: "builtin", body: "Validate the focused fixture before accepting changes." });
    memory.create("knowledge_claim", "claim", { scope: "global", source_id: "builtin", content_ref: contentRef });
    memory.create("knowledge_document", "scoped-content", { scope: { kind: "global", id: "global" }, source_id: "builtin", content_ref: contentRef });
    memory.create("evidence", "memory-proof", { source_type: "human", metadata: { capability_owner: "memory", scope: "global" } });
    const partial = memory.reconcileKnowledgeStorage({ max_records: 1 });
    assert.equal(partial.status, "partial");
    assert.equal(partial.skipped, 1);
    assert.equal(memory.reconcileKnowledgeStorage({ cursor: String(partial.next_cursor) }).status, "completed");
    assert.equal(memory.reconcileKnowledgeStorage({ cursor: Buffer.from(JSON.stringify(["zzz", "", 1])).toString("base64url") }).examined, 0);
    const sourceFile = join(root, indexed._record_file.path), originalSource = readFileSync(sourceFile, "utf8");
    writeFileSync(sourceFile, "changed");
    assert.equal(memory.reconcileKnowledgeStorage().status, "blocked");
    writeFileSync(sourceFile, originalSource);

    const definition = { format: "json", procedure_id: "procedure", procedure_version: 1, kind: "experience", digest: "fixture", path: "before", scope: "global" };
    memory.create("experience_procedure", "procedure", { scope: "global", definition_ref: definition });
    memory.relocateExperienceDefinition("procedure", 1, definition, { ...definition, path: "after" });
    memory.create("evolution_cycle", "cycle", { scope: { kind: "project", id: "fixture" }, status: "active" });
    memory.advanceEvolutionCycle("cycle", 1, { scope: { kind: "project", id: "fixture" }, status: "done" }, "advanced", { transition_id: "t", cycle_id: "cycle", sequence: 1 });
    assert.equal(memory.findMetadata("evolution_cycle", "cycle", 999), null);
    memory.appendEvent("evolution:cycle", "advanced", { sequence: 2 });
    assert.equal(memory.events("evolution:cycle").length, 2);
    assert.throws(() => memory.appendEvent("evolution:absent", "advanced", {}), /unavailable/u);
    knowledge.close();
    const { cpSync, mkdirSync } = await import("node:fs");
    const restoredRoot = join(root, "restored"); mkdirSync(restoredRoot);
    cpSync(join(root, "knowledge"), join(restoredRoot, "knowledge"), { recursive: true });
    const restored = await new CraftStore({ ...craftPaths(restoredRoot), databaseDir: join(restoredRoot, "knowledge"), databaseFile: join(restoredRoot, "knowledge", "publication.db") }).open();
    try {
      assert.equal(restored.get("knowledge_source", "builtin").label, "Knowledge source.");
      assert.equal(restored.get("trace", "same-trace").report, "Knowledge trace.");
      assert.equal(restored.codebaseShards.find("codebase_index_shard", "same-graph")?.definition, "Knowledge graph.");
    } finally { restored.close(); }
    knowledge = await new CraftStore(paths("knowledge")).open();
    assert.equal(knowledge.get("knowledge_source", "builtin").label, "Knowledge source.");
    knowledge.close();
    await assert.rejects(new CraftStore(paths("knowledge")).open({ ownerRecords: false }), /cannot be disabled/u);
    await assert.rejects(new CraftStore(paths("knowledge")).open({ fileRecords: false }), /require file records/u);
    knowledge = await new CraftStore(paths("knowledge")).open();
    knowledge.database.prepare("UPDATE meta SET value='future' WHERE key='owner_records'").run();
    knowledge.close();
    await assert.rejects(new CraftStore(paths("knowledge")).open(), /Unsupported owner record/u);
    knowledge = await new CraftStore(craftPaths(join(root, "legacy"))).open();
    knowledge.create("knowledge_claim", "partitioned", { scope: "global", content: "Old layout." });
    knowledge.close();
    await assert.rejects(new CraftStore(craftPaths(join(root, "legacy"))).open({ ownerRecords: true }), /verified migration/u);
  } finally { knowledge.close(); memory.close(); rmSync(root, { recursive: true, force: true }); }
});

test("cold immutable JSONL ranges preserve exact UTF-8 records, special shard imports and integrity checks", async () => {
  const { RecordFileStore } = await import("../src/record-files.ts");
  const { TraceShardStore } = await import("../src/trace-shards.ts");
  const { CodebaseShardStore } = await import("../src/codebase-shards.ts");
  const root = mkdtempSync(join(tmpdir(), "craft-cold-records-")), files = new RecordFileStore(root, join(root, "runtime"));
  const trace = new TraceShardStore(root), codebase = new CodebaseShardStore(root);
  trace.configureRecordFiles(files, true); codebase.configureRecordFiles(files, true);
  try {
    assert.deepEqual(files.writeColdBatch([]), []);
    const entries = [
      { kind: "trace_event", id: "event", version: 2, payload: { trace_id: "trace", report: "精确历史证据。" }, created_at: "time", updated_at: "time" },
      { kind: "codebase_index_shard", id: "graph", version: 1, payload: { definition: "Graph body." }, created_at: "time", updated_at: "time" },
      { kind: "event:observed", id: "trace:trace", version: 1, payload: { report: "历史事件。" }, created_at: "time", updated_at: "time" },
    ];
    const projections = files.writeColdBatch(entries);
    assert.deepEqual(files.writeColdBatch(entries), projections);
    const references = projections.map(value => value._record_file as { path: string; digest: string; bytes: number; offset: number });
    assert(references.every(ref => ref.path === references[0]!.path));
    assert(references[1]!.offset > references[0]!.offset);
    for (const [index, entry] of entries.entries()) assert.deepEqual(files.payload(entry.kind, entry.id, entry.version, projections[index]!), entry.payload);
    const first = references[0]!;
    for (const invalid of [{ offset: -1 }, { offset: 0.5 }, { offset: undefined }, { offset: Number.MAX_SAFE_INTEGER }, { bytes: Number.MAX_SAFE_INTEGER }]) assert.throws(() => files.payload("trace_event", "event", 2, { _record_file: { ...first, ...invalid } }));
    assert.throws(() => files.payload("trace_event", "event", 1, projections[0]!), /identity/u);
    const path = join(root, first.path), original = readFileSync(path);
    const changed = Buffer.from(original); changed[10] = changed[10]! ^ 1; writeFileSync(path, changed);
    assert.throws(() => files.payload("trace_event", "event", 2, projections[0]!), /digest/u);
    writeFileSync(path, original);
    const fs = (await import("node:fs")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const read = fs.readSync;
    try {
      fs.readSync = () => 0; syncBuiltinESMExports();
      assert.throws(() => files.payload("trace_event", "event", 2, projections[0]!), /range is incomplete/u);
    } finally { fs.readSync = read; syncBuiltinESMExports(); }
    const { payload: _tracePayload, ...traceRow } = entries[0]!;
    const { payload: _graphPayload, ...graphRow } = entries[1]!;
    trace.importLegacy("trace", [{ ...traceRow, payload_json: JSON.stringify(projections[0]) }], [{ stream: "trace:trace", sequence: 1, event_type: "observed", payload_json: JSON.stringify(projections[2]), created_at: "time" }]);
    codebase.importLegacy("graph", [{ ...graphRow, payload_json: JSON.stringify(projections[1]) }]);
    codebase.importLegacy("graph", [{ ...graphRow, payload_json: JSON.stringify(projections[1]) }]);
    assert.equal(trace.find("trace_event", "event")?.report, "精确历史证据。");
    assert.equal((trace.events("trace")[0]!.payload as Record<string, unknown>).report, "历史事件。");
    assert.equal(codebase.find("codebase_index_shard", "graph")?.definition, "Graph body.");
    assert.throws(() => files.writeColdBatch(Array(1001).fill(entries[0])), /1000/u);
    const large = { ...entries[1]!, payload: { definition: "x".repeat(4 * 1024 * 1024) } };
    assert.throws(() => files.writeColdBatch([large, large]), /8 MiB/u);
    const huge = { ...large, payload: { definition: "x".repeat(8 * 1024 * 1024) } };
    assert.deepEqual(files.payload(huge.kind, huge.id, huge.version, files.writeColdBatch([huge])[0]!), huge.payload);
  } finally { trace.close(); codebase.close(); rmSync(root, { recursive: true, force: true }); }
});

test("human prose uses reusable Markdown in hot and cold envelopes while structure and field order remain exact", async () => {
  const { RecordFileStore } = await import("../src/record-files.ts");
  const { createHash } = await import("node:crypto");
  const root = mkdtempSync(join(tmpdir(), "craft-record-prose-")), files = new RecordFileStore(root, join(root, "runtime"));
  try {
    const text = "先验证明确的结果，再接受本次变更。\n保留复查证据。";
    const input = { prompt: text, steps: [{ kind: "check", command: "fixture" }], description: text, goal: "Preserve the fixture outcome.", status: "queued" };
    const projection = files.write("task", "task", 1, input, "time", "time"), ref = projection._record_file as { path: string; digest: string; bytes: number };
    const path = join(root, ref.path), envelope = JSON.parse(readFileSync(path, "utf8"));
    assert(!JSON.stringify(envelope).includes(text));
    assert.deepEqual(envelope.payload.steps, input.steps);
    assert.equal(envelope.payload.prompt, undefined);
    assert.equal(envelope.prose_refs.prompt.path, envelope.prose_refs.description.path);
    assert.equal(readFileSync(join(root, envelope.prose_refs.prompt.path), "utf8"), text);
    assert.equal(JSON.stringify(files.payload("task", "task", 1, projection)), JSON.stringify(input));
    assert(files.referencedFiles("task", "task", 1, projection).some(ref => ref.path.endsWith(".md") && ref.digest));
    assert.deepEqual(files.referencedFiles("fixture", "inline", 1, { content: "Inline." }), []);
    const next = files.write("task", "task", 2, { ...input, status: "completed" }, "time", "next");
    assert.equal(JSON.parse(readFileSync(join(root, (next._record_file as { path: string }).path), "utf8")).prose_refs.prompt.path, envelope.prose_refs.prompt.path);
    const cold = files.writeColdBatch([{ kind: "program_memory_candidate", id: "candidate", version: 1, payload: { statement: text, steps: input.steps }, created_at: "time", updated_at: "time" }])[0]!;
    assert(!readFileSync(join(root, (cold._record_file as { path: string }).path), "utf8").includes(text));
    assert.equal(files.payload("program_memory_candidate", "candidate", 1, cold).statement, text);
    assert.equal(files.referencedFiles("program_memory_candidate", "candidate", 1, cold)[0]?.digest, undefined);
    assert.deepEqual(files.payload("task", "empty", 1, files.write("task", "empty", 1, { prompt: "", description: { schema: "machine" } }, "time", "time")), { prompt: "", description: { schema: "machine" } });
    assert.deepEqual(files.payload("task", "optional", 1, files.write("task", "optional", 1, { omitted: undefined, prompt: text }, "time", "time")), { prompt: text });
    assert.deepEqual(files.payload("task", "legacy-unicode", 1, files.write("task", "legacy-unicode", 1, { prompt: "\ud800" }, "time", "time")), { prompt: "\ud800" });
    assert.equal(files.payload("constructor", "arbitrary-kind", 1, files.write("constructor", "arbitrary-kind", 1, { text }, "time", "time")).text, text);
    const forge = (prose: unknown, payload = envelope.payload, schema = envelope.schema) => {
      const content = JSON.stringify({ ...envelope, schema, payload, prose_refs: prose }); writeFileSync(path, content);
      return { _record_file: { ...ref, digest: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content) } };
    };
    const prose = envelope.prose_refs.prompt;
    assert.throws(() => files.payload("task", "task", 1, forge(envelope.prose_refs, envelope.payload, "craft.record-file.v1")), /storage version/u);
    assert.throws(() => files.payload("task", "task", 1, forge(undefined)), /prose references/u);
    for (const invalid of [null, [], "bad"]) assert.throws(() => files.payload("task", "task", 1, forge(invalid)), /prose references/u);
    for (const invalid of [{ unknown: prose }, { prompt: null }, { prompt: "invalid" }, { prompt: { ...prose, position: -1 } }, { prompt: { ...prose, position: 0.5 } }, { prompt: { ...prose, position: 999 } }, { prompt: { ...prose, path: 5 } }, { prompt: { ...prose, path: ref.path } }, { prompt: prose, description: prose }]) assert.throws(() => files.payload("task", "task", 1, forge(invalid)), /prose reference/u);
    assert.throws(() => files.payload("task", "task", 1, forge({ prompt: prose }, { ...envelope.payload, prompt: "Ambiguous inline body." })), /prose reference/u);
    assert.throws(() => files.payload("task", "task", 1, forge({})), /prose references/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("record metadata keeps only typed per-kind SQL and authorization fields", async () => {
  const { recordMetadata } = await import("../src/record-files.ts");
  const large = { body: "authority only" };
  assert.deepEqual(recordMetadata("unknown", { state: "queued", workspace: "path", sequence: 2, metadata: large }), { metadata: {} });
  assert.deepEqual(recordMetadata("workbench_message_queue", { state: "queued", sequence: 2, workspace: "path" }), { state: "queued", sequence: 2 });
  assert.deepEqual(recordMetadata("workbench_message_queue", { state: large, sequence: Infinity, link_id: [] }), {});
  assert.deepEqual(recordMetadata("unknown", { source_id: large }), { scope_envelope: "__invalid_index_metadata__" });
  assert.deepEqual(recordMetadata("unknown", { source_id: "__invalid_index_metadata__", status: null, ignored: undefined }), { source_id: "__invalid_index_metadata__", status: null });
  const envelope = { applicability: { kind: "project", id: "p", body: large }, audience: { mode: "principals", principal_ids: ["a"] }, tenant_id: null, purpose: "fact", retention: "persistent" };
  assert.deepEqual(recordMetadata("unknown", { scope_envelope: envelope }).scope_envelope, { ...envelope, applicability: { kind: "project", id: "p" } });
  for (const invalid of [[], null, "invalid", {}, { kind: 2, id: "p" }, { kind: "project" }]) {
    if (invalid !== null) assert.equal(recordMetadata("unknown", { canonical_scope: invalid }).canonical_scope, "__invalid_index_metadata__");
  }
  for (const invalid of [{ audience: [] }, { audience: { principal_ids: [1] } }, { tenant_id: 2 }]) assert.equal(recordMetadata("unknown", { scope_envelope: invalid }).scope_envelope, "__invalid_index_metadata__");
  assert.deepEqual(recordMetadata("unknown", { scope: null, scope_envelope: null, canonical_scope: { kind: "global", id: "global" }, knowledge_binding: { scope: "global", body: large }, content_ref: { path: "file", bytes: 3, body: large } }), { scope: null, canonical_scope: { kind: "global", id: "global" }, scope_envelope: null, content_ref: { path: "file", bytes: 3 }, knowledge_binding: { scope: "global" } });
  assert.deepEqual(recordMetadata("experience_procedure", { lifecycle: "rejected", body: large }), { lifecycle: "rejected" });
  assert.deepEqual(recordMetadata("unknown", { lifecycle: "rejected" }), {});
  assert.deepEqual(recordMetadata("event:advance", { transition_id: "t", request_digest: "not indexed" }), { transition_id: "t" });
});
