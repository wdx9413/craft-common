import assert from "node:assert/strict";
import test from "node:test";
import { temporalMemorySelect } from "../src/memory-temporal-policy.ts";

const now = new Date("2026-01-10T00:00:00.000Z");
const active = (id: string, extra: Record<string, unknown> = {}) => ({ id, status: "active", topic: "topic", content_digest: "d", version: 1, ...extra });

test("temporal selection rejects invalid timestamps", () => {
  assert.throws(() => temporalMemorySelect([], new Date(Number.NaN), false), /valid timestamp/u);
});

test("temporal selection excludes non-current, invalid and future records", () => {
  const result = temporalMemorySelect([
    active("current"),
    active("archived", { status: "archived", topic: "archived" }),
    { id: "stale", status: "expired", topic: "stale-topic" },
    active("bad-until", { topic: "bad-until-topic", valid_until: "not-a-date" }),
    active("expired", { topic: "expired-topic", valid_until: "2025-01-01T00:00:00.000Z" }),
    active("bad-effective", { topic: "bad", effective_from: 3 }),
    active("future", { topic: "future", effective_from: "2027-01-01T00:00:00.000Z" }),
    { ...active("expired-ok", { topic: "ok-topic", valid_until: "2025-01-01T00:00:00.000Z" }), status: "expired" },
  ], now, false);
  assert.deepEqual(result.selected.map(item => item.id).sort(), ["current"]);
  assert.deepEqual(result.excluded, [
    { memory_id: "archived", reason: "not_current" },
    { memory_id: "stale", reason: "not_current" },
    { memory_id: "bad-until", reason: "invalid_valid_until" },
    { memory_id: "expired", reason: "expired" },
    { memory_id: "bad-effective", reason: "invalid_effective_from" },
    { memory_id: "future", reason: "not_yet_effective" },
    { memory_id: "expired-ok", reason: "not_current" },
  ]);
});

test("temporal selection keeps only the latest record per topic and abstains on conflicts", () => {
  const older = active("older", { effective_from: "2026-01-01T00:00:00.000Z", version: 1 });
  const newer = active("newer", { effective_from: "2026-01-02T00:00:00.000Z", version: 1 });
  const tie = active("tie", { effective_from: "2026-01-02T00:00:00.000Z", version: 2 });
  const result = temporalMemorySelect([older, newer, tie], now, false);
  assert.deepEqual(result.selected.map(item => item.id), ["tie"]);
  const history = temporalMemorySelect([older, newer], now, true);
  assert.deepEqual(history.selected.map(item => item.id), ["newer", "older"]);
  const noDates = temporalMemorySelect([active("one", { version: 1 }), active("two", { version: 2 })], now, false);
  assert.deepEqual(noDates.selected.map(item => item.id), ["two"]);
  const conflict = temporalMemorySelect([active("x", { content_digest: "first" }), active("y", { content_digest: "second" })], now, false);
  assert.deepEqual(conflict.selected, []);
  assert.deepEqual(conflict.excluded, [
    { memory_id: "x", topic: "topic", reason: "temporal_conflict_abstain" },
    { memory_id: "y", topic: "topic", reason: "temporal_conflict_abstain" },
  ]);
  const perEntry = temporalMemorySelect([{ id: "e1", status: "active" }, { id: "e2", status: "active" }], now, false);
  assert.deepEqual(perEntry.selected.map(item => item.id).sort(), ["e1", "e2"]);
  const staleOptIn = temporalMemorySelect([active("active"), { id: "expired", status: "expired", topic: "expired" }], now, false, true);
  assert.deepEqual(staleOptIn.selected.map(item => item.id).sort(), ["active", "expired"]);
});
