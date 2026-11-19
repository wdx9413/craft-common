import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentReference, contentTitle, MarkdownContentStore, validateContentBody } from "../src/content-store.ts";
import { craftPaths, ensureLayout } from "../src/paths.ts";

const directories: string[] = [];
async function store(): Promise<MarkdownContentStore> {
  const directory = mkdtempSync(join(tmpdir(), "craft-content-"));
  directories.push(directory);
  const paths = await ensureLayout(craftPaths(directory));
  return new MarkdownContentStore(paths);
}
test.after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

const input = {
  kind: "knowledge" as const, record_id: "claim-1", version: 1, scope: "project:p", status: "active",
  sensitivity: "internal", source_id: "source-1", body: "# Heading\n\nBody text.",
};

test("content bodies reject empty text and credentials", () => {
  assert.throws(() => validateContentBody(""), /must not be empty/u);
  assert.throws(() => validateContentBody("   "), /must not be empty/u);
  assert.throws(() => validateContentBody("api_key: {{SECRET_9x2mqbv4}}"), /credentials or secrets/u);
  validateContentBody("clean body");
});

test("content titles prefer the explicit title and reject secrets", () => {
  assert.equal(contentTitle("# Title\nbody"), "Title");
  assert.equal(contentTitle("body", "Explicit"), "Explicit");
  assert.equal(contentTitle("body", undefined, "fallback"), "body");
  assert.equal(contentTitle("", undefined, "fallback"), "fallback");
  assert.throws(() => contentTitle("body", "   "), /must not be empty/u);
  assert.throws(() => contentTitle("body", "token: {{SECRET_9x2mqbv4}}"), /credentials or secrets/u);
  assert.equal(contentTitle("a".repeat(200)).length, 120);
});

test("content references are recognised by shape", () => {
  const ref = { kind: "knowledge", record_id: "c", version: 1, path: "p", digest: "d", bytes: 1, format: "markdown", title: "t" };
  assert.equal(contentReference(ref), true);
  assert.equal(contentReference({ ...ref, kind: "other" }), false);
  assert.equal(contentReference({ ...ref, version: 1.5 }), false);
  assert.equal(contentReference(null), false);
  assert.equal(contentReference([]), false);
});

test("content store writes canonical documents and reads them back", async () => {
  const content = await store();
  const ref = content.writeSync(input);
  assert.equal(ref.record_id, "claim-1");
  assert.match(ref.path, /Heading--[a-f0-9]{12}\.v1\.md$/u);
  assert.match(ref.digest, /^sha256:[a-f0-9]{64}$/u);
  const read = content.readSync(ref);
  assert.equal(read.body, input.body);
  assert.equal(read.manifest.record_id, "claim-1");
  assert.equal(read.manifest.record_kind, "knowledge");
  assert.equal(read.manifest.scope, "project:p");
  assert.equal(await content.verify(ref).then((result) => result.status), "verified");
  const again = content.writeSync(input);
  assert.equal(again.path, ref.path);
  assert.throws(() => content.writeSync({ ...input, body: "# Heading\n\nDifferent." }), /already exists with different body/u);
  const corrupted = readFileSync(ref.path, "utf8").replace('record_id: "claim-1"', 'record_id: "other"');
  writeFileSync(ref.path, corrupted);
  assert.throws(() => content.writeSync(input), /identity conflict/u);
  writeFileSync(ref.path, readFileSync(ref.path, "utf8").replace('record_id: "other"', 'record_id: "claim-1"').replace('scope: "project:p"', 'scope: "project:other"'));
  assert.throws(() => content.writeSync(input), /scope conflict/u);
});

test("content store validates version and body before writing", async () => {
  const content = await store();
  assert.throws(() => content.writeSync({ ...input, version: 0 }), /positive integer/u);
  assert.throws(() => content.writeSync({ ...input, body: "" }), /must not be empty/u);
  assert.throws(() => content.writeSync({ ...input, record_id: "bad/id" }), /unsafe identifier/u);
  assert.throws(() => content.writeSync({ ...input, frontmatter: { "Bad Key": 1 } }), /invalid or reserved/u);
  assert.throws(() => content.writeSync({ ...input, frontmatter: { record_id: "x" } }), /invalid or reserved/u);
  assert.throws(() => content.writeSync({ ...input, frontmatter: { note: "token: {{SECRET_9x2mqbv4}}" } }), /credentials or secrets/u);
  const withFrontmatter = content.writeSync({ ...input, record_id: "claim-2", frontmatter: { note: "value" } });
  assert.equal(content.readSync(withFrontmatter).manifest.note, "value");
});

test("content store rejects unsafe references and reports drift", async () => {
  const content = await store();
  const ref = content.writeSync(input);
  assert.throws(() => content.readSync({ ...ref, path: join(content.paths.root, "elsewhere.md") }), /outside the canonical directory/u);
  const drifted = content.verifySync({ ...ref, digest: `sha256:${"0".repeat(64)}` });
  assert.equal(drifted.status, "drifted");
  assert.equal(drifted.digest, null);
  const missing = content.verifySync({ ...ref, path: join(content.paths.root, "missing.md") });
  assert.equal(["missing", "drifted"].includes(missing.status), true);
  assert.throws(() => content.readSync({ ...ref, record_id: "other" }), /outside the canonical directory|metadata drifted/u);
  assert.throws(() => content.readSync({ ...ref, version: 2 }), /outside the canonical directory|metadata drifted/u);
});

test("content store rewrites a body in place for migrations", async () => {
  const content = await store();
  const ref = content.writeSync(input);
  const rewritten = content.rewriteSync({ ...input, body: "# Heading\n\nRewritten body." });
  assert.equal(rewritten.path, ref.path);
  assert.equal(content.readSync(rewritten).body, "# Heading\n\nRewritten body.");
  assert.throws(() => content.rewriteSync({ ...input, body: "x", record_id: "other" }), /ENOENT|identity conflict/u);
  assert.throws(() => content.rewriteSync({ ...input, body: "x", scope: "project:other" }), /scope conflict/u);
  assert.throws(() => content.rewriteSync({ ...input, body: "x", version: 2 }), /ENOENT|identity conflict/u);
  assert.throws(() => content.rewriteSync({ ...input, body: "x", version: 0 }), /positive integer/u);
});

test("content store relocates immutable content between scopes", async () => {
  const content = await store();
  const ref = content.writeSync(input);
  const sameScope = content.relocateSync({ ...ref, scope: "project:p" }, "project:p");
  assert.equal(sameScope.path, ref.path);
  assert.equal(content.readSync(sameScope).manifest.scope, "project:p");
  assert.throws(() => content.relocateSync(ref, "project:r"), /scope drifted/u);
});

test("content store supports experience folders and project resolvers", async () => {
  const content = await store();
  const experience = content.writeSync({ ...input, kind: "experience", record_id: "procedure-1", folder: "workflows" });
  assert.match(experience.path, /workflows/u);
  assert.throws(() => content.writeSync({ ...input, kind: "knowledge", folder: "workflows" }), /Only Experience content supports folders/u);
  assert.throws(() => content.writeSync({ ...input, kind: "experience", record_id: "procedure-2", folder: "unknown" as never }), /folder is unsupported/u);
  content.setProjectKnowledgeDirectoryResolver(() => null);
  content.setProjectExperienceDirectoryResolver(() => null);
  content.setProjectMemoryDirectoryResolver(() => null);
  assert.throws(() => content.writeSync({ ...input, kind: "knowledge", record_id: "claim-3" }), /no registered project root/u);
  const directory = join(content.paths.root, "project-knowledge");
  content.setProjectKnowledgeDirectoryResolver(() => directory);
  const project = content.writeSync({ ...input, record_id: "claim-4" });
  assert.match(project.path, /project-knowledge/u);
  assert.equal(content.isCanonicalRef(project), true);
});

test("content store parses and rejects malformed frontmatter", async () => {
  const content = await store();
  const ref = content.writeSync(input);
  const malformed = join(content.paths.root, "malformed.md");
  writeFileSync(malformed, "no frontmatter");
  assert.throws(() => content.readUncheckedSync(malformed), /frontmatter is missing/u);
  writeFileSync(malformed, "---\nnot closed\n");
  assert.throws(() => content.readUncheckedSync(malformed), /frontmatter is not closed/u);
  writeFileSync(malformed, "---\ninvalid line\n---\nbody");
  assert.throws(() => content.readUncheckedSync(malformed), /frontmatter is invalid/u);
  writeFileSync(malformed, `---\nschema_version: "craft.content.v1"\n---\nbody`);
  assert.throws(() => content.readUncheckedSync(malformed), /frontmatter is incomplete/u);
  const unsafe = join(content.paths.root, "unsafe.md");
  writeFileSync(unsafe, `---\nschema_version: "craft.content.v1"\nrecord_kind: "knowledge"\nrecord_id: "x"\nrecord_version: 1\nscope: "s"\nstatus: "a"\nsensitivity: "b"\nsource_id: "c"\nbody_digest: "d"\nupdated_at: "e"\nBad-Key: "v"\n---\nbody`);
  assert.throws(() => content.readUncheckedSync(unsafe), /unsafe metadata/u);
  assert.ok(readFileSync(ref.path, "utf8").startsWith("---\n"));
});

test("content store exposes legacy and named paths", async () => {
  const content = await store();
  assert.match(content.legacyPathFor("knowledge", "claim-1", 1), /content[/\\]knowledge[/\\]md[/\\]claim-1\.v1\.md/u);
  assert.match(content.pathFor("knowledge", "claim-1", 1), /claim-1\.v1\.md/u);
  assert.match(content.namedPathFor("knowledge", "claim-1", 1, "My Title"), /My-Title--[a-f0-9]{12}\.v1\.md/u);
  assert.throws(() => content.namedPathFor("knowledge", "bad/id", 1, "Title"), /unsafe identifier/u);
});
