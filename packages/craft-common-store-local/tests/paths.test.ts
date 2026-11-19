import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  atomicPrivateJson, canonicalCandidatePath, craftPaths, dataRoot, ensureLayout, ensureProjectStorageDirectory,
  ensureSessionStorageDirectory, ensureSessionStorageDirectoryForScopeId, existingProjectStorageDirectory, isLegacySafeSessionId,
  parseSessionStorageScopeId, projectStorageDirectory, projectStorageIdentity, sessionStorageDirectory, sessionStorageDirectoryForScopeId,
  sessionStorageScopeId,
} from "../src/paths.ts";

const directories: string[] = [];
function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "craft-paths-"));
  directories.push(directory);
  return directory;
}
test.after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

test("dataRoot prefers CRAFT_DATA_DIR and resolves relative values", () => {
  const directory = temporary();
  assert.equal(dataRoot({ CRAFT_DATA_DIR: directory }), directory);
  assert.equal(dataRoot({ CRAFT_DATA_DIR: "  " }).endsWith(".craft_data"), true);
  const root = join(directory, "data");
  assert.equal(dataRoot({ CRAFT_DATA_DIR: root }), root);
});

test("dataRoot reads dataRoot from a settings file and ignores malformed settings", () => {
  const directory = temporary();
  const settings = join(directory, "settings.json");
  writeFileSync(settings, `\uFEFF${JSON.stringify({ dataRoot: join(directory, "custom") })}`);
  assert.equal(dataRoot({ CRAFT_SETTINGS_FILE: settings }), join(directory, "custom"));
  writeFileSync(settings, JSON.stringify({ dataRoot: "  " }));
  assert.equal(dataRoot({ CRAFT_SETTINGS_FILE: settings }).endsWith(".craft_data"), true);
  writeFileSync(settings, JSON.stringify([]));
  assert.equal(dataRoot({ CRAFT_SETTINGS_FILE: settings }).endsWith(".craft_data"), true);
  writeFileSync(settings, "{not json");
  assert.equal(dataRoot({ CRAFT_SETTINGS_FILE: settings }).endsWith(".craft_data"), true);
  assert.equal(dataRoot({ CRAFT_SETTINGS_FILE: join(directory, "missing.json") }).endsWith(".craft_data"), true);
});

test("craftPaths derives every documented location from one root", () => {
  const paths = craftPaths("/data");
  assert.equal(paths.root, join(process.cwd().slice(0, 2), "data"));
  assert.equal(paths.configFile, join(paths.root, "config", "config.json"));
  assert.equal(paths.settingsFile, join(paths.root, "settings.json"));
  assert.equal(paths.databaseFile, join(paths.root, "db", "craft.db"));
  assert.equal(paths.legacyDatabaseFile, join(paths.root, "craft.db"));
  assert.equal(paths.knowledgeIndex, paths.knowledgeDatabaseFile);
  assert.equal(paths.experienceProcedureDir, join(paths.root, "experience", "procedures"));
  assert.equal(paths.knowledgeContentDir, join(paths.root, "knowledge", "md"));
});

test("project storage identity follows the canonical directory", () => {
  const directory = temporary();
  const project = join(directory, "My Project!");
  mkdirSync(project);
  const identity = projectStorageIdentity(project);
  assert.equal(identity.canonical_root, project);
  assert.match(identity.path_sha256, /^[a-f0-9]{64}$/u);
  assert.match(identity.directory_name, /^My-Project--[a-f0-9]{64}$/u);
  const paths = craftPaths(directory);
  assert.equal(projectStorageDirectory(paths, project), join(directory, "projects", identity.directory_name));
  assert.throws(() => projectStorageIdentity(join(directory, "missing")), /ENOENT/u);
});

test("session storage scope IDs are hashed and parsed deterministically", () => {
  assert.match(sessionStorageScopeId("craft-mcp", "session-1"), /^craft-mcp--[a-f0-9]{64}$/u);
  const scopeId = sessionStorageScopeId("craft-mcp", "session-1");
  assert.equal(sessionStorageScopeId("craft-mcp", scopeId), scopeId);
  assert.throws(() => sessionStorageScopeId("craft-mcp", scopeId.replace("craft-mcp", "other-host")), /Host does not match/u);
  assert.throws(() => sessionStorageScopeId("BAD HOST", "session"), /host is invalid/u);
  assert.throws(() => sessionStorageScopeId("craft-mcp", ""), /non-empty identifier/u);
  assert.throws(() => sessionStorageScopeId("craft-mcp", "x".repeat(65_537)), /under 65536/u);
  assert.deepEqual(parseSessionStorageScopeId(scopeId), { host: "craft-mcp", digest: scopeId.slice(-64) });
  assert.equal(parseSessionStorageScopeId("raw-session"), null);
  assert.equal(parseSessionStorageScopeId("bad--zz"), null);
});

test("session storage directories reject malformed scope IDs", () => {
  const paths = craftPaths(temporary());
  const scopeId = sessionStorageScopeId("craft-mcp", "s");
  assert.equal(sessionStorageDirectoryForScopeId(paths, scopeId), join(paths.root, "sessions", scopeId));
  assert.throws(() => sessionStorageDirectoryForScopeId(paths, "raw"), /malformed/u);
  assert.equal(sessionStorageDirectory(paths, "craft-mcp", "s"), join(paths.root, "sessions", scopeId));
});

test("legacy session IDs only accept safe path segments", () => {
  assert.equal(isLegacySafeSessionId("session-1"), true);
  assert.equal(isLegacySafeSessionId(""), false);
  assert.equal(isLegacySafeSessionId(" leading"), false);
  assert.equal(isLegacySafeSessionId("trailing "), false);
  assert.equal(isLegacySafeSessionId("."), false);
  assert.equal(isLegacySafeSessionId(".."), false);
  assert.equal(isLegacySafeSessionId("a/b"), false);
  assert.equal(isLegacySafeSessionId("a\\b"), false);
  assert.equal(isLegacySafeSessionId("a\u0000b"), false);
  assert.equal(isLegacySafeSessionId("a".repeat(256)), false);
});

test("ensureLayout creates every directory", async () => {
  const paths = await ensureLayout(craftPaths(temporary()));
  for (const directory of [paths.configDir, paths.databaseDir, paths.indexDir, paths.logsDir, paths.cacheDir, paths.backupsDir,
    paths.runtimeDir, paths.artifactsDir, paths.knowledgeDir, paths.memoryDir, paths.sessionsDir, paths.experienceDir,
    paths.knowledgeContentDir, paths.memoryContentDir, paths.experienceContentDir, paths.experienceProcedureDir]) {
    assert.equal(statSync(directory).isDirectory(), true);
  }
});

test("ensureSessionStorageDirectory creates the scoped directory", () => {
  const paths = craftPaths(temporary());
  const directory = ensureSessionStorageDirectory(paths, "craft-mcp", "session-1");
  assert.equal(directory, sessionStorageDirectory(paths, "craft-mcp", "session-1"));
  assert.equal(statSync(directory).isDirectory(), true);
  assert.equal(ensureSessionStorageDirectoryForScopeId(paths, sessionStorageScopeId("craft-mcp", "session-1")), directory);
});

test("ensureSessionStorageDirectory rejects an unsafe data root", () => {
  const root = temporary();
  const paths = craftPaths(join(root, "data"));
  writeFileSync(paths.root, "not a directory");
  assert.throws(() => ensureSessionStorageDirectory(paths, "craft-mcp", "session-1"), /regular directory/u);
});

test("project storage directories are created and verified", () => {
  const root = temporary();
  const paths = craftPaths(join(root, "data"));
  mkdirSync(paths.root);
  const project = join(root, "project");
  mkdirSync(project);
  assert.equal(existingProjectStorageDirectory(paths, project), null);
  const directory = ensureProjectStorageDirectory(paths, project);
  assert.equal(existingProjectStorageDirectory(paths, project), directory);
  const mapping = readFileSync(join(directory, "project.json"), "utf8");
  assert.equal(JSON.parse(mapping).canonical_root, project);
});

test("project storage rejects mappings that do not match the canonical root", () => {
  const root = temporary();
  const paths = craftPaths(join(root, "data"));
  mkdirSync(paths.root);
  const project = join(root, "project");
  mkdirSync(project);
  const directory = ensureProjectStorageDirectory(paths, project);
  writeFileSync(join(directory, "project.json"), JSON.stringify({ schema_version: 1 }));
  assert.throws(() => existingProjectStorageDirectory(paths, project), /does not match/u);
});

test("existing project storage stops at a missing intermediate directory", () => {
  const root = temporary();
  const paths = craftPaths(join(root, "data"));
  mkdirSync(paths.root);
  const project = join(root, "project");
  mkdirSync(project);
  assert.equal(existingProjectStorageDirectory(paths, project), null);
});

test("canonicalCandidatePath resolves existing prefixes and preserves missing suffixes", () => {
  const root = temporary();
  const existing = join(root, "existing");
  mkdirSync(existing);
  assert.equal(canonicalCandidatePath(join(existing, "missing", "file")), join(existing, "missing", "file"));
  assert.equal(canonicalCandidatePath(root), root);
});

test("atomicPrivateJson writes owner-only JSON and replaces the target", async () => {
  const root = temporary();
  const path = join(root, "nested", "secrets.json");
  await atomicPrivateJson(path, { a: 1 });
  assert.equal(readFileSync(path, "utf8"), '{\n  "a": 1\n}\n');
  await atomicPrivateJson(path, { b: 2 });
  assert.equal(readFileSync(path, "utf8"), '{\n  "b": 2\n}\n');
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
});
