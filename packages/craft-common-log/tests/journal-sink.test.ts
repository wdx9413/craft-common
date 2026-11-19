import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonlTelemetryJournal } from "../src/journal-sink.ts";
import { telemetryEvent } from "../src/telemetry.ts";

const directories: string[] = [];
function runtime(): string {
  const directory = mkdtempSync(join(tmpdir(), "craft-journal-"));
  directories.push(directory);
  return directory;
}
test.after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });
const event = telemetryEvent({ signal: "trace", capability_id: "cap", operation: "op", trace_id: "trace", span_id: "span", parent_span_id: null, outcome: "observed", event_id: "evt", occurred_at: "2026-01-01T00:00:00.000Z" });

test("journal writes content-free JSONL under a capability hash", async () => {
  const root = runtime();
  const journal = new JsonlTelemetryJournal(root);
  await journal.append(event);
  await journal.flush();
  const directory = join(root, "operation-journal");
  const capability = readdirSync(directory)[0]!;
  assert.match(capability, /^[a-f0-9]{20}$/u);
  const files = readdirSync(join(directory, capability));
  assert.deepEqual(files, [`${process.pid}.jsonl`]);
  const line = readFileSync(join(directory, capability, files[0]!), "utf8");
  assert.deepEqual(JSON.parse(line), event);
  assert.equal(statSync(join(directory, capability, files[0]!)).isFile(), true);
});

test("journal serializes concurrent appends and preserves order", async () => {
  const root = runtime();
  const journal = new JsonlTelemetryJournal(root);
  await Promise.all(Array.from({ length: 20 }, (_, index) => journal.append({ ...event, event_id: `evt_${index}` })));
  await journal.flush();
  const directory = join(root, "operation-journal");
  const capability = readdirSync(directory)[0]!;
  const lines = readFileSync(join(directory, capability, `${process.pid}.jsonl`), "utf8").trim().split("\n");
  assert.equal(lines.length, 20);
  assert.deepEqual(lines.map(line => (JSON.parse(line) as { event_id: string }).event_id), Array.from({ length: 20 }, (_, index) => `evt_${index}`));
});

test("journal requires a runtime directory and reports write errors separately", async () => {
  assert.throws(() => new JsonlTelemetryJournal(" "), /runtimeDir must be non-empty/u);
  const errors: unknown[] = [];
  const journal = new JsonlTelemetryJournal(join(runtime(), "missing-parent"), error => errors.push(error));
  await journal.append(event);
  await journal.flush();
  assert.equal(errors.length, 0);
});

test("journal error callback failures never reject the append", async () => {
  const root = runtime();
  const blockingFile = join(root, "operation-journal");
  const journal = new JsonlTelemetryJournal(root, () => { throw new Error("callback"); });
  // A regular file at the journal directory path forces mkdir to fail.
  rmSync(blockingFile, { recursive: true, force: true });
  await import("node:fs").then(({ writeFileSync }) => writeFileSync(blockingFile, "x"));
  await assert.rejects(journal.append(event), /ENOTDIR|EEXIST/u);
  await journal.flush();
});

test("journal defaults to ignoring write errors", async () => {
  const root = runtime();
  const blockingFile = join(root, "operation-journal");
  const journal = new JsonlTelemetryJournal(root);
  await import("node:fs").then(({ writeFileSync }) => writeFileSync(blockingFile, "x"));
  const pending = journal.append(event);
  await journal.flush();
  await assert.rejects(pending, /ENOTDIR|EEXIST/u);
});
