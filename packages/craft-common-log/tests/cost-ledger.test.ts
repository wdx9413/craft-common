import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CostLedgerKernel } from "../src/cost-ledger.ts";
import { CraftStore } from "craft-common-store-local/store";
import { craftPaths } from "craft-common-store-local/paths";

const stores: CraftStore[] = [];
const directories: string[] = [];
async function store(): Promise<CraftStore> {
  const directory = mkdtempSync(join(tmpdir(), "craft-cost-"));
  directories.push(directory);
  const opened = await new CraftStore(craftPaths(directory)).open();
  stores.push(opened);
  return opened;
}
test.after(() => {
  for (const opened of stores) opened.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

test("price snapshots are validated and idempotently replaced", async () => {
  const ledger = new CostLedgerKernel(await store());
  const first = ledger.priceSave({ provider: "openai", model: "gpt", input_per_million: 2, output_per_million: 4, effective_at: "2026-01-01T00:00:00.000Z" });
  assert.equal(first.idempotent, false);
  assert.equal((first.price as { effective_at: string }).effective_at, "2026-01-01T00:00:00.000Z");
  const again = ledger.priceSave({ provider: "openai", model: "gpt", input_per_million: 3, output_per_million: 5 });
  assert.equal((again.price as { version: number }).version, 2);
  assert.equal((again.price as { input_per_million: number }).input_per_million, 3);
  const custom = ledger.priceSave({ price_id: "custom", provider: "p", model: "m", input_per_million: 0, output_per_million: 0 });
  assert.equal((custom.price as { id: string }).id, "custom");
  assert.throws(() => ledger.priceSave({ provider: "", model: "m", input_per_million: 1, output_per_million: 1 }), /provider must not be empty/u);
  assert.throws(() => ledger.priceSave({ provider: "p", model: "m", input_per_million: -1, output_per_million: 1 }), /non-negative finite/u);
  assert.throws(() => ledger.priceSave({ provider: "p", model: "m", input_per_million: 1, output_per_million: "x" }), /non-negative finite/u);
  assert.throws(() => ledger.priceSave({ provider: "p", model: "m", input_per_million: 1, output_per_million: 1, effective_at: "" }), /effective_at must not be empty/u);
});

test("usage records calculate cost from the current price snapshot", async () => {
  const ledger = new CostLedgerKernel(await store());
  ledger.priceSave({ provider: "p", model: "m", input_per_million: 2, output_per_million: 4 });
  const usage = ledger.usageRecord({ provider: "p", model: "m", input_tokens: 1_000_000, output_tokens: 500_000, project_id: "proj", task_id: "task" });
  assert.equal((usage.usage as { cost_usd: number }).cost_usd, 4);
  assert.equal((usage.usage as { project_id: string }).project_id, "proj");
  assert.match(String((usage.usage as { price_digest: string }).price_digest), /^sha256:/u);
  const custom = ledger.usageRecord({ usage_id: "u1", provider: "p", model: "m", input_tokens: 0, output_tokens: 0 });
  assert.equal((custom.usage as { id: string }).id, "u1");
  assert.equal((custom.usage as { project_id: unknown }).project_id, null);
  assert.throws(() => ledger.usageRecord({ provider: "p", model: "m", input_tokens: 1 }), /token counts must be explicit/u);
  assert.throws(() => ledger.usageRecord({ provider: "p", model: "m", input_tokens: 1.5, output_tokens: 0 }), /token counts must be explicit/u);
  assert.throws(() => ledger.usageRecord({ provider: "other", model: "m", input_tokens: 1, output_tokens: 0 }), /No provider price snapshot/u);
});

test("reports total bounded usage and preserve unknown metrics", async () => {
  const ledger = new CostLedgerKernel(await store());
  ledger.priceSave({ provider: "p", model: "m", input_per_million: 1, output_per_million: 1 });
  assert.deepEqual(ledger.report(), { entries: [], truncated: false, unavailable_metrics: ["cost_usd", "input_tokens", "output_tokens"],
    total_cost_usd: null, total_input_tokens: null, total_output_tokens: null });
  ledger.usageRecord({ provider: "p", model: "m", input_tokens: 10, output_tokens: 20, project_id: "a" });
  ledger.usageRecord({ provider: "p", model: "m", input_tokens: 30, output_tokens: 40, project_id: "b" });
  const all = ledger.report();
  assert.equal(all.total_input_tokens, 40);
  assert.equal(all.total_output_tokens, 60);
  assert.ok(Math.abs(Number(all.total_cost_usd) - 0.0001) < 1e-12);
  const scoped = ledger.report({ project_id: "a" });
  assert.equal(scoped.entries.length, 1);
  assert.equal(scoped.total_input_tokens, 10);
  assert.throws(() => ledger.report({ project_id: "" }), /project_id must not be empty/u);
});

test("reports mark metrics unavailable when a stored value is malformed", async () => {
  const opened = await store();
  const ledger = new CostLedgerKernel(opened);
  opened.create("usage_ledger", "bad", { project_id: "p", cost_usd: "x", input_tokens: 1, output_tokens: 1 });
  const report = ledger.report({ project_id: "p" });
  assert.deepEqual(report.unavailable_metrics, ["cost_usd"]);
  assert.equal(report.total_cost_usd, null);
  opened.createBatch([
    { kind: "usage_ledger", id: "overflow-1", payload: { project_id: "o", cost_usd: Number.MAX_VALUE, input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: Number.MAX_SAFE_INTEGER } },
    { kind: "usage_ledger", id: "overflow-2", payload: { project_id: "o", cost_usd: Number.MAX_VALUE, input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 } },
  ]);
  const overflow = ledger.report({ project_id: "o" });
  assert.deepEqual(overflow.unavailable_metrics, ["cost_usd", "input_tokens", "output_tokens"]);
});

test("usage rejects non-finite costs from extreme prices", async () => {
  const ledger = new CostLedgerKernel(await store());
  ledger.priceSave({ provider: "p", model: "m", input_per_million: Number.MAX_VALUE, output_per_million: 0 });
  assert.throws(() => ledger.usageRecord({ provider: "p", model: "m", input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0 }), /calculated cost must be finite/u);
});

test("reports mark truncated collections without partial totals", async () => {
  const opened = await store();
  const ledger = new CostLedgerKernel(opened);
  opened.createBatch(Array.from({ length: 10_001 }, (_, index) => ({
    kind: "usage_ledger", id: `bulk-${index}`, payload: { project_id: "bulk", cost_usd: 0, input_tokens: 0, output_tokens: 0 },
  })));
  const report = ledger.report({ project_id: "bulk" });
  assert.equal(report.truncated, true);
  assert.equal((report.entries as unknown[]).length, 10_000);
  assert.deepEqual(report.unavailable_metrics, ["cost_usd", "input_tokens", "output_tokens"]);
  assert.equal(report.total_cost_usd, null);
});
