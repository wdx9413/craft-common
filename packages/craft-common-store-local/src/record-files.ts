import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type Payload = Record<string, unknown>;
type FileRef = { path: string; digest: string; bytes: number; offset?: number };
export type ColdRecordEntry = { kind: string; id: string; version: number; payload: Payload; created_at: string; updated_at: string };

// These fields are used by indexed SQL in Store and ContextReadGuard. Bodies,
// definitions, arrays of steps, evidence reports and arbitrary metadata stay in files.
const STRING_FIELDS = new Set([
  "source_id", "document_id", "claim_id", "content_digest", "memory_id", "procedure_id", "scenario_key",
  "source_session_id", "session_id", "session_host", "session_scope_id", "turn_id", "definition_digest",
  "source_revision_digest", "input_digest", "author", "lifecycle", "status", "state", "workspace", "workspace_id", "root_path",
  "canonical_root_path", "sensitivity", "trust", "valid_until", "host_kind", "device_id", "source_type", "project_id",
  "project_scope_id", "scope_id", "scope_kind", "task_id", "trace_id", "transition_id", "last_event_at", "started_at",
  "link_id", "kind", "id", "_craft_logical_record_id", "request_digest", "alias_kind", "alias", "alias_digest",
  "identity_digest", "project_kind", "remote_digest", "local_path_alias",
]);
// Shared fields support scope/Source authorization and ComponentAssets revision identity.
const SHARED_FIELDS = new Set(["source_id", "status", "content_digest", "definition_digest", "source_revision_digest", "input_digest", "author", "sensitivity", "trust", "valid_until", "workspace_id", "host_kind", "device_id", "project_id", "project_scope_id", "scope_id", "scope_kind", "session_id", "session_host", "session_scope_id", "task_id", "_craft_logical_record_id"]);
const KIND_FIELDS = new Map<string, readonly string[]>(Object.entries({
  experience_procedure: ["lifecycle"], knowledge_claim: ["document_id", "claim_id"], knowledge_document: ["document_id"],
  memory_confirmation: ["memory_id", "memory_version"],
  memory_observation: ["observed_at_ms", "source_session_id"], codex_hook_signal: ["turn_id", "observed_at_ms"],
  context_ephemeral_index: ["turn_id"], context_resume_snapshot: ["turn_id"],
  trace: ["last_event_at", "started_at"], trace_event: ["trace_id", "sequence"], trace_feedback: ["trace_id"], telemetry_event: ["trace_id"],
  workbench_message_queue: ["link_id", "state", "sequence"], workbench_agent_session_link: ["workspace"],
  scope_alias: ["alias_kind", "alias", "alias_digest", "identity_digest", "root_path", "canonical_root_path"],
  project_identity: ["identity_digest", "project_kind", "remote_digest", "local_path_alias", "root_path", "canonical_root_path"],
  event: ["transition_id"],
}));
const NUMBER_FIELDS = new Set(["memory_version", "observed_at_ms", "sequence"]);
const AUTH_FIELDS = new Set(["source_id", "workspace_id", "sensitivity", "trust", "valid_until", "host_kind", "device_id", "project_id", "project_scope_id", "scope_id", "scope_kind", "session_id", "session_host", "session_scope_id"]);
const INVALID_METADATA = Symbol("invalid index metadata");
const INVALID_AUTHORIZATION = "__invalid_index_metadata__";
type Projector = (value: unknown) => unknown;
const stringValue: Projector = value => typeof value === "string" ? value : INVALID_METADATA;
const numberValue: Projector = value => typeof value === "number" && Number.isFinite(value) ? value : INVALID_METADATA;
const nullableString: Projector = value => value === null ? null : stringValue(value);
function objectFields(value: unknown, fields: Record<string, Projector>): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return INVALID_METADATA;
  const raw = value as Payload, result: Payload = {};
  for (const [key, project] of Object.entries(fields)) if (raw[key] !== undefined) {
    const item = project(raw[key]);
    if (item === INVALID_METADATA) return INVALID_METADATA;
    result[key] = item;
  }
  return result;
}
function scopeObject(value: unknown): unknown {
  const result = objectFields(value, { kind: stringValue, id: stringValue });
  return result && typeof result === "object" && typeof (result as Payload).kind === "string" && typeof (result as Payload).id === "string" ? result : INVALID_METADATA;
}
const canonicalScope: Projector = value => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every(key => key === "kind" || key === "id") ? scopeObject(value) : INVALID_METADATA;
const scopeValue: Projector = value => typeof value === "string" || value === null ? value : scopeObject(value);
const scopeEnvelope: Projector = value => value === null ? null : objectFields(value, {
  applicability: scopeObject, custody: scopeObject,
  audience: item => objectFields(item, { mode: stringValue, principal_ids: ids => Array.isArray(ids) && ids.every(id => typeof id === "string") ? [...ids] : INVALID_METADATA }),
  purpose: stringValue, retention: stringValue, tenant_id: nullableString,
});
const contentRef: Projector = value => objectFields(value, { kind: stringValue, record_id: stringValue, version: numberValue,
  path: stringValue, digest: stringValue, bytes: numberValue, format: stringValue, title: stringValue, scope: stringValue });


const PROSE_FIELDS = new Map<string, readonly string[]>(Object.entries({
  craft_note: ["text"], craft_notes_location: ["description"], device: ["device_note", "note", "description"], program_memory_candidate: ["statement"],
  task: ["prompt", "description", "goal"], evidence: ["claim"],
  knowledge_claim: ["content"], knowledge_document: ["content", "body"], wiki_page: ["body"],
  memory_candidate: ["content"], memory_ledger: ["content"], episodic_memory: ["content"], semantic_memory: ["content"],
}));
type ProseRef = FileRef & { position: number };
type Envelope = { schema: string; kind: string; id: string; version: number; payload: Payload; prose_refs?: Record<string, ProseRef> };

function sha(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

export function recordMetadata(kind: string, payload: Payload): Payload {
  const projection: Payload = {};
  let invalidAuthorization = false;
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    if ((SHARED_FIELDS.has(key) || (KIND_FIELDS.get(kind)?.includes(key) || kind.startsWith("event:") && key === "transition_id")) && (STRING_FIELDS.has(key) || NUMBER_FIELDS.has(key))) {
      const item = NUMBER_FIELDS.has(key) ? numberValue(value) : nullableString(value);
      if (item !== INVALID_METADATA) projection[key] = item;
      else if (AUTH_FIELDS.has(key)) invalidAuthorization = true;
    }
  }
  for (const [key, project] of Object.entries({ scope: scopeValue, canonical_scope: canonicalScope, scope_envelope: scopeEnvelope, content_ref: contentRef,
    knowledge_binding: (value: unknown) => objectFields(value, { scope: scopeValue }) })) {
    if (payload[key] !== undefined) { const value = project(payload[key]); projection[key] = value === INVALID_METADATA ? INVALID_AUTHORIZATION : value; }
  }
  const metadata = payload.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    projection.metadata = Object.fromEntries(Object.entries(metadata).filter(([key, value]) => ["capability_owner", "provenance", "review_id"].includes(key) && typeof value === "string"));
  }
  if (invalidAuthorization) projection.scope_envelope = INVALID_AUTHORIZATION;
  return projection;
}

/** Immutable file payloads plus the metadata required by current SQL callers. */
export class RecordFileStore {
  readonly root: string;
  readonly directory: string;
  constructor(root: string, catalogDirectory: string) {
    this.root = resolve(root);
    this.directory = relative(this.root, resolve(catalogDirectory, "records")).split(sep).join("/");
    if (!this.directory || isAbsolute(this.directory) || this.directory === ".." || this.directory.startsWith("../")) throw new Error("Record file catalog must remain in its data root");
  }

  private regularDirectory(directory: string, writing: boolean): void {
    const parts = relative(this.root, directory).split(sep);
    let current = this.root;
    for (const part of ["", ...parts]) {
      current = join(current, part);
      let stat = lstatSync(current, { throwIfNoEntry: false });
      if (!stat && writing) { mkdirSync(current, { mode: 0o700 }); stat = lstatSync(current); }
      if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("Record file directory must be regular");
    }
  }

  write(kind: string, id: string, version: number, payload: Payload, createdAt: string, updatedAt: string, format: "json" | "jsonl" = "json"): Payload {
    const stored = this.withProse(kind, payload);
    const content = JSON.stringify({ schema: stored.prose_refs ? "craft.record-file.v2" : "craft.record-file.v1", kind, id, version, created_at: createdAt, updated_at: updatedAt, ...stored }) + (format === "jsonl" ? "\n" : "");
    const digest = sha(content);
    const path = [this.directory, sha(kind).slice(0, 16), sha(id), `${version}-${digest}.${format}`].join("/");
    this.publish(path, content);
    return this.projection(kind, payload, { path, digest, bytes: Buffer.byteLength(content) });
  }

  private publish(path: string, content: string | Buffer, cold = false): void {
    const target = join(this.root, path);
    this.regularDirectory(dirname(target), true);
    const temporary = `${target}.${randomUUID()}.tmp`, fd = openSync(temporary, "wx", 0o600);
    try {
      try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
      try { linkSync(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        this.readFile({ path, digest: sha(content), bytes: Buffer.byteLength(content), ...(cold ? { offset: 0 } : {}) });
      }
    } finally { unlinkSync(temporary); }
  }

  private withProse(kind: string, payload: Payload): { payload: Payload; prose_refs?: Record<string, ProseRef> } {
    const fields = PROSE_FIELDS.get(kind);
    if (!fields) return { payload };
    const stored = JSON.parse(JSON.stringify(payload)) as Payload, refs: Record<string, ProseRef> = {};
    for (const [position, [field, value]] of Object.entries(stored).entries()) {
      // Invalid legacy Unicode remains losslessly JSON-escaped rather than being replaced during UTF-8 encoding.
      if (!fields.includes(field) || typeof value !== "string" || !value || !value.isWellFormed()) continue;
      const path = `${this.directory}/prose/${sha(value)}.md`;
      this.publish(path, value);
      refs[field] = { path, digest: sha(value), bytes: Buffer.byteLength(value), position };
      delete stored[field];
    }
    return { payload: stored, ...(Object.keys(refs).length ? { prose_refs: refs } : {}) };
  }

  private projection(kind: string, payload: Payload, reference: FileRef): Payload {
    return { ...recordMetadata(kind, payload), _record_file: reference };
  }

  writeColdBatch(entries: readonly ColdRecordEntry[]): Payload[] {
    if (!entries.length) return [];
    if (entries.length > 1000) throw new Error("Cold record batch exceeds 1000 entries");
    const lines = entries.map(entry => {
      const stored = this.withProse(entry.kind, entry.payload);
      return Buffer.from(JSON.stringify({ schema: stored.prose_refs ? "craft.record-file.v2" : "craft.record-file.v1", kind: entry.kind, id: entry.id, version: entry.version, created_at: entry.created_at, updated_at: entry.updated_at, ...stored }) + "\n");
    });
    const content = Buffer.concat(lines);
    if (entries.length > 1 && content.length > 8 * 1024 * 1024) throw new Error("Cold record batch exceeds 8 MiB");
    const path = `${this.directory}/cold/${sha(content)}.jsonl`;
    this.publish(path, content, true);
    let offset = 0;
    return entries.map((entry, index) => {
      const line = lines[index]!;
      const reference = { path, digest: sha(line), offset, bytes: line.length };
      offset += line.length;
      return this.projection(entry.kind, entry.payload, reference);
    });
  }

  private coldReference(ref: FileRef): boolean {
    const suffix = typeof ref.path === "string" ? ref.path.slice(this.directory.length + 1) : "";
    const cold = /^cold\/[a-f0-9]{64}\.jsonl$/u.test(suffix);
    if (typeof ref.path !== "string" || isAbsolute(ref.path) || !ref.path.startsWith(`${this.directory}/`)
      || !(cold || /^prose\/[a-f0-9]{64}\.md$/u.test(suffix) || /^[a-f0-9]{16}\/[a-f0-9]{64}\/[1-9]\d*-[a-f0-9]{64}\.jsonl?$/u.test(suffix))
      || (cold ? !Number.isSafeInteger(ref.offset) || Number(ref.offset) < 0 : ref.offset !== undefined)
      || typeof ref.digest !== "string" || !/^[a-f0-9]{64}$/u.test(ref.digest) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new Error("Invalid record file reference");
    return cold;
  }

  private readFile(ref: FileRef): string {
    const cold = this.coldReference(ref);
    const path = join(this.root, ref.path);
    this.regularDirectory(dirname(path), false);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (cold ? Number(ref.offset) + ref.bytes > stat.size : stat.size !== ref.bytes)) throw new Error("Record file size mismatch");
      let content: Buffer;
      if (cold) {
        content = Buffer.alloc(ref.bytes);
        let length = 0;
        while (length < content.length) {
          const count = readSync(fd, content, length, content.length - length, Number(ref.offset) + length);
          if (count === 0) throw new Error("Record file range is incomplete");
          length += count;
        }
      } else content = readFileSync(fd);
      if (sha(content) !== ref.digest) throw new Error("Record file digest mismatch");
      return content.toString("utf8");
    } finally { closeSync(fd); }
  }

  private envelope(kind: string, id: string, version: number, projection: Payload): Envelope | null {
    if (projection._record_file === undefined) return null;
    if (!projection._record_file || typeof projection._record_file !== "object" || Array.isArray(projection._record_file)) throw new Error("Invalid record file reference");
    const record = JSON.parse(this.readFile(projection._record_file as FileRef)) as Envelope;
    if (!record || typeof record !== "object" || !["craft.record-file.v1", "craft.record-file.v2"].includes(record.schema) || record.kind !== kind || (record.id !== id && !(record.payload?._craft_logical_record_id === id && record.id.startsWith(`${id}:revision:`))) || record.version !== version
      || !record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) throw new Error("Record file identity mismatch");
    return record;
  }

  private proseReferences(kind: string, record: Envelope): Array<[string, ProseRef]> {
    if (record.schema === "craft.record-file.v1") {
      if (record.prose_refs !== undefined) throw new Error("Invalid record prose storage version");
      return [];
    }
    if (!record.prose_refs || typeof record.prose_refs !== "object" || Array.isArray(record.prose_refs) || !Object.keys(record.prose_refs).length) throw new Error("Invalid record prose references");
    const count = Object.keys(record.payload).length, positions = new Set<number>();
    const refs = Object.entries(record.prose_refs).sort((left, right) => left[1]?.position - right[1]?.position);
    for (const [index, [field, ref]] of refs.entries()) {
      if (!PROSE_FIELDS.get(kind)?.includes(field) || Object.hasOwn(record.payload, field) || !ref || typeof ref !== "object"
        || !Number.isSafeInteger(ref.position) || ref.position < 0 || ref.position > count + index || positions.has(ref.position)
        || typeof ref.path !== "string" || !ref.path.endsWith(".md")) throw new Error("Invalid record prose reference");
      this.coldReference(ref);
      positions.add(ref.position);
    }
    return refs;
  }

  /** Enumerate protected physical dependencies; range digests are not whole-chunk digests. */
  referencedFiles(kind: string, id: string, version: number, projection: Payload): Array<{ path: string; digest?: string }> {
    const record = this.envelope(kind, id, version, projection);
    if (!record) return [];
    return [projection._record_file as FileRef, ...this.proseReferences(kind, record).map(([, ref]) => ref)]
      .map(ref => ({ path: ref.path, ...(ref.offset === undefined ? { digest: ref.digest } : {}) }));
  }

  payload(kind: string, id: string, version: number, projection: Payload): Payload {
    const record = this.envelope(kind, id, version, projection);
    if (!record) return projection;
    const values = Object.entries(record.payload);
    for (const [field, ref] of this.proseReferences(kind, record)) values.splice(ref.position, 0, [field, this.readFile(ref)]);
    return Object.fromEntries(values);
  }
}
