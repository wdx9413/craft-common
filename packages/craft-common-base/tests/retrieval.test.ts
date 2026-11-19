import assert from "node:assert/strict";
import test from "node:test";
import { Bm25Index } from "../src/bm25.ts";
import * as port from "../src/retrieval-port.ts";
import { retrievalTerms } from "../src/retrieval-terms.ts";
import type { RetrievalPort } from "../src/retrieval-contract.ts";

test("BM25 validates tuning parameters", () => {
  assert.equal(new Bm25Index().size, 0);
  assert.throws(() => new Bm25Index({ k1: 0 }), /k1 must be positive/u);
  assert.throws(() => new Bm25Index({ b: -0.1 }), /b must be between 0 and 1/u);
  assert.throws(() => new Bm25Index({ b: 1.1 }), /b must be between 0 and 1/u);
  assert.equal(new Bm25Index({ k1: 2, b: 0 }).size, 0);
  assert.equal(new Bm25Index({ k1: 2, b: 1 }).size, 0);
});

test("BM25 indexes documents and rejects duplicate ids", () => {
  const index = new Bm25Index();
  index.add("doc-1", "Crafts 支持 中文 检索");
  index.add("doc-2", "DRAFT DRAfTs drafts");
  index.add("doc-3", "unrelated");
  assert.equal(index.size, 3);
  assert.throws(() => index.add("doc-1", "again"), /already exists/u);
  assert.throws(() => index.add("", "again"), /id must not be empty/u);
  assert.throws(() => index.score("   "), /query must not be empty/u);
  assert.deepEqual(index.score("missing"), []);
  const scored = index.score("drafts 中文");
  assert.deepEqual(scored.map(item => item.id).sort(), ["doc-1", "doc-2"]);
  assert.ok(scored.every(item => item.score > 0 && item.exact_identifier === false));
  assert.deepEqual(index.score("nontoken").map(item => item.id), []);
});

test("BM25 identifier queries receive the exact-match boost", () => {
  const index = new Bm25Index();
  index.add("path", "src/index.ts");
  index.add("caliper", "caliper 1");
  index.add("other", "unrelated words");
  index.add("hex", "the a1b2c3d4e5f6 digest");
  assert.deepEqual(index.score("a1b2c3d4e5f6").map(item => [item.id, item.exact_identifier]), [["hex", true]]);
  const path = index.score("src/index.ts");
  assert.deepEqual(path.map(item => item.id), ["path"]);
});

test("BM25 ties break by document id deterministically", () => {
  const index = new Bm25Index();
  index.add("b", "same");
  index.add("a", "same");
  assert.deepEqual(index.score("same").map(item => item.id), ["a", "b"]);
  assert.equal(index.score("same")[0]!.exact_identifier, false);
  assert.deepEqual(index.score("same a2"), index.score("same"));
  const empty = new Bm25Index();
  assert.deepEqual(empty.score("same"), []);
});

test("keyword retrieval port skips blank bodies and returns execution metadata", async () => {
  const retrieval: RetrievalPort = new port.KeywordRetrievalPort();
  const result = await retrieval.search("craft", [{ id: "a", body: "craft craft" }, { id: "b", body: "   " }, { id: "c", body: "other" }]);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]!.id, "a");
  assert.equal(result.hits[0]!.reason, "keyword_bm25");
  assert.equal(result.execution.requested, "keyword");
  assert.equal(result.execution.used, "keyword");
  assert.equal(result.execution.provider, null);
  assert.equal(result.execution.cost_summary, null);
  assert.equal(result.execution.unavailable_reason, null);
  assert.ok(Number.isSafeInteger(result.execution.latency_ms));
  const blank = await retrieval.search("   ", [{ id: "a", body: "craft" }]);
  assert.deepEqual(blank.hits, []);
});

test("retrieval terms segment Chinese and deduplicate lowercase words", () => {
  assert.deepEqual(retrievalTerms("Craft CRAFT"), ["craft"]);
  assert.deepEqual(retrievalTerms("知识 检索 memory"), ["知识", "检索", "memory"]);
  assert.deepEqual(retrievalTerms("!!!"), []);
  assert.deepEqual(retrievalTerms("snake_case dash-name"), ["snake_case", "dash-name"]);
});
