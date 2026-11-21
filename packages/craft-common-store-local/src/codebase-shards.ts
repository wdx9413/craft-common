import { RecordFileStore, recordMetadata } from "./record-files.ts";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sqliteBusyTimeoutMs } from "./sqlite-busy-timeout.ts";
import type { JsonObject } from "./store.ts";

export const CODEBASE_GRAPH_KINDS = new Set(["codebase_index_shard", "codebase_index_edge_route"]);
export type GraphRow = { kind: string; id: string; version: number; payload_json: string; created_at: string; updated_at: string };
const SHARD_COUNT = 16;
const RESERVED = new Set(["id", "version", "created_at", "updated_at"]);

/** Legacy Codebase graph records retain their original storage format in 16 small WAL databases. */
export class CodebaseShardStore {
  directory: string;
  #recordFiles: RecordFileStore | null = null;
  configureRecordFiles(files: RecordFileStore, ownerRecords = false): void {
    this.close(); this.#recordFiles = files;
    if (ownerRecords) this.directory = join(dirname(join(files.root, files.directory)), "codebase", "legacy-graph-v1");
  }

  private payload(row: Record<string, unknown>): JsonObject {
    const payload = JSON.parse(String(row.payload_json)) as JsonObject;
    return this.#recordFiles?.payload(String(row.kind), String(row.id), Number(row.version), payload) ?? payload;
  }

  private logicalRow(row: Record<string, unknown>): Record<string, unknown> {
    return { kind: row.kind, id: row.id, version: row.version, payload_json: this.#recordFiles ? JSON.stringify(this.payload(row)) : row.payload_json, created_at: row.created_at, updated_at: row.updated_at };
  }

  private stored(row: Record<string, unknown>): string {
    if (!this.#recordFiles) return String(row.payload_json);
    const indexed = JSON.parse(String(row.payload_json)) as JsonObject;
    if (indexed._record_file !== undefined) { this.payload(row); return String(row.payload_json); }
    return JSON.stringify(this.#recordFiles.write(String(row.kind), String(row.id), Number(row.version), JSON.parse(String(row.payload_json)) as JsonObject, String(row.created_at), String(row.updated_at)));
  }
  #databases = new Map<string, DatabaseSync>();

  constructor(dataRoot: string) { this.directory = join(dataRoot, "codebase", "legacy-graph-v1"); }

  private shard(id: string): number {
    if (!id) throw new Error("Codebase graph id must not be empty");
    return createHash("sha256").update(id).digest()[0]! % SHARD_COUNT;
  }

  private database(id: string, create: boolean): DatabaseSync | null {
    return this.databaseForShard(this.shard(id), create);
  }

  private databaseForShard(shard: number, create: boolean): DatabaseSync | null {
    const key = `${shard}:${create ? "write" : "read"}`;
    const cached = this.#databases.get(key);
    if (cached) return cached;
    const file = join(this.directory, `${shard.toString(16).padStart(2, "0")}.db`);
    if (!create && !existsSync(file)) return null;
    if (create) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const directory of [join(this.directory, "..", ".."), join(this.directory, ".."), this.directory]) {
      const stat = lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Codebase shard path must use regular directories");
    }
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Codebase shard must be a regular file");
    }
    const database = new DatabaseSync(file, { readOnly: !create });
    try {
      database.exec(`PRAGMA busy_timeout=${sqliteBusyTimeoutMs()}`);
      if (create && String((database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toLowerCase() !== "wal")
        database.exec("PRAGMA journal_mode=WAL");
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='records'").get()) {
        if (!create) throw new Error("Codebase shard records are unavailable");
        database.exec(`CREATE TABLE records(
        kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id,version));
        CREATE INDEX records_latest ON records(kind,id,version DESC);`);
      }
      const fileMode = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_file_mode'").get();
      if (fileMode && !this.#recordFiles) throw new Error("File-backed shard requires its owner record file store");
      if (create && this.#recordFiles && !fileMode) database.exec("CREATE TABLE IF NOT EXISTS record_file_mode(version TEXT NOT NULL CHECK(version='v1')); INSERT OR IGNORE INTO record_file_mode VALUES('v1')");
    } catch (error) { database.close(); throw error; }
    this.#databases.set(key, database);
    return database;
  }

  private existing(): DatabaseSync[] {
    const result: DatabaseSync[] = [];
    for (let shard = 0; shard < SHARD_COUNT; shard++) {
      const database = this.databaseForShard(shard, false);
      if (database) result.push(database);
    }
    return result;
  }

  raw(kind: string, id: string, version?: number): GraphRow | null {
    if (!CODEBASE_GRAPH_KINDS.has(kind)) throw new Error("Unsupported Codebase graph kind");
    const database = this.database(id, false);
    if (!database) return null;
    const row = (version === undefined
      ? database.prepare("SELECT * FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1").get(kind, id)
      : database.prepare("SELECT * FROM records WHERE kind=? AND id=? AND version=?").get(kind, id, version)) as GraphRow | undefined;
    return row ?? null;
  }

  findMetadata(kind: string, id: string, version?: number): JsonObject | null {
    if (!CODEBASE_GRAPH_KINDS.has(kind)) throw new Error("Unsupported Codebase graph kind");
    const database = this.database(id, false);
    if (!database) return null;
    const row = version === undefined
      ? database.prepare("SELECT * FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1").get(kind, id)
      : database.prepare("SELECT * FROM records WHERE kind=? AND id=? AND version=?").get(kind, id, version);
    return row ? { ...recordMetadata(kind, JSON.parse(String(row.payload_json))), id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at } : null;
  }

  find(kind: string, id: string, version?: number): JsonObject | null {
    const row = this.raw(kind, id, version);
    return row ? { ...this.payload(row), id: row.id, version: row.version,
      created_at: row.created_at, updated_at: row.updated_at } : null;
  }

  historyMetadata(kind: string, id: string, before: number, limit: number): JsonObject[] {
    if (!CODEBASE_GRAPH_KINDS.has(kind)) throw new Error("Unsupported Codebase graph kind");
    const database = this.database(id, false);
    if (!database) return [];
    return database.prepare("SELECT * FROM records WHERE kind=? AND id=? AND version<? ORDER BY version DESC LIMIT ?").all(kind, id, before, limit)
      .map(row => ({ ...recordMetadata(kind, JSON.parse(String(row.payload_json))), id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at }));
  }

  history(kind: string, id: string, before: number, limit: number): JsonObject[] {
    if (!CODEBASE_GRAPH_KINDS.has(kind)) throw new Error("Unsupported Codebase graph kind");
    const database = this.database(id, false);
    if (!database) return [];
    return (database.prepare("SELECT * FROM records WHERE kind=? AND id=? AND version<? ORDER BY version DESC LIMIT ?")
      .all(kind, id, before, limit) as GraphRow[]).map(row => ({ ...this.payload(row),
      id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at }));
  }

  save(kind: string, id: string, value: JsonObject, version?: number): JsonObject {
    if (!CODEBASE_GRAPH_KINDS.has(kind)) throw new Error("Unsupported Codebase graph kind");
    const database = this.database(id, true)!;
    database.exec("BEGIN IMMEDIATE");
    try {
      const payload = Object.fromEntries(Object.entries(value).filter(([key]) => !RESERVED.has(key)));
      const next = version ?? Number((database.prepare("SELECT COALESCE(MAX(version),0)+1 n FROM records WHERE kind=? AND id=?")
        .get(kind, id) as { n: number }).n);
      const now = new Date().toISOString();
      database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
        .run(kind, id, next, this.stored({ kind, id, version: next, payload_json: JSON.stringify(payload), created_at: now, updated_at: now }), now, now);
      database.exec("COMMIT");
      return { ...payload, id, version: next, created_at: now, updated_at: now };
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }

  importLegacy(id: string, rows: readonly GraphRow[]): void {
    const database = this.database(id, true)!;
    database.exec("BEGIN IMMEDIATE");
    try {
      const read = database.prepare("SELECT kind,id,version,payload_json,created_at,updated_at FROM records WHERE kind=? AND id=? AND version=?");
      const insert = database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)");
      for (const row of rows) {
        if (!CODEBASE_GRAPH_KINDS.has(row.kind) || row.id !== id) throw new Error("Codebase migration record has a different owner");
        const current = read.get(row.kind, row.id, row.version);
        if (current) { if (JSON.stringify(this.logicalRow(current)) !== JSON.stringify(this.logicalRow(row))) throw new Error("Codebase migration record conflicts with shard"); }
        else insert.run(row.kind, row.id, row.version, this.stored(row), row.created_at, row.updated_at);
      }
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }

  list(kind: string, limit: number, predicate?: (value: JsonObject) => boolean): JsonObject[] {
    const values: JsonObject[] = [];
    for (const database of this.existing()) {
      const rows = database.prepare(`SELECT r.* FROM records r JOIN
        (SELECT id,MAX(version) version FROM records WHERE kind=? GROUP BY id) latest
        ON r.id=latest.id AND r.version=latest.version WHERE r.kind=? ORDER BY r.updated_at DESC ${predicate ? "" : "LIMIT ?"}`)
        .all(kind, kind, ...(predicate ? [] : [limit])) as GraphRow[];
      for (const row of rows) {
        const value = { ...this.payload(row), id: row.id, version: row.version,
          created_at: row.created_at, updated_at: row.updated_at };
        if (!predicate || predicate(value)) values.push(value);
      }
    }
    return values.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || String(b.id).localeCompare(String(a.id))).slice(0, limit);
  }

  count(kind: string): number {
    return this.existing().reduce((total, database) => total + Number((database.prepare(
      "SELECT COUNT(*) n FROM (SELECT id FROM records WHERE kind=? GROUP BY id)").get(kind) as { n: number }).n), 0);
  }

  close(): void { for (const database of this.#databases.values()) database.close(); this.#databases.clear(); }
}
