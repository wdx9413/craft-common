import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, digestJson, payload, stableDigest, stableDigestStreaming } from "../src/digest.ts";

test("digestJson distinguishes key order while stableDigest does not", () => {
  assert.match(digestJson({ a: 1, b: 2 }), /^sha256:[a-f0-9]{64}$/u);
  assert.notEqual(digestJson({ a: 1, b: 2 }), digestJson({ b: 2, a: 1 }));
  assert.equal(stableDigest({ a: 1, b: 2 }), stableDigest({ b: 2, a: 1 }));
  assert.equal(stableDigest({ a: 1, b: 2 }), stableDigestStreaming({ b: 2, a: 1 }));
  assert.equal(canonicalJson({ b: [1, 2], a: { d: null, c: true } }), '{"a":{"c":true,"d":null},"b":[1,2]}');
});

test("canonical serialization preserves historical nested undefined rendering", () => {
  assert.equal(canonicalJson([undefined, 1]), "[,1]");
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"a":undefined,"b":1}');
  assert.equal(canonicalJson({ a: () => 1, b: 1 }), '{"a":undefined,"b":1}');
  assert.equal(canonicalJson({ a: () => 1 }), '{"a":undefined}');
  assert.equal(canonicalJson({ a: undefined }), '{"a":undefined}');
  assert.equal(canonicalJson([undefined]), "[]");
  assert.match(stableDigestStreaming({ a: undefined, b: [undefined] }), /^sha256:[a-f0-9]{64}$/u);
  assert.throws(() => canonicalJson(undefined), /cannot serialize undefined/u);
  assert.throws(() => canonicalJson(() => 1), /cannot serialize function/u);
  assert.throws(() => stableDigestStreaming(undefined), /cannot serialize undefined/u);
  const shared = { deep: { value: 1 } };
  const left = { a: shared, b: shared };
  const right = { b: { deep: { value: 1 } }, a: { deep: { value: 1 } } };
  assert.equal(stableDigest(left), stableDigest(right));
});

test("streaming digest matches canonical bytes and flushes large values", () => {
  const large = { items: Array.from({ length: 2000 }, (_, index) => ({ index, text: `item-${index}` })) };
  assert.equal(stableDigestStreaming(large), stableDigest(large));
  assert.equal(canonicalJson(large), canonicalJson(JSON.parse(JSON.stringify(large))));
  const manyShapes: Record<string, number> = {};
  for (let index = 0; index < 300; index += 1) manyShapes[`key_${index}`] = index;
  assert.equal(stableDigest(manyShapes), stableDigest({ ...manyShapes }));
});

test("payload strips storage bookkeeping and legacy content beside a content_ref", () => {
  const stripped = payload({ id: "r1", version: 2, created_at: "t0", updated_at: "t1", status: "active" });
  assert.deepEqual(stripped, { status: "active" });
  assert.deepEqual(payload({ id: "r1", version: 1, content_ref: { path: "x" }, content: "stale" }), { content_ref: { path: "x" } });
  assert.deepEqual(payload({ id: "r1", version: 1, content: "inline" }), { content: "inline" });
});
