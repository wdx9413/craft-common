import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EvaluationContractKernel, EVALUATION_STAGES } from "../src/evaluation-contract.ts";
import { CraftStore } from "craft-common-store-local/store";
import { craftPaths } from "craft-common-store-local/paths";

const stores: CraftStore[] = [];
const directories: string[] = [];
async function store(): Promise<CraftStore> {
  const directory = mkdtempSync(join(tmpdir(), "craft-eval-contract-"));
  directories.push(directory);
  const opened = await new CraftStore(craftPaths(directory)).open();
  stores.push(opened);
  return opened;
}
test.after(() => {
  for (const opened of stores) opened.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});
const definition = { capability_id: "cap", capability_version: 1, input_contract: "in", output_contract: "out", effect: "read_only" };

test("contract definitions are validated and idempotent", async () => {
  const kernel = new EvaluationContractKernel(await store());
  assert.deepEqual([...EVALUATION_STAGES], ["mechanism_passed", "fixture_passed", "conformance_passed", "integration_passed", "host_verified", "business_eligible", "routeable"]);
  const first = kernel.define(definition);
  assert.equal(first.idempotent, false);
  const contract = first.contract as { id: string; status: string; reported_stage: unknown; stage_history: unknown[]; contract_digest: string };
  assert.match(contract.id, /^evaluation_contract_/u);
  assert.equal(contract.status, "defined");
  assert.equal(contract.reported_stage, null);
  assert.deepEqual(contract.stage_history, []);
  assert.match(contract.contract_digest, /^sha256:/u);
  const again = kernel.define({ ...definition, contract_id: contract.id });
  assert.equal(again.idempotent, true);
  assert.equal((again.contract as { id: string }).id, contract.id);
  const custom = kernel.define({ ...definition, contract_id: "custom" });
  assert.equal((custom.contract as { id: string }).id, "custom");
});

test("contract definitions reject invalid capability or IO fields", async () => {
  const kernel = new EvaluationContractKernel(await store());
  assert.throws(() => kernel.define({ ...definition, capability_id: " " }), /requires capability and IO contracts/u);
  assert.throws(() => kernel.define({ ...definition, capability_version: 0 }), /requires capability and IO contracts/u);
  assert.throws(() => kernel.define({ ...definition, input_contract: "" }), /requires capability and IO contracts/u);
  assert.throws(() => kernel.define({ ...definition, output_contract: " " }), /requires capability and IO contracts/u);
  const existing = kernel.define({ ...definition, contract_id: "stable" });
  assert.throws(() => kernel.define({ ...definition, contract_id: "stable", effect: "local_write" }), /idempotency conflict/u);
  assert.equal((existing.contract as { id: string }).id, "stable");
});

test("stages advance one gate at a time with distinct evidence", async () => {
  const kernel = new EvaluationContractKernel(await store());
  kernel.define({ ...definition, contract_id: "c" });
  assert.throws(() => kernel.record({ contract_id: "c", stage: "fixture_passed", evidence: ["e"] }), /one gate at a time/u);
  assert.throws(() => kernel.record({ contract_id: "c", stage: "unknown" as never, evidence: ["e"] }), /Unsupported evaluation stage/u);
  assert.throws(() => kernel.record({ contract_id: "c", stage: "mechanism_passed" }), /distinct evidence references/u);
  assert.throws(() => kernel.record({ contract_id: "c", stage: "mechanism_passed", evidence: ["e", "e"] }), /distinct evidence references/u);
  assert.throws(() => kernel.record({ contract_id: "c", stage: "mechanism_passed", evidence: [""] }), /distinct evidence references/u);
  const recorded = kernel.record({ contract_id: "c", stage: "mechanism_passed", evidence: ["e1"], metrics: { score: 1 } });
  assert.equal((recorded as { reported_stage: string }).reported_stage, "mechanism_passed");
  assert.equal((recorded as { status: string }).status, "defined");
  assert.equal((recorded as { latest_metrics: { score: number } }).latest_metrics.score, 1);
  const history = (recorded as { stage_history: Array<{ stage: string; verification: string }> }).stage_history;
  assert.deepEqual(history.map(item => [item.stage, item.verification]), [["mechanism_passed", "reported"]]);
  const repeated = kernel.record({ contract_id: "c", stage: "mechanism_passed", evidence: ["e2"] });
  assert.equal((repeated as { stage_history: unknown[] }).stage_history.length, 1);
});

test("trusted evidence must bind to the contract, host and candidate change", async () => {
  const opened = await store();
  const kernel = new EvaluationContractKernel(opened);
  kernel.define({ ...definition, contract_id: "c" });
  for (const [stage, evidence] of [["mechanism_passed", "m"], ["fixture_passed", "f"], ["conformance_passed", "c"], ["integration_passed", "i"]] as const) {
    kernel.record({ contract_id: "c", stage, evidence: [evidence] });
  }
  opened.create("verification_plan", "p1", { change_ref: "c:host_verified", requires_real_host: false, candidate_change: false });
  opened.create("verification_assessment", "a1", { verdict: "eligible", verification_id: "p1" });
  const untrusted = kernel.record({ contract_id: "c", stage: "host_verified", evidence: ["a1"] });
  assert.equal((untrusted as { verified_stage: unknown }).verified_stage, null);
  assert.equal((untrusted as { stage_history: Array<{ stage: string; verification: string }> }).stage_history.find(item => item.stage === "host_verified")!.verification, "reported");
  opened.create("verification_plan", "p2", { change_ref: "c:host_verified", requires_real_host: true, candidate_change: false });
  opened.create("verification_assessment", "a2", { verdict: "eligible", verification_id: "p2" });
  kernel.define({ ...definition, contract_id: "d" });
  for (const stage of ["mechanism_passed", "fixture_passed", "conformance_passed", "integration_passed", "host_verified", "business_eligible", "routeable"] as const) {
    const plan = `plan-${stage}`, assessment = `assessment-${stage}`;
    opened.create("verification_plan", plan, { change_ref: `d:${stage}`, requires_real_host: stage === "host_verified", candidate_change: stage === "routeable" });
    opened.create("verification_assessment", assessment, { verdict: "eligible", verification_id: plan });
    const recorded = kernel.record({ contract_id: "d", stage, evidence: [assessment] });
    if (stage === "host_verified") {
      assert.equal((recorded as { verified_stage: string }).verified_stage, "host_verified");
      assert.equal((recorded as { status: string }).status, "host_verified");
      assert.equal(kernel.get("d").routeable, false);
    }
  }
  assert.equal(kernel.get("d").routeable, true);
});

test("ineligible evidence and missing plans remain reported", async () => {
  const opened = await store();
  const kernel = new EvaluationContractKernel(opened);
  kernel.define({ ...definition, contract_id: "c" });
  opened.create("verification_assessment", "a1", { verdict: "rejected", verification_id: "p1" });
  opened.create("verification_assessment", "a2", { verdict: "eligible", verification_id: "missing" });
  opened.create("verification_plan", "p3", { change_ref: "other:mechanism_passed", requires_real_host: true, candidate_change: true });
  opened.create("verification_assessment", "a3", { verdict: "eligible", verification_id: "p3" });
  for (const evidence of ["a1", "a2", "a3", "absent"]) {
    const result = kernel.record({ contract_id: "c", stage: "mechanism_passed", evidence: [evidence] });
    assert.equal((result as { verified_stage: unknown }).verified_stage, null);
  }
});

test("backward stage moves require a trusted bound assessment", async () => {
  const opened = await store();
  const kernel = new EvaluationContractKernel(opened);
  kernel.define({ ...definition, contract_id: "c" });
  kernel.record({ contract_id: "c", stage: "mechanism_passed", evidence: ["e1"] });
  kernel.record({ contract_id: "c", stage: "fixture_passed", evidence: ["e2"] });
  assert.throws(() => kernel.record({ contract_id: "c", stage: "mechanism_passed", evidence: ["e3"] }), /cannot move backwards/u);
  opened.create("verification_plan", "p1", { change_ref: "c:mechanism_passed", requires_real_host: false, candidate_change: false });
  opened.create("verification_assessment", "a1", { verdict: "eligible", verification_id: "p1" });
  const moved = kernel.record({ contract_id: "c", stage: "mechanism_passed", evidence: ["a1"] });
  assert.equal((moved as { reported_stage: string }).reported_stage, "fixture_passed");
  assert.equal((moved as { stage_history: unknown[] }).stage_history.length, 2);
});

test("contracts report their stage list and reject unknown ids", async () => {
  const kernel = new EvaluationContractKernel(await store());
  kernel.define({ ...definition, contract_id: "c" });
  const view = kernel.get("c");
  assert.deepEqual(view.stages, EVALUATION_STAGES);
  assert.throws(() => kernel.get("missing"), /Unknown evaluation_contract: missing/u);
  assert.throws(() => kernel.record({ contract_id: "missing", stage: "mechanism_passed", evidence: ["e"] }), /Unknown evaluation_contract: missing/u);
});

test("legacy status fields are treated as the reported stage", async () => {
  const opened = await store();
  const kernel = new EvaluationContractKernel(opened);
  kernel.define({ ...definition, contract_id: "c" });
  opened.save("evaluation_contract", "c", { ...opened.get("evaluation_contract", "c"), reported_stage: null, status: "fixture_passed" });
  assert.throws(() => kernel.record({ contract_id: "c", stage: "integration_passed", evidence: ["e"] }), /one gate at a time/u);
  const result = kernel.record({ contract_id: "c", stage: "conformance_passed", evidence: ["e"] });
  assert.equal((result as { reported_stage: string }).reported_stage, "conformance_passed");
  const legacyHistory = kernel.record({ contract_id: "c", stage: "conformance_passed", evidence: ["e2"] });
  assert.equal((legacyHistory as { stage_history: unknown[] }).stage_history.length, 1);
});

test("backward moves without evidence are rejected before verification", async () => {
  const opened = await store();
  const kernel = new EvaluationContractKernel(opened);
  kernel.define({ ...definition, contract_id: "c" });
  kernel.record({ contract_id: "c", stage: "mechanism_passed", evidence: ["e1"] });
  kernel.record({ contract_id: "c", stage: "fixture_passed", evidence: ["e2"] });
  assert.throws(() => kernel.record({ contract_id: "c", stage: "mechanism_passed" }), /cannot move backwards without a bound assessment/u);
});

test("contracts without stage history start from an empty list", async () => {
  const opened = await store();
  const kernel = new EvaluationContractKernel(opened);
  kernel.define({ ...definition, contract_id: "c" });
  const current = opened.get("evaluation_contract", "c");
  const { stage_history: _history, ...withoutHistory } = current;
  opened.save("evaluation_contract", "c", withoutHistory);
  const result = kernel.record({ contract_id: "c", stage: "mechanism_passed", evidence: ["e"] });
  assert.equal((result as { stage_history: unknown[] }).stage_history.length, 1);
});

test("routeable evidence must be bound to a candidate change", async () => {
  const opened = await store();
  const kernel = new EvaluationContractKernel(opened);
  kernel.define({ ...definition, contract_id: "c" });
  for (const stage of ["mechanism_passed", "fixture_passed", "conformance_passed", "integration_passed", "host_verified", "business_eligible"] as const) {
    const plan = `plan-${stage}`, assessment = `assessment-${stage}`;
    opened.create("verification_plan", plan, { change_ref: `c:${stage}`, requires_real_host: stage === "host_verified", candidate_change: false });
    opened.create("verification_assessment", assessment, { verdict: "eligible", verification_id: plan });
    kernel.record({ contract_id: "c", stage, evidence: [assessment] });
  }
  opened.create("verification_plan", "plan-routeable", { change_ref: "c:routeable", requires_real_host: false, candidate_change: false });
  opened.create("verification_assessment", "assessment-routeable", { verdict: "eligible", verification_id: "plan-routeable" });
  const result = kernel.record({ contract_id: "c", stage: "routeable", evidence: ["assessment-routeable"] });
  assert.equal((result as { verified_stage: unknown }).verified_stage, "business_eligible");
  assert.equal((result as { reported_stage: string }).reported_stage, "routeable");
  assert.equal(kernel.get("c").routeable, false);
});
