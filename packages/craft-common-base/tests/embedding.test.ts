import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { OpenAiCompatibleEmbeddingRetrievalPort } from "../src/embedding-retrieval.ts";

const originalFetch = globalThis.fetch;
const directories: string[] = [];
let cacheSequence = 0;
function freshConfiguration(): Record<string, unknown> {
  cacheSequence += 1;
  return { endpoint: "http://x", model: `m${cacheSequence}`, credential_env: "CRAFT_TEST_EMBED_KEY" };
}
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "craft-embedding-"));
  directories.push(directory);
  return directory;
}
function restoreFetch(): void { globalThis.fetch = originalFetch; }
function respond(body: unknown, status = 200): void {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test.afterEach(() => { restoreFetch(); delete process.env.CRAFT_TEST_EMBED_KEY; });
test.after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

test("embedding port reports an unavailable provider without network access", async () => {
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("network"); };
  delete process.env.CRAFT_TEST_EMBED_KEY;
  const port = new OpenAiCompatibleEmbeddingRetrievalPort({ endpoint: "http://x/v1/embeddings", model: "m" });
  const result = await port.search("q", [{ id: "d", body: "body" }]);
  assert.equal(fetched, false);
  assert.deepEqual(result.hits, []);
  assert.equal(result.execution.provider, "openai-compatible");
  assert.equal(result.execution.unavailable_reason, "embedding_provider_unavailable");
  assert.equal(result.execution.model, "m");
  assert.equal(port.revision, "unversioned");
  assert.equal(new OpenAiCompatibleEmbeddingRetrievalPort({ model_revision: "abc" }).revision, "abc");
  const empty = await new OpenAiCompatibleEmbeddingRetrievalPort({}).search("q", []);
  assert.equal(empty.execution.provider, null);
  assert.equal(empty.execution.model, null);
  assert.equal(empty.execution.used, "keyword");
});

test("embedding port enforces the input budget", async () => {
  process.env.CRAFT_TEST_EMBED_KEY = "test-key";
  const port = new OpenAiCompatibleEmbeddingRetrievalPort({ endpoint: "http://x/v1/embeddings", model: "m", credential_env: "CRAFT_TEST_EMBED_KEY" });
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("network"); };
  const tooLong = await port.search("q", [{ id: "d", body: "x".repeat(32_001) }]);
  assert.equal(fetched, false);
  assert.equal(tooLong.execution.unavailable_reason, "embedding_input_budget_exceeded");
  const tooMany = await port.search("q", Array.from({ length: 10_001 }, (_, index) => ({ id: String(index), body: "" })));
  assert.equal(tooMany.execution.unavailable_reason, "embedding_input_budget_exceeded");
});

test("embedding port returns ranked cosine hits and caches vectors", async () => {
  process.env.CRAFT_TEST_EMBED_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    const payload = JSON.parse(String(init.body)) as { input: string[] };
    const data = payload.input.map((value, index) => ({ index, embedding: value.includes("alpha") ? [1, 0] : [0, 1] }));
    return new Response(JSON.stringify({ data, usage: { total_tokens: payload.input.length } }), { status: 200 });
  };
  const port = new OpenAiCompatibleEmbeddingRetrievalPort({ endpoint: "http://x/v1/embeddings", model: "m", credential_env: "CRAFT_TEST_EMBED_KEY" });
  const result = await port.search("alpha", [{ id: "b", body: "beta" }, { id: "a", body: "alpha" }]);
  assert.equal(calls, 1);
  assert.deepEqual(result.hits.map(hit => [hit.id, hit.reason]), [["a", "vector_cosine"]]);
  assert.equal(result.execution.used, "vector");
  assert.equal(result.execution.cost_summary?.billable_units, 2);
  assert.match(String(result.execution.cost_summary?.usage_digest), /^sha256:/u);
  const again = await port.search("alpha", [{ id: "a", body: "alpha" }]);
  assert.equal(calls, 1);
  assert.equal(again.hits[0]!.id, "a");
});

test("embedding port persists vectors in its SQLite cache", async () => {
  process.env.CRAFT_TEST_EMBED_KEY = "test-key";
  const cachePath = join(temporaryDirectory(), "embeddings.db");
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 1] }, { index: 1, embedding: [1, 0] }] }), { status: 200 });
  };
  const first = new OpenAiCompatibleEmbeddingRetrievalPort({ endpoint: "http://x", model: "m", credential_env: "CRAFT_TEST_EMBED_KEY" }, cachePath);
  assert.equal((await first.search("query", [{ id: "doc", body: "body" }])).hits.length, 1);
  assert.equal(calls, 1);
  const database = new DatabaseSync(cachePath);
  assert.equal(Number((database.prepare("SELECT COUNT(*) n FROM embeddings").get() as { n: number }).n), 2);
  database.close();
  calls = 0;
  const second = new OpenAiCompatibleEmbeddingRetrievalPort({ endpoint: "http://x", model: "m", credential_env: "CRAFT_TEST_EMBED_KEY" }, cachePath);
  const cached = await second.search("query", [{ id: "doc", body: "body" }]);
  assert.equal(calls, 0);
  assert.equal(cached.hits[0]!.id, "doc");
  assert.equal(cached.execution.cost_summary?.billable_units, 0);
  assert.equal(cached.execution.cost_summary?.usage_digest, null);
});

test("embedding port classifies provider failures", async () => {
  process.env.CRAFT_TEST_EMBED_KEY = "test-key";
  const port = new OpenAiCompatibleEmbeddingRetrievalPort(freshConfiguration());
  let probeIndex = 0;
  const probe = () => port.search("q", [{ id: "a", body: `probe-${probeIndex++}` }]);
  respond({ error: "down" }, 503);
  assert.equal((await probe()).execution.unavailable_reason, "http_503");
  respond({ data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [1, 0] }] });
  assert.equal((await probe()).execution.unavailable_reason, "invalid_embedding_response");
  respond({ data: [null, null] });
  assert.equal((await probe()).execution.unavailable_reason, "invalid_embedding_response");
  respond({ data: [] });
  assert.equal((await probe()).execution.unavailable_reason, "invalid_embedding_response");
  respond(null);
  assert.equal((await probe()).execution.unavailable_reason, "invalid_embedding_response");
  respond({ data: [0] });
  assert.equal((await probe()).execution.unavailable_reason, "invalid_embedding_response");
  respond({ data: [{ index: 0, embedding: [1] }] });
  assert.equal((await probe()).execution.unavailable_reason, "invalid_embedding_response");
  respond({ data: ["string-row", "string-row"] });
  assert.equal((await probe()).execution.unavailable_reason, "invalid_embedding_response");
  respond({ data: [[1, 0], [1, 0]] });
  assert.equal((await probe()).execution.unavailable_reason, "invalid_embedding_response");
  respond({ data: [{ embedding: [1, 0] }, { index: "x", embedding: [1, 0] }] });
  assert.equal((await probe()).execution.unavailable_reason, "invalid_embedding_response");
  respond({ data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [1, 0] }] });
  assert.equal((await probe()).execution.unavailable_reason, "invalid_embedding_response");
  respond({ data: [{ index: 5, embedding: [1] }, { index: 0, embedding: [1] }], usage: { total_tokens: 2 } });
  assert.equal((await probe()).execution.unavailable_reason, "invalid_embedding_response");
  respond({ data: [{ index: 1, embedding: [1] }], usage: { total_tokens: 2 } });
  assert.equal((await probe()).execution.unavailable_reason, "invalid_embedding_response");
  respond({ data: [{ index: 0, embedding: [] }, { index: 1, embedding: [1, 0] }] });
  assert.equal((await probe()).execution.unavailable_reason, "invalid_embedding_response");
  respond({ data: [{ index: 0, embedding: [1, 2, 3] }, { index: 1, embedding: [1, 0] }] });
  assert.equal((await probe()).execution.unavailable_reason, "invalid_embedding_response");
  respond({ data: [{ index: 0, embedding: [1, "x"] }, { index: 1, embedding: [1, 0] }] });
  assert.equal((await probe()).execution.unavailable_reason, "invalid_embedding_response");
  respond({ data: [{ index: 0, embedding: [1, Number.NaN] }, { index: 1, embedding: [1, 0] }] });
  assert.equal((await probe()).execution.unavailable_reason, "invalid_embedding_response");
  respond({ data: [{ index: 0, embedding: Array.from({ length: 8193 }, () => 1) }, { index: 1, embedding: [1, 0] }] });
  assert.equal((await probe()).execution.unavailable_reason, "invalid_embedding_response");
  respond({ data: [{ index: 0, embedding: [1e308, 1e308] }, { index: 1, embedding: [1, 0] }] });
  assert.equal((await probe()).execution.unavailable_reason, "invalid_embedding_response");
  respond({ data: [{ index: 0, embedding: [0, 0] }, { index: 1, embedding: [0, 0] }] });
  const zero = await probe();
  assert.deepEqual(zero.hits, []);
  assert.equal(zero.execution.unavailable_reason, null);
  let secondResponse = false;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body)) as { input: string[] };
    if (secondResponse) return new Response(JSON.stringify({ data: payload.input.map((_input, index) => ({ index, embedding: [1, 0] })), usage: { total_tokens: 1 } }), { status: 200 });
    secondResponse = true;
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [1, 0, 0] }], usage: { total_tokens: 1, batches: 1 } }), { status: 200 });
  };
  const failover = new OpenAiCompatibleEmbeddingRetrievalPort(freshConfiguration());
  assert.equal((await failover.search("q", [{ id: "first", body: "first" }])).execution.unavailable_reason, "invalid_embedding_response");
  const retried = await failover.search("q", [{ id: "first", body: "first" }]);
  assert.equal(retried.execution.unavailable_reason, null);
  assert.equal(retried.execution.cost_summary?.billable_units, 1);
  assert.match(String(retried.execution.cost_summary?.usage_digest), /^sha256:/u);
  const again = await failover.search("q", [{ id: "second", body: "second" }]);
  assert.equal(again.execution.unavailable_reason, null);
  assert.equal(again.execution.cost_summary?.billable_units, 1);
  globalThis.fetch = async () => { throw new Error("network down"); };
  const fresh = new OpenAiCompatibleEmbeddingRetrievalPort(freshConfiguration());
  const failed = await fresh.search("q", [{ id: "a", body: "fresh" }]);
  assert.equal(failed.execution.unavailable_reason, "embedding_request_failed");
  assert.equal(failed.execution.used, "keyword");
});

test("embedding port rejects a changed vector dimension before caching", async () => {
  process.env.CRAFT_TEST_EMBED_KEY = "test-key";
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [1, 0, 0] }] }), { status: 200 });
  const port = new OpenAiCompatibleEmbeddingRetrievalPort(freshConfiguration());
  const result = await port.search("q", [{ id: "a", body: "a" }]);
  assert.deepEqual(result.hits, []);
  assert.equal(result.execution.unavailable_reason, "invalid_embedding_response");
});

test("embedding configuration falls back to defaults for optional identity fields", () => {
  const port = new OpenAiCompatibleEmbeddingRetrievalPort({ endpoint: 1, model: 2, credential_env: 3, model_revision: 4 });
  assert.equal(port.endpoint, "");
  assert.equal(port.model, "");
  assert.equal(port.credentialEnv, "");
  assert.equal(port.revision, "unversioned");
});

test("embedding cache evicts least-recently-used vectors above 4096 entries", async () => {
  process.env.CRAFT_TEST_EMBED_KEY = "test-key";
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body)) as { input: string[] };
    return new Response(JSON.stringify({ data: payload.input.map((_input, index) => ({ index, embedding: [1, index + 1] })), usage: { total_tokens: 1 } }), { status: 200 });
  };
  const port = new OpenAiCompatibleEmbeddingRetrievalPort({ endpoint: "http://x", model: "unique-eviction", credential_env: "CRAFT_TEST_EMBED_KEY" });
  const result = await port.search("query", Array.from({ length: 4_097 }, (_, index) => ({ id: `doc${index}`, body: `body ${index}` })));
  assert.equal(result.hits.length, 4_097);
  assert.equal(result.execution.unavailable_reason, null);
});

test("embedding cache rolls back when a persistence insert fails", async () => {
  process.env.CRAFT_TEST_EMBED_KEY = "test-key";
  const cachePath = join(temporaryDirectory(), "broken.db");
  const database = new DatabaseSync(cachePath);
  database.exec("CREATE TABLE embeddings (key TEXT PRIMARY KEY, vector TEXT NOT NULL, touched INTEGER NOT NULL, extra TEXT)");
  database.close();
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body)) as { input: string[] };
    return new Response(JSON.stringify({ data: payload.input.map((_input, index) => ({ index, embedding: [1, 0] })), usage: { total_tokens: 1 } }), { status: 200 });
  };
  const port = new OpenAiCompatibleEmbeddingRetrievalPort({ endpoint: "http://x", model: "broken-cache", credential_env: "CRAFT_TEST_EMBED_KEY" }, cachePath);
  const result = await port.search("q", [{ id: "a", body: "a" }]);
  assert.deepEqual(result.hits, []);
  assert.equal(result.execution.unavailable_reason, "invalid_embedding_response");
});

test("embedding port splits oversized batches and tolerates malformed usage", async () => {
  process.env.CRAFT_TEST_EMBED_KEY = "test-key";
  const inputs: number[] = [];
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body)) as { input: string[] };
    inputs.push(payload.input.length);
    return new Response(JSON.stringify({ data: payload.input.map((_value, index) => ({ index, embedding: [1, 1] })), usage: { total_tokens: "unknown" } }), { status: 200 });
  };
  const port = new OpenAiCompatibleEmbeddingRetrievalPort(freshConfiguration());
  const result = await port.search("q", Array.from({ length: 40 }, (_, index) => ({ id: `d${index}`, body: `${index} ${"x".repeat(20_000)}` })));
  assert.equal(inputs.length, 40);
  assert.equal(result.hits.length, 40);
  assert.equal(result.execution.cost_summary?.billable_units, null);
});

test("beforeRequest aborts the result when the corpus changed", async () => {
  process.env.CRAFT_TEST_EMBED_KEY = "test-key";
  respond({ data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [1, 0] }] });
  let calls = 0;
  const port = new OpenAiCompatibleEmbeddingRetrievalPort(freshConfiguration(), undefined, () => {
    calls += 1;
    if (calls === 2) throw new Error("revoked");
  });
  const result = await port.search("q", [{ id: "a", body: "a" }]);
  assert.deepEqual(result.hits, []);
  assert.equal(result.execution.unavailable_reason, "invalid_embedding_response");
});
