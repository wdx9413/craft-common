import assert from "node:assert/strict";
import test from "node:test";
import { scopeAccess, scopeAllows, scopeEnvelope, scopeEnvelopeReceipt, scopeFromKey, sourceAllows, type ScopeAccess } from "../src/scope-policy.ts";

test("legacy envelopes derive purpose, retention and audience from applicability", () => {
  assert.deepEqual(scopeEnvelope(undefined, { kind: "task", id: "t" }), {
    applicability: { kind: "task", id: "t" }, custody: { kind: "task", id: "t" },
    audience: { mode: "scoped", principal_ids: [] }, purpose: "working_note", retention: "working", tenant_id: null,
  });
  assert.equal(scopeEnvelope(null, { kind: "user", id: "u" }).purpose, "preference");
  assert.equal(scopeEnvelope(null, { kind: "user", id: "u" }).retention, "long_term");
  assert.deepEqual(scopeEnvelope(null, { kind: "global", id: "global" }).audience, { mode: "public", principal_ids: [] });
  assert.equal(scopeEnvelope(null, { kind: "project", id: "p" }).purpose, "fact");
  assert.equal(scopeEnvelope(null, { kind: "session", id: "s" }).retention, "working");
  assert.equal(scopeEnvelope(null, { kind: "legacy", id: "x" }).purpose, "fact");
});

test("explicit envelopes validate their shape and normalize principals", () => {
  const envelope = scopeEnvelope({
    applicability: { kind: "project", id: "p" }, custody: { kind: "team", id: "core" },
    audience: { mode: "scoped", principal_ids: [" b ", "a"] }, purpose: "episode", retention: "archival", tenant_id: " t1 ",
  }, { kind: "project", id: "p" });
  assert.deepEqual(envelope, {
    applicability: { kind: "project", id: "p" }, custody: { kind: "team", id: "core" },
    audience: { mode: "scoped", principal_ids: ["a", "b"] }, purpose: "episode", retention: "archival", tenant_id: "t1",
  });
  const legacy = scopeEnvelope({ applicability: { kind: "legacy", id: "old" } }, { kind: "legacy", id: "old" });
  assert.deepEqual(legacy.custody, { kind: "legacy", id: "old" });
  assert.equal(scopeEnvelope({ applicability: { kind: "user", id: "u" }, audience: {} }, { kind: "user", id: "u" }).audience.mode, "scoped");
  assert.deepEqual(scopeEnvelope({ applicability: { kind: "global", id: "global" } }, { kind: "global", id: "global" }).audience, { mode: "public", principal_ids: [] });
  assert.equal(scopeEnvelope({ applicability: { kind: "project", id: "p" }, purpose: "episode" }, { kind: "project", id: "p" }).retention, "archival");
  assert.equal(scopeEnvelope({ applicability: { kind: "project", id: "p" }, purpose: "fact" }, { kind: "project", id: "p" }).retention, "long_term");
  assert.equal(scopeEnvelope({ applicability: { kind: "project", id: "p" }, audience: { mode: "private", principal_ids: ["a"] } }, { kind: "project", id: "p" }).audience.mode, "private");
});

test("invalid envelopes fail closed", () => {
  const at = { kind: "project", id: "p" } as const;
  assert.throws(() => scopeEnvelope([], at), /must be an object/u);
  assert.throws(() => scopeEnvelope({ applicability: { kind: "team", id: "x" } }, at), /must match record scope/u);
  assert.throws(() => scopeEnvelope({ applicability: at, purpose: "nonsense" }, at), /purpose is unsupported/u);
  assert.throws(() => scopeEnvelope({ applicability: at, purpose: "" }, at), /purpose must be a non-empty string/u);
  assert.throws(() => scopeEnvelope({ applicability: at, retention: "forever" }, at), /retention is unsupported/u);
  assert.throws(() => scopeEnvelope({ applicability: at, retention: 1 }, at), /retention must be a non-empty string/u);
  assert.throws(() => scopeEnvelope({ applicability: at, audience: [] }, at), /audience must be an object/u);
  assert.throws(() => scopeEnvelope({ applicability: at, audience: { mode: "friends" } }, at), /audience mode is unsupported/u);
  assert.throws(() => scopeEnvelope({ applicability: at, audience: { mode: "" } }, at), /audience mode must be a non-empty string/u);
  assert.throws(() => scopeEnvelope({ applicability: at, audience: { principal_ids: [""] } }, at), /principal_ids must be strings/u);
  assert.throws(() => scopeEnvelope({ applicability: at, audience: { principal_ids: ["a", "b"], mode: "private" } }, at), /exactly one audience principal/u);
  assert.throws(() => scopeEnvelope({ applicability: at, audience: { principal_ids: "x" } }, at), /principal_ids must be strings/u);
  assert.throws(() => scopeEnvelope({ applicability: at, tenant_id: 5 }, at), /tenant_id must be a non-empty string/u);
  assert.throws(() => scopeEnvelope({ applicability: { kind: "team", id: "x" } }, at), /must match record scope/u);
  assert.throws(() => scopeEnvelope({ applicability: at, custody: [] }, at), /scope must be an object/u);
  assert.throws(() => scopeEnvelope({ applicability: at, custody: {} }, at), /kind must be a non-empty string/u);
  assert.throws(() => scopeEnvelope({ applicability: at, custody: { kind: "unknown", id: "x" } }, at), /kind is unsupported/u);
  assert.throws(() => scopeEnvelope({ applicability: [] }, at), /scope must be an object/u);
});

test("scopeAllows enforces tenant, purpose and audience", () => {
  const base = scopeEnvelope({ applicability: { kind: "project", id: "p" }, tenant_id: "t", audience: { mode: "private", principal_ids: ["alice"] } }, { kind: "project", id: "p" });
  assert.equal(scopeAllows(base, { tenant_id: "t" }), false);
  assert.equal(scopeAllows(base, { tenant_id: "other" }), false);
  assert.equal(scopeAllows(base, { tenant_id: "t", purpose: "episode" }), false);
  assert.equal(scopeAllows(base, { tenant_id: "t", principal_id: "alice" }), true);
  assert.equal(scopeAllows(base, { tenant_id: "t", principal_ids: ["bob", "alice"] }), true);
  assert.equal(scopeAllows(base, { tenant_id: "t", principal_ids: ["bob"] }), false);
  const publicEnvelope = scopeEnvelope(null, { kind: "global", id: "global" });
  assert.equal(scopeAllows(publicEnvelope, {}), true);
  const unscoped = scopeEnvelope(null, { kind: "project", id: "p" });
  assert.equal(scopeAllows(unscoped, {}), true);
});

test("sourceAllows interprets strings, objects and malformed scopes", () => {
  const envelope = { applicability: { kind: "project", id: "p" }, audience: { mode: "scoped", principal_ids: [] }, purpose: "episode", retention: "archival", tenant_id: null };
  assert.equal(sourceAllows({}, {}), false);
  assert.equal(sourceAllows({ scope: null }, {}), false);
  assert.equal(sourceAllows({ scope: "project:p" }, {}), true);
  assert.equal(sourceAllows({ scope: "project:p" }, { purpose: "fact" }), true);
  assert.equal(sourceAllows({ scope: { kind: "project", id: "p" }, scope_envelope: envelope }, {}), true);
  assert.equal(sourceAllows({ scope: { kind: "team", id: "p" } }, {}), true);
  assert.equal(sourceAllows({ scope: "bad" }, {}), false);
  assert.equal(sourceAllows({ scope: "project:p", scope_envelope: [] }, {}), false);
});

test("scopeAccess validates host-attested identity", () => {
  assert.deepEqual(scopeAccess({}), { principal_id: undefined, principal_ids: [], tenant_id: undefined, purpose: undefined });
  assert.deepEqual(scopeAccess({ principal_id: " a ", principal_ids: ["b", " b "], tenant_id: "t", cognitive_purpose: "fact" }),
    { principal_id: "a", principal_ids: ["b"], tenant_id: "t", purpose: "fact" });
  assert.throws(() => scopeAccess({ principal_id: "" }), /principal_id must be a non-empty string/u);
  assert.throws(() => scopeAccess({ principal_ids: "alice" }), /principal_ids must be non-empty strings/u);
  assert.throws(() => scopeAccess({ principal_ids: [1] }), /principal_ids must be non-empty strings/u);
  assert.throws(() => scopeAccess({ cognitive_purpose: "unknown" }), /cognitive_purpose is unsupported/u);
  assert.throws(() => scopeAccess({ cognitive_purpose: " " }), /cognitive_purpose must be a non-empty string/u);
  assert.throws(() => scopeAccess({ tenant_id: "" }), /tenant_id must be a non-empty string/u);
});

test("receipts and legacy keys preserve the policy summary", () => {
  const envelope = scopeEnvelope({ applicability: { kind: "project", id: "p" }, custody: { kind: "team", id: "core" },
    audience: { mode: "scoped", principal_ids: ["a", "b"] }, purpose: "procedure", retention: "long_term", tenant_id: "t" }, { kind: "project", id: "p" });
  assert.deepEqual(scopeEnvelopeReceipt(envelope), {
    applicability: { kind: "project", id: "p" }, custody: { kind: "team", id: "core" },
    audience: { mode: "scoped", principal_count: 2 }, purpose: "procedure", retention: "long_term", tenant_bound: true,
  });
  assert.deepEqual(scopeFromKey("global"), { kind: "global", id: "global" });
  assert.deepEqual(scopeFromKey("project:a:b"), { kind: "project", id: "a:b" });
  assert.deepEqual(scopeFromKey("legacy:old"), { kind: "legacy", id: "old" });
  assert.throws(() => scopeFromKey("project:"), /kind:id/u);
  assert.throws(() => scopeFromKey(":x"), /kind:id/u);
});

test("ScopeAccess consumer objects stay usable", () => {
  const access: ScopeAccess = { principal_id: "a" };
  assert.equal(access.principal_id, "a");
});
