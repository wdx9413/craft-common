import assert from "node:assert/strict";
import test from "node:test";
import { CraftTelemetry, operationEventId, telemetryEvent, type TelemetryEvent, type TelemetrySink } from "../src/telemetry.ts";

const base = {
  signal: "trace" as const, capability_id: "cap", operation: "op", trace_id: "trace", span_id: "span", parent_span_id: null, outcome: "observed" as const,
};

test("telemetryEvent fills stable defaults and trims identity fields", () => {
  const event = telemetryEvent({ ...base, capability_id: " cap ", operation: " op ", trace_id: " trace ", span_id: " span ", event_id: " evt ", occurred_at: "2026-01-01T00:00:00.000Z", evidence_ids: [" e1 ", "e1"], attributes: { count: 1 } });
  assert.equal(event.schema, "craft.telemetry.v1");
  assert.equal(event.event_id, "evt");
  assert.equal(event.capability_id, "cap");
  assert.equal(event.operation, "op");
  assert.deepEqual(event.evidence_ids, ["e1"]);
  assert.deepEqual(event.attributes, { count: 1 });
  assert.equal(event.occurred_at, "2026-01-01T00:00:00.000Z");
  assert.equal(event.parent_span_id, null);
  assert.match(telemetryEvent(base).event_id, /^evt_/u);
});

test("telemetryEvent rejects unsupported signals, outcomes and identities", () => {
  assert.throws(() => telemetryEvent({ ...base, signal: "unknown" as never }), /signal is unsupported/u);
  assert.throws(() => telemetryEvent({ ...base, outcome: "unknown" as never }), /outcome is unsupported/u);
  for (const field of ["capability_id", "operation", "trace_id", "span_id"] as const) {
    assert.throws(() => telemetryEvent({ ...base, [field]: "" }), /must be a non-empty string/u);
  }
  assert.throws(() => telemetryEvent({ ...base, parent_span_id: "" }), /parent_span_id must be a non-empty string/u);
  assert.throws(() => telemetryEvent({ ...base, event_id: "x".repeat(257) }), /at most 256/u);
  assert.throws(() => telemetryEvent({ ...base, occurred_at: "yesterday" }), /ISO timestamp/u);
  assert.throws(() => telemetryEvent({ ...base, occurred_at: "2026-01-01T00:00:00.000+01:00" }), /ISO timestamp/u);
});

test("telemetry attributes enforce field, scalar, secret and metric bounds", () => {
  assert.throws(() => telemetryEvent({ ...base, attributes: [] as never }), /attributes must be an object/u);
  assert.throws(() => telemetryEvent({ ...base, attributes: { badKey: 1 } }), /not allowed: badKey/u);
  assert.throws(() => telemetryEvent({ ...base, attributes: { count: -1 } }), /finite and non-negative/u);
  assert.throws(() => telemetryEvent({ ...base, attributes: { count: Number.NaN } }), /finite and non-negative/u);
  assert.throws(() => telemetryEvent({ ...base, attributes: { name: "x".repeat(257) } }), /unsafe content/u);
  assert.throws(() => telemetryEvent({ ...base, attributes: { name: "api_key: abcdefgh" } }), /unsafe content/u);
  assert.throws(() => telemetryEvent({ ...base, attributes: { name: { nested: 1 } as never } }), /must be scalar/u);
  const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`field_${index}`, index]));
  assert.throws(() => telemetryEvent({ ...base, attributes: tooMany }), /32-field limit/u);
  assert.deepEqual(telemetryEvent({ ...base, attributes: { reason_code: "x", status: "ok", retryable: false, database_role: "primary" } }).attributes,
    { reason_code: "x", status: "ok", retryable: false, database_role: "primary" });
});

test("usage, metric and verified evaluation signals require evidence", () => {
  assert.throws(() => telemetryEvent({ ...base, evidence_ids: "x" as never }), /bounded array/u);
  assert.throws(() => telemetryEvent({ ...base, evidence_ids: Array.from({ length: 33 }, (_, index) => `e${index}`) }), /bounded array/u);
  assert.throws(() => telemetryEvent({ ...base, signal: "evaluation", outcome: "verified" }), /requires evidence_ids/u);
  assert.equal(telemetryEvent({ ...base, signal: "evaluation", outcome: "verified", evidence_ids: ["e"] }).evidence_ids[0], "e");
  assert.throws(() => telemetryEvent({ ...base, signal: "usage", attributes: {} }), /requires measured tokens or cost/u);
  assert.throws(() => telemetryEvent({ ...base, signal: "usage", attributes: { input_tokens: 1.5 } }), /input_tokens must be a non-negative integer/u);
  assert.throws(() => telemetryEvent({ ...base, signal: "usage", attributes: { output_tokens: -1 } }), /output_tokens must be a non-negative integer/u);
  assert.equal(telemetryEvent({ ...base, signal: "usage", attributes: { cost_usd: 0.1 } }).signal, "usage");
  assert.throws(() => telemetryEvent({ ...base, signal: "metric", attributes: { status: "ok" } }), /metric requires a numeric measurement/u);
  assert.throws(() => telemetryEvent({ ...base, signal: "metric" }), /metric requires a numeric measurement/u);
  assert.throws(() => telemetryEvent({ ...base, signal: "usage" }), /usage requires measured tokens or cost/u);
  assert.equal(telemetryEvent({ ...base, signal: "metric", attributes: { count: 0 } }).signal, "metric");
});

test("CraftTelemetry reports sink failures separately from business results", async () => {
  const events: TelemetryEvent[] = [];
  const sink: TelemetrySink = { append: (event) => { events.push(event); } };
  const telemetry = new CraftTelemetry(sink);
  const receipt = await telemetry.record(base);
  assert.equal(receipt.recorded, true);
  assert.equal(events.length, 1);
  const failed = new CraftTelemetry({ append: () => { throw new Error("disk"); } });
  const failure = await failed.record(base);
  assert.equal(failure.recorded, false);
  assert.equal(failure.error?.message, "disk");
  const stringFailure = new CraftTelemetry({ append: () => { throw "plain"; } });
  assert.equal((await stringFailure.record(base)).error?.message, "plain");
});

test("capture records observed and succeeded spans around async work", async () => {
  const events: TelemetryEvent[] = [];
  const telemetry = new CraftTelemetry({ append: (event) => { events.push(event); } });
  const result = await telemetry.capture({ capability_id: "cap", operation: "op", trace_id: "trace", parent_span_id: "parent", attributes: { status: "start" } }, async () => 42);
  assert.equal(result.result, 42);
  assert.deepEqual(result.telemetry.map(item => item.recorded), [true, true]);
  assert.deepEqual(events.map(event => event.outcome), ["observed", "succeeded"]);
  assert.equal(events[0]!.parent_span_id, "parent");
  assert.ok(typeof events[1]!.attributes.duration_ms === "number");
});

test("capture records failed spans and rethrows the original error", async () => {
  const events: TelemetryEvent[] = [];
  const telemetry = new CraftTelemetry({ append: (event) => { events.push(event); } });
  await assert.rejects(telemetry.capture({ capability_id: "cap", operation: "op", trace_id: "trace" }, async () => { throw new TypeError("bad"); }), /bad/u);
  assert.equal(events[1]!.outcome, "failed");
  assert.equal(events[1]!.attributes.reason_code, "TypeError");
  const stringThrow = new CraftTelemetry({ append: (event) => { events.push(event); } });
  await assert.rejects(stringThrow.capture({ capability_id: "cap", operation: "op", trace_id: "trace" }, async () => { throw "plain"; }), /plain/u);
  assert.equal(events[3]!.attributes.reason_code, "NonErrorThrow");
});

test("operationEventId is stable for retries and validates its parts", () => {
  const id = operationEventId("trace", "request", "started");
  assert.match(id, /^event_[a-f0-9]{32}$/u);
  assert.equal(id, operationEventId("trace", "request", "started"));
  assert.notEqual(id, operationEventId("trace", "request", "completed"));
  assert.throws(() => operationEventId("", "request", "started"), /trace_id must be a non-empty string/u);
  assert.throws(() => operationEventId("trace", " ", "started"), /request_id must be a non-empty string/u);
  assert.throws(() => operationEventId("trace", "request", ""), /phase must be a non-empty string/u);
});
