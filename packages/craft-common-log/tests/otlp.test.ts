import assert from "node:assert/strict";
import test from "node:test";
import { exportOtlp, standardizeTrace, toOtlpTrace, traceCorrelation, TRACE_SCHEMA, TRACE_SCHEMA_REVISION } from "../src/otlp.ts";

test("standardizeTrace normalizes legacy and current schemas", () => {
  const legacy = standardizeTrace({ schema: "craft.trace.v1", id: "trace", sequence: "2", event_type: "tool.call", status: "completed", trust: "verified",
    actor: "agent", input_refs: ["a"], output_refs: ["b"], data: { token: "secret", ok: 1 }, occurred_at: "2026-01-01T00:00:00.000Z", duration_ms: 12, operation_id: "op" });
  assert.equal(legacy.schema, TRACE_SCHEMA);
  assert.equal(legacy.schema_revision, TRACE_SCHEMA_REVISION);
  assert.equal(legacy.legacy_schema, "craft.trace.v1");
  assert.equal(legacy.event_kind, "tool.call");
  assert.equal(legacy.span_id, "trace:span:2");
  assert.equal(legacy.raw_content, false);
  assert.equal(legacy.parent_span_id, null);
  const current = standardizeTrace({ trace_id: "t", sequence: 0 });
  assert.equal(current.event_kind, "trace.observed");
  assert.equal(current.trust, "observed");
  assert.equal(current.actor, "craft");
  assert.equal(current.status, null);
  assert.deepEqual(current.input_refs, []);
  assert.deepEqual(current.output_refs, []);
});

test("standardizeTrace validates its fields", () => {
  assert.throws(() => standardizeTrace(null as never), /trace must be an object/u);
  assert.throws(() => standardizeTrace({}), /trace_id must not be empty/u);
  assert.throws(() => standardizeTrace({ trace_id: "t", sequence: -1 }), /non-negative integer/u);
  assert.throws(() => standardizeTrace({ trace_id: "t", sequence: 1.5 }), /non-negative integer/u);
  assert.throws(() => standardizeTrace({ trace_id: "t", status: "" }), /status must not be empty/u);
  assert.throws(() => standardizeTrace({ trace_id: "t", trust: "" }), /trust must not be empty/u);
  assert.throws(() => standardizeTrace({ trace_id: "t", actor: "" }), /actor must not be empty/u);
  assert.throws(() => standardizeTrace({ trace_id: "t", input_refs: [""] }), /input_refs must not be empty/u);
  assert.throws(() => standardizeTrace({ trace_id: "t", output_refs: [""] }), /output_refs must not be empty/u);
});

test("traceCorrelation carries only correlation metadata", () => {
  assert.deepEqual(traceCorrelation({ trace_id: "trace", sequence: 1, span_id: "span", task_id: "task", run_id: "run", operation_id: "op" }), {
    trace_id: "trace", span_id: "span", parent_span_id: null, schema: TRACE_SCHEMA, schema_revision: TRACE_SCHEMA_REVISION,
    baggage: { task_id: "task", run_id: "run", operation_id: "op" },
  });
  assert.deepEqual(traceCorrelation({ id: "trace" }).baggage, { task_id: null, run_id: null, operation_id: null });
});

test("toOtlpTrace emits stable OTLP spans with parent links and status codes", () => {
  const root = { trace_id: "a".repeat(32), sequence: 0, span_id: "root", event_kind: "model.request", status: "completed", occurred_at: "2026-01-01T00:00:00.000Z", duration_ms: 5 };
  const payload = toOtlpTrace(root, [
    root,
    { trace_id: "a".repeat(32), sequence: 1, span_id: "child", parent_span_id: "root", event_kind: "tool.call", status: "failed", occurred_at: "2026-01-01T00:00:01.000Z", duration_ms: 3 },
    { trace_id: "a".repeat(32), sequence: 2, span_id: "child", parent_span_id: "root", event_kind: "tool.call", status: "failed", occurred_at: "2026-01-01T00:00:02.000Z", duration_ms: 2 },
  ]);
  const spans = (payload.resourceSpans as Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>)[0]!.scopeSpans[0]!.spans;
  assert.equal(spans.length, 2);
  const rootSpan = spans.find(span => span.name === "model.request")!;
  assert.equal(rootSpan.kind, 2);
  assert.equal((rootSpan.status as { code: number }).code, 1);
  const child = spans.find(span => span.name === "tool.call")!;
  assert.equal(child.kind, 3);
  assert.equal((child.status as { code: number }).code, 2);
  assert.equal(child.parentSpanId, rootSpan.spanId);
  assert.ok(BigInt(String(child.endTimeUnixNano)) >= BigInt(String(child.startTimeUnixNano)));
  const reordered = toOtlpTrace({ trace_id: "c".repeat(32), span_id: "root", occurred_at: "2026-01-01T00:00:10.000Z" }, [
    { trace_id: "c".repeat(32), span_id: "root", occurred_at: "2026-01-01T00:00:10.000Z" },
    { trace_id: "c".repeat(32), span_id: "root", occurred_at: "2026-01-01T00:00:05.000Z" },
  ]);
  const reorderedSpans = (reordered.resourceSpans as Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>)[0]!.scopeSpans[0]!.spans;
  assert.equal(reorderedSpans.length, 1);
});

test("toOtlpTrace validates trace membership and timestamps", () => {
  assert.throws(() => toOtlpTrace({ trace_id: "t" }, [{ trace_id: "other" }]), /one trace/u);
  assert.throws(() => toOtlpTrace({ trace_id: "t", duration_ms: -1 }), /non-negative/u);
  assert.throws(() => toOtlpTrace({ trace_id: "t", occurred_at: "bad" }), /timestamp must be valid/u);
  const hashed = toOtlpTrace({ trace_id: "not-hex", event_kind: "trace.observed" });
  const span = (hashed.resourceSpans as Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>)[0]!.scopeSpans[0]!.spans[0]!;
  assert.match(String(span.traceId), /^[a-f0-9]{32}$/u);
});

test("toOtlpTrace links unknown parents deterministically and defaults event kinds", () => {
  const payload = toOtlpTrace({ trace_id: "b".repeat(32), span_id: "root", event_kind: "trace.observed" }, [
    { trace_id: "b".repeat(32), span_id: "root", event_kind: "trace.observed" },
    { trace_id: "b".repeat(32), span_id: "child", parent_span_id: "external", event_kind: "trace.observed" },
    { trace_id: "b".repeat(32), span_id: "hexchild", parent_span_id: "0123456789abcdef", event_kind: "trace.observed" },
  ]);
  const spans = (payload.resourceSpans as Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>)[0]!.scopeSpans[0]!.spans;
  assert.equal(spans.find(span => span.name === "trace.observed" && span.parentSpanId === undefined)?.kind, 1);
  assert.equal(spans.find(span => span.name === "trace.observed" && span.parentSpanId === "0123456789abcdef")?.kind, 1);
});

test("exportOtlp validates endpoints, posts JSON and inspects partial success", async () => {
  const requests: Array<{ url: string; init: { body: string } }> = [];
  const ok = await exportOtlp("https://example.test/v1/traces", { a: 1 }, async (url, init) => { requests.push({ url, init }); return { status: 200, body: '{"partialSuccess":null}' }; });
  assert.equal(ok.status, 200);
  assert.equal(ok.accepted, true);
  assert.equal(JSON.parse(requests[0]!.init.body).a, 1);
  assert.match(String(ok.response_digest), /^sha256:/u);
  await exportOtlp("http://example.test", {}, async () => ({ status: 202, body: "not json" }));
  await exportOtlp("http://example.test", {}, async () => ({ status: 200, body: "[]" }));
  await exportOtlp("http://example.test", {}, async () => ({ status: 200, body: '{"partialSuccess":[]}' }));
  await exportOtlp("http://example.test", {}, async () => ({ status: 200, body: '{"partialSuccess":{"rejectedSpans":0}}' }));
  await exportOtlp("http://example.test", {}, async () => ({ status: 200, body: '{"partialSuccess":{}}' }));
  await assert.rejects(exportOtlp("http://example.test", {}, async () => ({ status: 500, body: "" })), /HTTP 500/u);
  await assert.rejects(exportOtlp("http://example.test", {}, async () => ({ status: 200, body: '{"partialSuccess":{"rejectedSpans":2}}' })), /rejected 2 span/u);
  await assert.rejects(exportOtlp("http://example.test", {}, async () => ({ status: 200, body: '{"partialSuccess":{"rejectedSpans":-1}}' })), /rejectedSpans is invalid/u);
  await assert.rejects(exportOtlp("http://example.test", {}, async () => ({ status: 200, body: '{"partialSuccess":{"rejectedSpans":"x"}}' })), /rejectedSpans is invalid/u);
});

test("exportOtlp rejects unsafe or malformed endpoints", async () => {
  const fetch = async () => ({ status: 200, body: "{}" });
  await assert.rejects(exportOtlp("", {}, fetch), /endpoint must not be empty/u);
  await assert.rejects(exportOtlp("not a url", {}, fetch), /valid HTTP\(S\) URL/u);
  await assert.rejects(exportOtlp("ftp://example.test", {}, fetch), /without credentials or fragments/u);
  await assert.rejects(exportOtlp("https://user:pass@example.test", {}, fetch), /without credentials or fragments/u);
  await assert.rejects(exportOtlp("https://example.test/#fragment", {}, fetch), /without credentials or fragments/u);
});
