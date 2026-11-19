import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StoreTelemetrySink } from "../src/store-sink.ts";
import { telemetryEvent } from "../src/telemetry.ts";
import { CraftStore } from "craft-common-store-local/store";
import { craftPaths } from "craft-common-store-local/paths";

const stores: CraftStore[] = [];
const directories: string[] = [];
async function store(): Promise<CraftStore> {
  const directory = mkdtempSync(join(tmpdir(), "craft-sink-"));
  directories.push(directory);
  const opened = await new CraftStore(craftPaths(directory)).open();
  stores.push(opened);
  return opened;
}
test.after(() => {
  for (const opened of stores) opened.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});
const event = telemetryEvent({ signal: "trace", capability_id: "cap", operation: "op", trace_id: "trace", span_id: "span", parent_span_id: null, outcome: "observed", event_id: "evt", occurred_at: "2026-01-01T00:00:00.000Z" });

test("store sink appends once and rejects conflicting retries", async () => {
  const sink = new StoreTelemetrySink(await store());
  sink.append(event);
  sink.append(event);
  assert.equal(sink.list("trace").length, 1);
  assert.throws(() => sink.append({ ...event, outcome: "failed" }), /idempotency conflict/u);
});

test("store sink bounds trace queries", async () => {
  const sink = new StoreTelemetrySink(await store());
  assert.throws(() => sink.list(""), /invalid telemetry query bounds/u);
  assert.throws(() => sink.list("trace", 0), /invalid telemetry query bounds/u);
  assert.throws(() => sink.list("trace", 1001), /invalid telemetry query bounds/u);
  assert.deepEqual(sink.list("trace"), []);
  sink.append(event);
  assert.equal(sink.list("trace", 1).length, 1);
});
