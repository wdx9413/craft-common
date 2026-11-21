import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateKeyPairSync, sign as signReceipt } from "node:crypto";
import { EvaluationContractKernel, EVALUATION_STAGES, parseTrustedEvaluatorRegistry } from "../src/evaluation-contract.ts";
import { requiredPairedSampleSize, taskEffectSamplePlanDigest, type TaskEffectSamplePlan } from "../src/task-effect-sample-plan.ts";
import { CraftStore } from "craft-common-store-local/store";
import { craftPaths } from "craft-common-store-local/paths";
import { digestJson, stableDigest } from "craft-common-base/digest";

const stores: CraftStore[] = [];
const directories: string[] = [];
const evaluatorKeys = generateKeyPairSync("ed25519");
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
const taskEffect = {
  candidate_family: "candidate_asset",
  environment_fingerprint: "sha256:environment", primary_metric: { name: "quality", direction: "higher" as const, minimum_delta: 0.1 },
  tolerated_regressions: { errors: 0.1 }, latency_budget_ms: 100, cost_budget: 2,
  evaluator: { id: "independent-evaluator", version: "1", digest: digestJson("evaluator"), public_key_pem: evaluatorKeys.publicKey.export({ type: "spki", format: "pem" }).toString() }, hard_assertions: ["safety", "privacy"]
};

function pair(refs: { case_ref: { kind: string; id: string; version: number; digest: string }; baseline_session_ref: { kind: string; id: string; version: number; digest: string }; candidate_session_ref: { kind: string; id: string; version: number; digest: string } }, quality = 0.5, errors = 0, latency_ms = 50, cost = 1) {
  return { case_ref: refs.case_ref,
    baseline: { session_ref: refs.baseline_session_ref, metrics: { quality: 0.5, errors: 0.1 }, latency_ms: 40, cost: 0.5, assertions: { safety: true, privacy: true } },
    candidate: { session_ref: refs.candidate_session_ref, metrics: { quality, errors }, latency_ms, cost, assertions: { safety: true, privacy: true } } };
}
function pairAt(heldOutRefs: Array<{ kind: string; id: string; version: number; digest: string }>, sessionRefs: Array<{ kind: string; id: string; version: number; digest: string }>, index: number, quality = 0.5, errors = 0, latency_ms = 50, cost = 1) {
  return pair({ case_ref: heldOutRefs[index]!, baseline_session_ref: sessionRefs[index * 2]!, candidate_session_ref: sessionRefs[index * 2 + 1]! }, quality, errors, latency_ms, cost);
}

function createTask(opened: CraftStore, id: string) {
  return opened.create("task", id, { title: id, goal: `Goal ${id}`, project_id: null, workspace_id: null, model_id: null, permission_mode: "ask", status: "active" });
}

function createHostSession(opened: CraftStore, taskId: string, sessionId: string) {
  const traceId = `trace-${sessionId}`, hostId = "codex-cli";
  const optionalFingerprints = sessionId.endsWith("candidate");
  const sessionIdentity = { trace_id: traceId, task_id: taskId, host_id: hostId, environment_fingerprint: taskEffect.environment_fingerprint,
    policy_fingerprint: "sha256:policy", capability_fingerprint: "sha256:capability", model_fingerprint: optionalFingerprints ? null : "sha256:model", budget_fingerprint: optionalFingerprints ? null : "sha256:budget" };
  opened.create("trace", traceId, { task_id: taskId, status: "running", next_sequence: 0, event_count: 0 });
  let session = opened.create("host_session", sessionId, { ...sessionIdentity, identity_digest: digestJson(sessionIdentity), status: "running", next_sequence: 0, raw_content_stored: false });
  for (const kind of ["session.started", "session.completed"] as const) {
    const sequence = Number(session.next_sequence) + 1;
    const hostEvent = { session_id: sessionId, sequence, kind, host_id: hostId, action_contract_ref: null, state_before_ref: null, state_after_ref: null, artifact_refs: [], evidence_refs: [], summary_digest: null };
    const eventId = `${sessionId}:${kind === "session.started" ? "started" : sequence}`;
    const eventDigest = digestJson(hostEvent), traceEventId = `host_session_trace:${eventId}`;
    const traceIdentity = { trace_id: traceId, sequence, event_kind: kind, actor: hostId, source: "host_session", trust: "observed", span_id: `${traceId}:span:${sequence}`, parent_span_id: null, operation_id: null,
      action_contract: null, state_before: null, state_after: null, input_refs: [], output_refs: sessionId.includes("bad-output") && kind === "session.completed" ? ["unexpected-output"] : [], capability_revision: null, policy_revision: null, model_fingerprint: null,
      environment_fingerprint: null, workspace_before: null, workspace_after: null, usage: null, cost_usd: null, duration_ms: null, error_class: null, status: null, summary: null,
      data_digest: stableDigest({ session_id: sessionId, session_sequence: sequence, event_digest: eventDigest }), ...(kind === "session.completed" ? { content_stored: false } : {}) };
    const traceEvent = opened.create("trace_event", traceEventId, { ...traceIdentity, event_digest: stableDigest(traceIdentity), trace_id: traceId });
    opened.create("host_session_event", eventId, { ...hostEvent, event_digest: eventDigest, trace_event_id: traceEvent.id, trace_event_version: traceEvent.version, raw_content_stored: false });
    session = opened.save("host_session", sessionId, { ...session, status: kind === "session.completed" ? "terminal" : "running", next_sequence: sequence });
  }
  return session;
}

async function taskEffectKernel(id = "te") {
  const opened = await store();
  const kernel = new EvaluationContractKernel(opened, [taskEffect.evaluator]);
  const baseline = opened.create("candidate_asset", "baseline-v1", { content_digest: digestJson("baseline"), asset_type: "workflow" });
  opened.create("candidate_asset", "candidate-v2", { content_digest: digestJson("candidate"), asset_type: "workflow" });
  const developmentTask = createTask(opened, "dev-1"), heldOut1 = createTask(opened, "hold-1"), heldOut2 = createTask(opened, "hold-2");
  const heldOut1BaselineSession = createHostSession(opened, String(heldOut1.id), "session-hold-1-baseline"), heldOut1CandidateSession = createHostSession(opened, String(heldOut1.id), "session-hold-1-candidate");
  const heldOut2BaselineSession = createHostSession(opened, String(heldOut2.id), "session-hold-2-baseline"), heldOut2CandidateSession = createHostSession(opened, String(heldOut2.id), "session-hold-2-candidate");
  const devRef = kernel.taskRef(String(developmentTask.id), Number(developmentTask.version));
  const heldOutRefs = [kernel.taskRef(String(heldOut1.id), Number(heldOut1.version)), kernel.taskRef(String(heldOut2.id), Number(heldOut2.version))];
  const baselineRef = kernel.artifactRef("candidate_asset", String(baseline.id), Number(baseline.version));
  const candidateRef = kernel.artifactRef("candidate_asset", "candidate-v2", 1);
  const sessionRefs = [kernel.hostSessionRef(String(heldOut1BaselineSession.id), Number(heldOut1BaselineSession.version)), kernel.hostSessionRef(String(heldOut1CandidateSession.id), Number(heldOut1CandidateSession.version)),
    kernel.hostSessionRef(String(heldOut2BaselineSession.id), Number(heldOut2BaselineSession.version)), kernel.hostSessionRef(String(heldOut2CandidateSession.id), Number(heldOut2CandidateSession.version))];
  const samplePlanUnsigned: TaskEffectSamplePlan = { method: "chebyshev-mean-precision-v1", pilot_pair_count: 5, pilot_paired_difference_variance: 0.0001,
    pilot_report_digest: digestJson({ pilot: id }), minimum_meaningful_effect: 0.1, confidence_level: 0.95, planned_task_pairs: heldOutRefs.length,
    repeats_per_task: 1, required_pair_count: requiredPairedSampleSize({ pilotVariance: 0.0001, minimumMeaningfulEffect: 0.1, confidenceLevel: 0.95 }), pilot_signature: "pending" };
  const samplePlanBinding = { candidate_family: taskEffect.candidate_family, environment_fingerprint: taskEffect.environment_fingerprint, primary_metric: taskEffect.primary_metric };
  const samplePlan = { ...samplePlanUnsigned, pilot_signature: signReceipt(null, Buffer.from(taskEffectSamplePlanDigest(samplePlanBinding, samplePlanUnsigned)), evaluatorKeys.privateKey).toString("base64") };
  const spec = { ...taskEffect, baseline_ref: baselineRef, candidate_ref: candidateRef, task_set: { id: "tasks", development_task_refs: [devRef], held_out_task_refs: heldOutRefs,
    digest: digestJson({ id: "tasks", development_task_refs: [devRef], held_out_task_refs: heldOutRefs }) }, sample_plan: samplePlan };
  const pairs = [pair({ case_ref: heldOutRefs[0]!, baseline_session_ref: sessionRefs[0]!, candidate_session_ref: sessionRefs[1]! }),
    pair({ case_ref: heldOutRefs[1]!, baseline_session_ref: sessionRefs[2]!, candidate_session_ref: sessionRefs[3]! })];
  kernel.define({ capability_id: "cap", capability_version: 1, input_contract: "in", output_contract: "out", effect: "task_effect", task_effect: spec, contract_id: id });
  return { opened, kernel, spec, candidateRef, devRef, heldOutRefs, sessionRefs, pairs };
}

function signedEvaluation(kernel: EvaluationContractKernel, input: Parameters<EvaluationContractKernel["recordTaskEffectEvaluation"]>[0]) {
  const contract = kernel.get(input.contract_id).contract as { contract_digest: string };
  const receiptDigest = digestJson({ contract_digest: contract.contract_digest, ...input });
  return { ...input, evaluator_signature: signReceipt(null, Buffer.from(receiptDigest), evaluatorKeys.privateKey).toString("base64") };
}

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

test("reference sources are copied, merged before use, and never mix an unconfigured kind", async () => {
  const evaluation = await store(), tasks = await store(), artifacts = await store();
  const task = createTask(tasks, "authoritative-task");
  const artifact = artifacts.create("candidate_asset", "authoritative-artifact", { content_digest: digestJson("authoritative"), asset_type: "workflow" });
  const session = createHostSession(tasks, String(task.id), "authoritative-session");
  const kernel = new EvaluationContractKernel(evaluation);
  const firstSources = new Map([["task", tasks], ["host_session", tasks], ["host_session_event", tasks]]);
  const secondSources = new Map([["candidate_asset", artifacts], ["trace_event", tasks]]);
  kernel.setReferenceSources(firstSources);
  kernel.setReferenceSources(new Map([["task", tasks]]));
  kernel.setReferenceSources(secondSources);
  assert.throws(() => kernel.setReferenceSources(new Map([["task", artifacts]])), /already configured for task/u);
  firstSources.set("candidate_asset", evaluation);
  secondSources.set("task", evaluation);

  assert.deepEqual(kernel.taskRef(String(task.id), Number(task.version)), {
    kind: "task", id: task.id, version: task.version,
    digest: digestJson({ kind: "task", id: task.id, version: task.version,
      payload: Object.fromEntries(Object.entries(task).filter(([key]) => !["id", "version", "created_at", "updated_at"].includes(key)).sort(([a], [b]) => a.localeCompare(b))) }),
  });
  assert.deepEqual(kernel.artifactRef("candidate_asset", String(artifact.id), Number(artifact.version)), {
    kind: "candidate_asset", id: artifact.id, version: artifact.version, digest: artifact.content_digest,
  });
  assert.deepEqual(kernel.hostSessionRef(String(session.id), Number(session.version)),
    new EvaluationContractKernel(tasks).hostSessionRef(String(session.id), Number(session.version)));
  assert.throws(() => kernel.artifactRef("unregistered_kind", "missing", 1), /source is not configured for unregistered_kind/u);
  assert.throws(() => kernel.setReferenceSources(new Map([["host_session", tasks]])), /must be configured before/u);
  assert.throws(() => new EvaluationContractKernel(evaluation).setReferenceSources(new Map([[" ", tasks]])), /must bind a record kind/u);
  const localTask = createTask(evaluation, "local-only-task"), emptyRouting = new EvaluationContractKernel(evaluation);
  emptyRouting.setReferenceSources(new Map());
  assert.throws(() => emptyRouting.taskRef(String(localTask.id), Number(localTask.version)), /source is not configured for task/u);
});

test("task-effect reference routing cannot be changed after contract definition", async () => {
  const { kernel } = await taskEffectKernel("route-frozen");
  const other = await store();
  assert.throws(() => kernel.setReferenceSources(new Map([["task", other]])), /must be configured before/u);
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

test("task-effect contracts freeze their complete evaluation contract", async () => {
  const { opened, kernel, spec } = await taskEffectKernel("frozen");
  const defined = kernel.define({ ...definition, effect: "task_effect", task_effect: spec, contract_id: "frozen" });
  const contract = defined.contract as { contract_digest: string; task_effect: typeof spec };
  assert.equal(contract.contract_digest, (kernel.get("frozen").contract as { contract_digest: string }).contract_digest);
  assert.deepEqual(contract.task_effect, spec);
  assert.equal(kernel.define({ ...definition, effect: "task_effect", task_effect: spec, contract_id: "frozen" }).idempotent, true);
  assert.throws(() => kernel.define({ ...definition, effect: "task_effect", task_effect: { ...spec, cost_budget: 3 }, contract_id: "frozen" }), /idempotency conflict/u);
  assert.throws(() => kernel.define({ ...definition, effect: "task_effect", contract_id: "missing" }), /Task-effect contract must/u);
  assert.throws(() => kernel.define({ ...definition, effect: "read_only", task_effect: spec }), /requires effect=task_effect/u);
  for (const invalid of [
    { ...spec, candidate_family: " " }, { ...spec, baseline_ref: { ...spec.baseline_ref, kind: "wrong" } }, { ...spec, environment_fingerprint: " " },
    { ...spec, task_set: { ...spec.task_set, held_out_task_refs: [] } }, { ...spec, evaluator: { ...spec.evaluator, id: " " } },
    { ...spec, primary_metric: { ...spec.primary_metric, direction: "sideways" as "higher" } }, { ...spec, primary_metric: { ...spec.primary_metric, minimum_delta: -0.1 } },
    { ...spec, latency_budget_ms: 0 }, { ...spec, cost_budget: -1 }, { ...spec, hard_assertions: ["safety", "safety"] },
    { ...spec, tolerated_regressions: { errors: -1 } }, { ...spec, task_set: { ...spec.task_set, digest: "sha256:wrong" } },
    { ...spec, sample_plan: undefined },
    { ...spec, sample_plan: { ...spec.sample_plan, required_pair_count: spec.sample_plan.required_pair_count + 1 } },
    { ...spec, sample_plan: { ...spec.sample_plan, pilot_signature: "invalid" } },
    { ...spec, candidate_ref: null },
    { ...spec, candidate_ref: { ...spec.candidate_ref, digest: null } },
    { ...spec, candidate_ref: { ...spec.candidate_ref, digest: "invalid" } },
    { ...spec, candidate_ref: { ...spec.candidate_ref, digest: `sha256:${"0".repeat(64)}` } },
    { ...spec, task_set: { ...spec.task_set, development_task_refs: [{ ...spec.task_set.development_task_refs[0]!, kind: "not-task" }],
      digest: digestJson({ id: spec.task_set.id, development_task_refs: [{ ...spec.task_set.development_task_refs[0]!, kind: "not-task" }], held_out_task_refs: spec.task_set.held_out_task_refs }) } }
  ]) assert.throws(() => kernel.define({ ...definition, effect: "task_effect", task_effect: invalid }), /Task-effect contract must|Task-effect task set must|Candidate artifact reference|Task-effect sample plan|pilot sample-size receipt/u);
  opened.create("candidate_asset", "missing-stable-digest", { name: "no digest" });
  assert.throws(() => kernel.artifactRef("candidate_asset", "missing-stable-digest", 1), /no stable content or definition digest/u);
  assert.throws(() => kernel.taskRef("missing-task", 1), /Unknown task/u);
  assert.throws(() => kernel.artifactRef("", "", 0), /must bind kind, id and version/u);
  assert.throws(() => kernel.hostSessionRef("task", 1), /Unknown host_session/u);
  const noEventTask = createTask(opened, "no-event-task"), noEventId = "session-no-event", noEventTrace = "trace-no-event";
  const noEventIdentity = { trace_id: noEventTrace, task_id: noEventTask.id, host_id: "codex-cli", environment_fingerprint: taskEffect.environment_fingerprint,
    policy_fingerprint: "p", capability_fingerprint: "c", model_fingerprint: null, budget_fingerprint: null };
  const noEventSession = opened.create("host_session", noEventId, { ...noEventIdentity, identity_digest: digestJson(noEventIdentity), status: "terminal", next_sequence: 1 });
  assert.throws(() => kernel.hostSessionRef(String(noEventSession.id), Number(noEventSession.version)), /no valid completed event receipt/u);
  const badOutputTask = createTask(opened, "bad-output-task"), badOutputSession = createHostSession(opened, String(badOutputTask.id), "session-bad-output");
  assert.throws(() => kernel.hostSessionRef(String(badOutputSession.id), Number(badOutputSession.version)), /trace receipt is invalid/u);
  const badIdentityTask = createTask(opened, "bad-identity-task"), badIdentitySession = createHostSession(opened, String(badIdentityTask.id), "session-bad-identity");
  const invalidIdentitySession = opened.save("host_session", String(badIdentitySession.id), { identity_digest: "sha256:wrong" });
  assert.throws(() => kernel.hostSessionRef(String(invalidIdentitySession.id), Number(invalidIdentitySession.version)), /identity or terminal status/u);
  const badEventTask = createTask(opened, "bad-event-task"), badEventSession = createHostSession(opened, String(badEventTask.id), "session-bad-event");
  const completedEvent = opened.list("host_session_event", 100, event => event.session_id === badEventSession.id && event.kind === "session.completed")[0]!;
  opened.save("host_session_event", String(completedEvent.id), { event_digest: "sha256:wrong" });
  assert.throws(() => kernel.hostSessionRef(String(badEventSession.id), Number(badEventSession.version)), /no valid completed event receipt/u);
});

test("paired sample size is frozen from signed pilot variance and planned repeats", async () => {
  assert.equal(requiredPairedSampleSize({ pilotVariance: 0, minimumMeaningfulEffect: 1, confidenceLevel: 0.95 }), 2);
  assert.equal(requiredPairedSampleSize({ pilotVariance: 0.5, minimumMeaningfulEffect: 0.1, confidenceLevel: 0.95 }), 1000);
  for (const input of [
    { pilotVariance: -1, minimumMeaningfulEffect: 1, confidenceLevel: 0.95 },
    { pilotVariance: 1, minimumMeaningfulEffect: 0, confidenceLevel: 0.95 },
    { pilotVariance: 1, minimumMeaningfulEffect: 1, confidenceLevel: 0 },
    { pilotVariance: 1, minimumMeaningfulEffect: 1, confidenceLevel: 1 },
    { pilotVariance: Number.NaN, minimumMeaningfulEffect: 1, confidenceLevel: 0.95 },
  ]) assert.throws(() => requiredPairedSampleSize(input), /Sample-size planning requires/u);
  const { spec } = await taskEffectKernel("sample-plan");
  const binding = { candidate_family: spec.candidate_family, environment_fingerprint: spec.environment_fingerprint, primary_metric: spec.primary_metric };
  const planDigest = taskEffectSamplePlanDigest(binding, spec.sample_plan);
  assert.match(planDigest, /^sha256:/u);
  assert.equal(planDigest, taskEffectSamplePlanDigest(binding, { ...spec.sample_plan, pilot_signature: "different" }));
  assert.notEqual(planDigest, taskEffectSamplePlanDigest({ ...binding, candidate_family: "other" }, spec.sample_plan));
});

test("a contract requires every frozen repeat for each held-out task", async () => {
  const { opened, kernel, spec, candidateRef, devRef, heldOutRefs, sessionRefs } = await taskEffectKernel("repeat-count");
  const unsignedPlan: TaskEffectSamplePlan = { ...spec.sample_plan, repeats_per_task: 2, pilot_signature: "pending" };
  const binding = { candidate_family: spec.candidate_family, environment_fingerprint: spec.environment_fingerprint, primary_metric: spec.primary_metric };
  const repeatedSpec = { ...spec, sample_plan: { ...unsignedPlan, pilot_signature: signReceipt(null, Buffer.from(taskEffectSamplePlanDigest(binding, unsignedPlan)), evaluatorKeys.privateKey).toString("base64") } };
  kernel.define({ ...definition, effect: "task_effect", task_effect: repeatedSpec, contract_id: "repeat-count-v2" });
  const extraSessions = heldOutRefs.flatMap((taskRef, index) => [
    createHostSession(opened, taskRef.id, `repeat-${index}-baseline`), createHostSession(opened, taskRef.id, `repeat-${index}-candidate`),
  ]).map(session => kernel.hostSessionRef(String(session.id), Number(session.version)));
  const pairs = [
    { ...pair({ case_ref: heldOutRefs[0]!, baseline_session_ref: sessionRefs[0]!, candidate_session_ref: sessionRefs[1]! }, 0.8), repeat_index: 1 },
    { ...pair({ case_ref: heldOutRefs[0]!, baseline_session_ref: extraSessions[0]!, candidate_session_ref: extraSessions[1]! }, 0.8), repeat_index: 2 },
    { ...pair({ case_ref: heldOutRefs[1]!, baseline_session_ref: sessionRefs[2]!, candidate_session_ref: sessionRefs[3]! }, 0.8), repeat_index: 1 },
    { ...pair({ case_ref: heldOutRefs[1]!, baseline_session_ref: extraSessions[2]!, candidate_session_ref: extraSessions[3]! }, 0.8), repeat_index: 2 },
  ];
  const input = { contract_id: "repeat-count-v2", evaluation_id: "repeat-evaluation", candidate_ref: candidateRef,
    candidate_source_task_refs: [devRef], evaluator: spec.evaluator, pairs };
  const report = kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, input));
  assert.equal((report.result as { eligible: boolean }).eligible, true);
  assert.equal((report.pairs as unknown[]).length, 4);
  assert.throws(() => kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, { ...input, evaluation_id: "missing-repeat", pairs: pairs.slice(0, 3) })), /exactly the frozen held-out pairs/u);
});

test("task-effect evaluation computes eligibility from exact independent held-out pairs", async () => {
  const { opened, kernel, spec, candidateRef, devRef, heldOutRefs, sessionRefs } = await taskEffectKernel();
  const base = { contract_id: "te", evaluation_id: "eval-ok", candidate_ref: candidateRef, candidate_source_task_refs: [devRef], evaluator: spec.evaluator,
    pairs: [pairAt(heldOutRefs, sessionRefs, 0, 0.8, 0.15), pairAt(heldOutRefs, sessionRefs, 1, 0.8, 0.15)] };
  assert.throws(() => kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, { ...base, evaluator: { ...spec.evaluator, id: "candidate-author" } })), /evaluator mismatch/u);
  assert.throws(() => kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, { ...base, candidate_ref: { ...candidateRef, id: "missing" }, evaluation_id: "wrong-family" })), /Unknown candidate_asset/u);
  assert.throws(() => kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, { ...base, candidate_source_task_refs: [heldOutRefs[0]!], evaluation_id: "leaked-task" })), /Development source tasks/u);
  assert.throws(() => kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, { ...base, pairs: [base.pairs[0]!], evaluation_id: "missing-heldout" })), /exactly the frozen held-out pairs/u);
  assert.throws(() => kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, { ...base, evaluation_id: "invalid-repeat", pairs: [{ ...base.pairs[0]!, repeat_index: 0 }, base.pairs[1]!] })), /typed artifact/u);
  assert.throws(() => kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, { ...base, pairs: [base.pairs[0]!, { ...base.pairs[1]!, candidate: { ...base.pairs[1]!.candidate, session_ref: sessionRefs[0]! } }], evaluation_id: "duplicate-session" })), /exact stored Host task/u);
  assert.throws(() => kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, { ...base, pairs: [
    { ...base.pairs[0]!, baseline: { ...base.pairs[0]!.baseline, session_ref: sessionRefs[2]! }, candidate: { ...base.pairs[0]!.candidate, session_ref: sessionRefs[1]! } }, base.pairs[1]!
  ], evaluation_id: "session-task-mismatch" })), /exact stored Host task/u);
  opened.save("candidate_asset", "candidate-v2", { content_digest: digestJson("candidate-version-3"), asset_type: "workflow" });
  const newerCandidateRef = kernel.artifactRef("candidate_asset", "candidate-v2", 2);
  assert.throws(() => kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, { ...base, candidate_ref: newerCandidateRef, evaluation_id: "candidate-version-drift" })), /frozen candidate version/u);
  const evaluation = kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, base)) as { result: { eligible: boolean; delta: number; regressions_pass: boolean; hard_assertions_pass: boolean; latency_ms: number; cost: number }; contract_digest: string };
  assert.equal(evaluation.result.eligible, true);
  assert.equal(evaluation.result.delta, 0.30000000000000004);
  assert.equal(evaluation.result.regressions_pass, true);
  assert.equal(evaluation.result.hard_assertions_pass, true);
  assert.equal(evaluation.result.latency_ms, 50);
  assert.equal(evaluation.result.cost, 1);
  assert.equal(evaluation.contract_digest, (opened.get("evaluation_contract", "te") as { contract_digest: string }).contract_digest);
  assert.deepEqual(kernel.verifyTaskEffectEvaluation({ contract_id: "te", evaluation_id: "eval-ok" }).valid, true);
  const explicitRepeat = kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, { ...base, evaluation_id: "explicit-repeat", pairs: base.pairs.map(item => ({ ...item, repeat_index: 1 })) }));
  assert.equal(kernel.verifyTaskEffectEvaluation({ contract_id: "te", evaluation_id: String(explicitRepeat.evaluation_id) }).valid, true);
  assert.equal(kernel.verifyTaskEffectEvaluation({ contract_id: "te", evaluation_id: "eval-ok", candidate_ref: { ...candidateRef, version: 9 } }).valid, false);
  assert.equal(kernel.verifyTaskEffectEvaluation({ contract_id: "te", evaluation_id: "eval-ok", candidate_ref: { ...candidateRef, digest: `sha256:${"0".repeat(64)}` } }).valid, false);
  assert.equal(kernel.verifyTaskEffectEvaluation({ contract_id: "te", evaluation_id: "missing-evaluation" }).eligible, false);
  assert.throws(() => kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, base)), /already exists/u);
  assert.throws(() => kernel.recordTaskEffectEvaluation({ ...signedEvaluation(kernel, { ...base, evaluation_id: "tampered" }), pairs: [pairAt(heldOutRefs, sessionRefs, 0), pairAt(heldOutRefs, sessionRefs, 1, 0.9)] }), /signature is invalid/u);
  assert.throws(() => kernel.recordTaskEffectEvaluation({ ...signedEvaluation(kernel, { ...base, evaluation_id: "missing-contract" }), contract_id: "missing" }), /Unknown evaluation_contract/u);
  const readOnly = kernel.define({ ...definition, contract_id: "read-only" });
  assert.throws(() => kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, { ...base, contract_id: "read-only", evaluation_id: "wrong-effect" })), /requires a task-effect contract/u);
  const lower = new EvaluationContractKernel(opened, [taskEffect.evaluator]);
  const lowerSpec = { ...spec, primary_metric: { name: "quality", direction: "lower" as const, minimum_delta: 0.2 } };
  const lowerPlanUnsigned = { ...spec.sample_plan, minimum_meaningful_effect: 0.2, required_pair_count: requiredPairedSampleSize({ pilotVariance: spec.sample_plan.pilot_paired_difference_variance,
    minimumMeaningfulEffect: 0.2, confidenceLevel: spec.sample_plan.confidence_level }), pilot_signature: "pending" };
  const lowerBinding = { candidate_family: lowerSpec.candidate_family, environment_fingerprint: lowerSpec.environment_fingerprint, primary_metric: lowerSpec.primary_metric };
  lowerSpec.sample_plan = { ...lowerPlanUnsigned, pilot_signature: signReceipt(null, Buffer.from(taskEffectSamplePlanDigest(lowerBinding, lowerPlanUnsigned)), evaluatorKeys.privateKey).toString("base64") };
  lower.define({ ...definition, effect: "task_effect", task_effect: lowerSpec, contract_id: "lower" });
  const lowerInput = { ...base, contract_id: "lower", evaluation_id: "lower-eval", pairs: [pairAt(heldOutRefs, sessionRefs, 0, 0.2), pairAt(heldOutRefs, sessionRefs, 1, 0.2)] };
  assert.equal((lower.recordTaskEffectEvaluation(signedEvaluation(lower, lowerInput)).result as { eligible: boolean }).eligible, true);
  assert.equal(kernel.verifyTaskEffectEvaluation({ contract_id: "lower", evaluation_id: "eval-ok" }).valid, false);
  assert.throws(() => kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, { ...base, evaluation_id: "malformed-pair", pairs: [null] } as never)), /typed artifact/u);
  assert.throws(() => kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, { ...base, evaluation_id: "malformed-arm", pairs: [{ ...base.pairs[0]!, baseline: null }, base.pairs[1]!] } as never)), /typed artifact/u);
});

test("malformed stored evaluator key fails closed", async () => {
  const { opened, kernel, spec, candidateRef, devRef, heldOutRefs, sessionRefs } = await taskEffectKernel("bad-key");
  const current = opened.get("evaluation_contract", "bad-key");
  opened.save("evaluation_contract", "bad-key", { ...current, task_effect: { ...spec, evaluator: { ...spec.evaluator, public_key_pem: "malformed" } } });
  const input = { contract_id: "bad-key", evaluation_id: "bad-key-eval", candidate_ref: candidateRef, candidate_source_task_refs: [devRef],
    evaluator: { ...spec.evaluator, public_key_pem: "malformed" }, pairs: [pairAt(heldOutRefs, sessionRefs, 0), pairAt(heldOutRefs, sessionRefs, 1)] };
  assert.throws(() => kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, input)), /signature is invalid/u);
});

test("Runtime evaluator trust roots are strict and caller supplied keys cannot authorize themselves", async () => {
  const valid = { ...taskEffect.evaluator };
  assert.deepEqual(parseTrustedEvaluatorRegistry(JSON.stringify([valid])), [valid]);
  assert.deepEqual(parseTrustedEvaluatorRegistry(""), []);
  for (const invalid of ["{", "{}", JSON.stringify([null]), JSON.stringify([{}]),
    JSON.stringify([{ ...valid, id: "has spaces" }]), JSON.stringify([{ ...valid, version: " " }]),
    JSON.stringify([{ ...valid, digest: "bad" }]), JSON.stringify([{ ...valid, public_key_pem: "bad" }]),
    JSON.stringify([valid, valid])]) {
    assert.throws(() => parseTrustedEvaluatorRegistry(invalid));
  }
  const { opened, kernel, spec, candidateRef, devRef, heldOutRefs, sessionRefs } = await taskEffectKernel("untrusted-evaluator");
  assert.doesNotThrow(() => kernel.define({ ...definition, effect: "task_effect", task_effect: { ...spec, cohort_id: "pilot-blue" }, contract_id: "cohort-bound" }));
  assert.throws(() => kernel.define({ ...definition, effect: "task_effect", task_effect: { ...spec, cohort_id: "invalid cohort" }, contract_id: "cohort-invalid" }), /Task-effect contract must freeze/u);
  const untrusted = new EvaluationContractKernel(opened, []);
  assert.throws(() => untrusted.define({ ...definition, effect: "task_effect", task_effect: spec, contract_id: "candidate-self-signed" }), /not trusted by the Runtime/u);
  const input = { contract_id: "untrusted-evaluator", evaluation_id: "untrusted-evaluation", candidate_ref: candidateRef,
    candidate_source_task_refs: [devRef], evaluator: spec.evaluator, pairs: [pairAt(heldOutRefs, sessionRefs, 0), pairAt(heldOutRefs, sessionRefs, 1)] };
  kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, input));
  assert.equal(untrusted.verifyTaskEffectEvaluation({ contract_id: input.contract_id, evaluation_id: input.evaluation_id }).valid, false);
  assert.throws(() => untrusted.recordTaskEffectEvaluation(signedEvaluation(untrusted, input)), /not trusted by the Runtime/u);
});

test("task-effect business eligibility and routeability require the passing bound report", async () => {
  const { opened, kernel, spec, candidateRef, devRef, heldOutRefs, sessionRefs } = await taskEffectKernel("promote");
  for (const stage of ["mechanism_passed", "fixture_passed", "conformance_passed", "integration_passed", "host_verified"] as const) {
    const plan = `plan-${stage}`, assessment = `assessment-${stage}`;
    opened.create("verification_plan", plan, { change_ref: `promote:${stage}`, requires_real_host: stage === "host_verified", candidate_change: false });
    opened.create("verification_assessment", assessment, { verdict: "eligible", verification_id: plan });
    kernel.record({ contract_id: "promote", stage, evidence: [assessment] });
  }
  opened.create("task_effect_evaluation", "malformed-report", { contract_id: "promote", contract_digest: (opened.get("evaluation_contract", "promote") as { contract_digest: string }).contract_digest, candidate_source_task_refs: [devRef], pairs: [null] });
  assert.equal(kernel.verifyTaskEffectEvaluation({ contract_id: "promote", evaluation_id: "malformed-report" }).result, null);
  assert.equal(kernel.record({ contract_id: "promote", stage: "business_eligible", evidence: ["malformed-report"] }).status, "host_verified");
  const seedInput = { contract_id: "promote", evaluation_id: "seed-evaluation", candidate_ref: candidateRef, candidate_source_task_refs: [devRef], evaluator: spec.evaluator,
    pairs: [pairAt(heldOutRefs, sessionRefs, 0, 0.8), pairAt(heldOutRefs, sessionRefs, 1, 0.8)] };
  const seed = kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, seedInput)) as Record<string, unknown>;
  const rejectInjectedReport = (id: string, patch: Record<string, unknown>) => {
    opened.create("task_effect_evaluation", id, { ...seed, evaluation_id: id, ...patch });
    assert.equal(kernel.record({ contract_id: "promote", stage: "business_eligible", evidence: [id] }).status, "host_verified");
  };
  rejectInjectedReport("bad-source", { candidate_source_task_refs: [heldOutRefs[0]] });
  rejectInjectedReport("bad-heldout-set", { pairs: [pairAt(heldOutRefs, sessionRefs, 0)] });
  rejectInjectedReport("bad-session-set", { pairs: [pairAt(heldOutRefs, sessionRefs, 0), { ...pairAt(heldOutRefs, sessionRefs, 1), candidate: { ...pairAt(heldOutRefs, sessionRefs, 1).candidate, session_ref: sessionRefs[0] } }] });
  rejectInjectedReport("bad-session-kind", { pairs: [{ ...pairAt(heldOutRefs, sessionRefs, 0), baseline: { ...pairAt(heldOutRefs, sessionRefs, 0).baseline, session_ref: { ...sessionRefs[0]!, kind: "task" } } }, pairAt(heldOutRefs, sessionRefs, 1)] });
  rejectInjectedReport("bad-task-session", { pairs: [pairAt(heldOutRefs, sessionRefs, 0), { ...pairAt(heldOutRefs, sessionRefs, 1), candidate: { ...pairAt(heldOutRefs, sessionRefs, 1).candidate, session_ref: sessionRefs[1] } }] });
  rejectInjectedReport("bad-measurement", { pairs: [pairAt(heldOutRefs, sessionRefs, 0), { ...pairAt(heldOutRefs, sessionRefs, 1), candidate: { ...pairAt(heldOutRefs, sessionRefs, 1).candidate, metrics: { quality: null, errors: 0 } } }] });
  rejectInjectedReport("bad-evaluator", { evaluator: { ...spec.evaluator, id: "forged" } });
  rejectInjectedReport("bad-candidate", { candidate_ref: { ...candidateRef, digest: `sha256:${"0".repeat(64)}` } });
  rejectInjectedReport("bad-signature", { evaluator_signature: "invalid" });
  opened.create("verification_plan", "business-plan", { change_ref: "promote:business_eligible", requires_real_host: false, candidate_change: false });
  opened.create("verification_assessment", "caller-passed", { verdict: "eligible", verification_id: "business-plan", passed: true });
  const direct = kernel.record({ contract_id: "promote", stage: "business_eligible", evidence: ["caller-passed"] });
  assert.equal((direct as { verified_stage: unknown }).verified_stage, "host_verified");
  assert.equal(kernel.get("promote").routeable, false);
  const failedInput = { contract_id: "promote", evaluation_id: "eval-failed", candidate_ref: candidateRef, candidate_source_task_refs: [devRef], evaluator: spec.evaluator,
    pairs: [pairAt(heldOutRefs, sessionRefs, 0, 0.55, 1, 101, 3), pairAt(heldOutRefs, sessionRefs, 1, 0.55, 1, 101, 3)] };
  const failed = kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, failedInput)) as { result: { eligible: boolean; regressions_pass: boolean; hard_assertions_pass: boolean } };
  assert.equal(failed.result.eligible, false);
  assert.equal(failed.result.regressions_pass, false);
  assert.equal(kernel.record({ contract_id: "promote", stage: "business_eligible", evidence: ["eval-failed"] }).status, "host_verified");
  const failedVerification = kernel.verifyTaskEffectEvaluation({ contract_id: "promote", evaluation_id: "eval-failed", candidate_ref: candidateRef });
  assert.equal(failedVerification.valid, true, "a signed negative result remains authentic evidence for rollback monitoring");
  assert.equal(failedVerification.eligible, false);
  assert.equal(failedVerification.routeable, false);
  const reportInput = { contract_id: "promote", evaluation_id: "eval-passing", candidate_ref: candidateRef, candidate_source_task_refs: [devRef], evaluator: spec.evaluator,
    pairs: [pairAt(heldOutRefs, sessionRefs, 0, 0.8), { ...pairAt(heldOutRefs, sessionRefs, 1, 0.8), candidate: { ...pairAt(heldOutRefs, sessionRefs, 1, 0.8).candidate, assertions: { safety: false, privacy: true } } }] };
  const report = kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, reportInput)) as { result: { eligible: boolean; hard_assertions_pass: boolean } };
  assert.equal(report.result.eligible, false);
  assert.equal(report.result.hard_assertions_pass, false);
  const finalInput = { contract_id: "promote", evaluation_id: "eval-final", candidate_ref: candidateRef, candidate_source_task_refs: [devRef], evaluator: spec.evaluator,
    pairs: [pairAt(heldOutRefs, sessionRefs, 0, 0.8), pairAt(heldOutRefs, sessionRefs, 1, 0.8)] };
  kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, finalInput));
  const eligible = kernel.record({ contract_id: "promote", stage: "business_eligible", evidence: ["eval-final"] });
  assert.equal((eligible as { verified_stage: string }).verified_stage, "business_eligible");
  const routeable = kernel.record({ contract_id: "promote", stage: "routeable", evidence: ["eval-final"] });
  assert.equal((routeable as { verified_stage: string }).verified_stage, "routeable");
  assert.equal(kernel.verifyTaskEffectEvaluation({ contract_id: "promote", evaluation_id: "eval-final", candidate_ref: candidateRef }).routeable, true);
  const readonlyContract = kernel.define({ ...definition, contract_id: "readonly-verify" });
  assert.equal(kernel.verifyTaskEffectEvaluation({ contract_id: String((readonlyContract.contract as JsonObject).id), evaluation_id: "eval-final" }).valid, false);
  assert.equal(kernel.get("promote").routeable, true);
  assert.throws(() => kernel.recordTaskEffectEvaluation({ contract_id: "promote", evaluation_id: "bad-metric", candidate_ref: candidateRef, candidate_source_task_refs: [devRef], evaluator: spec.evaluator,
    pairs: [pairAt(heldOutRefs, sessionRefs, 0, Number.NaN), pairAt(heldOutRefs, sessionRefs, 1)] }), /typed artifact/u);
});
