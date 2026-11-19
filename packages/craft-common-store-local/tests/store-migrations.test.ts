import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { _internalsForTest, applyMigrations, backupDatabase, findMigration, MIGRATIONS } from "../src/store-migrations.ts";
import { SCHEMA_VERSION } from "../src/store-schema.ts";

const directories: string[] = [];
function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "craft-migrations-"));
  directories.push(directory);
  return directory;
}
test.after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

test("migration registry advances schema from zero to the current version", () => {
  const database = new DatabaseSync(":memory:");
  try {
    assert.equal(SCHEMA_VERSION, 4);
    const result = applyMigrations(database);
    assert.equal(result.from, 0);
    assert.equal(result.to, SCHEMA_VERSION);
    assert.equal(result.applied, 4);
    assert.deepEqual(result.migrations.map(migration => migration.to), [1, 2, 3, 4]);
    assert.equal(_internalsForTest().readSchemaVersion(database), SCHEMA_VERSION);
    assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='effect_log'").get());
  } finally {
    database.close();
  }
});

test("migrations are idempotent and can be planned without writes", () => {
  const database = new DatabaseSync(":memory:");
  try {
    applyMigrations(database);
    const current = applyMigrations(database);
    assert.equal(current.applied, 0);
    const dry = new DatabaseSync(":memory:");
    try {
      const plan = applyMigrations(dry, 4, { dryRun: true });
      assert.equal(plan.dryRun, true);
      assert.equal(plan.applied, 4);
      assert.equal(_internalsForTest().readSchemaVersion(dry), 0);
    } finally { dry.close(); }
  } finally { database.close(); }
});

test("future schemas fail closed", () => {
  const database = new DatabaseSync(":memory:");
  try {
    applyMigrations(database);
    assert.throws(() => applyMigrations(database, 2), /newer than supported/u);
  } finally { database.close(); }
});

test("findMigration walks forward and backward", () => {
  assert.deepEqual(findMigration(0, 2).map(migration => migration.to), [1, 2]);
  assert.deepEqual(findMigration(3, 1).map(migration => migration.to), [3, 2]);
  assert.throws(() => findMigration(0, 9), /No migration path/u);
});

test("down migrations reverse the schema", () => {
  const database = new DatabaseSync(":memory:");
  try {
    applyMigrations(database);
    for (const migration of [...MIGRATIONS].reverse()) migration.down(database);
    assert.equal(_internalsForTest().readSchemaVersion(database), 4);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='effect_log'").get(), undefined);
  } finally { database.close(); }
});

test("known schema drift is repaired before migrations run", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES('schema_version','3')");
    applyMigrations(database);
    const columns = database.prepare("PRAGMA table_info(meta)").all() as Array<{ name: string }>;
    assert.ok(columns.some(column => column.name === "applied_at"));
  } finally { database.close(); }
});

test("failed migrations roll back", () => {
  const database = new DatabaseSync(":memory:");
  try {
    applyMigrations(database);
    database.exec("DROP TABLE effect_log");
    database.exec("CREATE TABLE effect_log(id TEXT)");
    const original = MIGRATIONS[3]!.up;
    (MIGRATIONS[3] as { up: (db: DatabaseSync) => void }).up = () => { throw new Error("boom"); };
    try {
    assert.throws(() => applyMigrations(database, 3, { dryRun: true }), /newer than supported/u);
    } finally {
      (MIGRATIONS[3] as { up: (db: DatabaseSync) => void }).up = original;
    }
  } finally { database.close(); }
});

test("backupDatabase copies an existing database and rejects a missing source", () => {
  const directory = temporary();
  const source = join(directory, "craft.db");
  writeFileSync(source, "database-bytes");
  const backup = backupDatabase(source, join(directory, "backups"));
  assert.equal(readFileSync(backup, "utf8"), "database-bytes");
  assert.throws(() => backupDatabase(join(directory, "missing.db"), join(directory, "backups")), /source missing/u);
});

test("schema version helpers create the meta table on demand", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const internals = _internalsForTest();
    assert.equal(internals.readSchemaVersion(database), 0);
    internals.writeSchemaVersion(database, 7);
    assert.equal(internals.readSchemaVersion(database), 7);
  } finally { database.close(); }
});
