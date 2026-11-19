import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { digestJson } from "craft-common-base/digest";
import {
  actualTaskEffectPairKey,
  expectedTaskEffectPairKeys,
  requiredPairedSampleSize,
  taskEffectSamplePlanDigest,
  validateTaskEffectSamplePlan,
  type SamplePlanBinding,
  type TaskEffectSamplePlan,
} from "../src/task-effect-sample-plan.ts";

const keys = generateKeyPairSync("ed25519");
const binding: SamplePlanBinding = {
  candidate_family: "experience_procedure",
  environment_fingerprint: "sha256:environment",
  primary_metric: { name: "success", direction: "higher", minimum_delta: 0.1 },
  held_out_task_refs: [
    { kind: "task", id: "held-out-a", version: 1 },
    { kind: "task", id: "held-out-b", version: 2 },
  ],
  evaluator_public_key_pem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
};

function signedPlan(overrides: Partial<TaskEffectSamplePlan> = {}, target = binding): TaskEffectSamplePlan {
  const unsigned: TaskEffectSamplePlan = {
    method: "chebyshev-mean-precision-v1",
    pilot_pair_count: 8,
    pilot_paired_difference_variance: 0.0001,
    pilot_report_digest: digestJson("pilot-report"),
    minimum_meaningful_effect: 0.1,
    confidence_level: 0.95,
    planned_task_pairs: target.held_out_task_refs.length,
    repeats_per_task: 1,
    required_pair_count: requiredPairedSampleSize({ pilotVariance: 0.0001, minimumMeaningfulEffect: 0.1, confidenceLevel: 0.95 }),
    pilot_signature: "pending",
    ...overrides,
  };
  return { ...unsigned, pilot_signature: sign(null, Buffer.from(taskEffectSamplePlanDigest(target, unsigned)), keys.privateKey).toString("base64") };
}

test("sample size uses pilot variance and minimum meaningful effect with a distribution-free precision bound", () => {
  assert.equal(requiredPairedSampleSize({ pilotVariance: 0, minimumMeaningfulEffect: 1, confidenceLevel: 0.95 }), 2);
  assert.equal(requiredPairedSampleSize({ pilotVariance: 0.0001, minimumMeaningfulEffect: 0.1, confidenceLevel: 0.95 }), 2);
  assert.equal(requiredPairedSampleSize({ pilotVariance: 0.5, minimumMeaningfulEffect: 0.1, confidenceLevel: 0.95 }), 1000);
  for (const invalid of [
    { pilotVariance: -1, minimumMeaningfulEffect: 1, confidenceLevel: 0.95 },
    { pilotVariance: 1, minimumMeaningfulEffect: 0, confidenceLevel: 0.95 },
    { pilotVariance: 1, minimumMeaningfulEffect: 1, confidenceLevel: 0 },
    { pilotVariance: 1, minimumMeaningfulEffect: 1, confidenceLevel: 1 },
    { pilotVariance: Number.NaN, minimumMeaningfulEffect: 1, confidenceLevel: 0.95 },
    { pilotVariance: 1, minimumMeaningfulEffect: Number.POSITIVE_INFINITY, confidenceLevel: 0.95 },
  ]) assert.throws(() => requiredPairedSampleSize(invalid), /Sample-size planning requires/u);
  assert.throws(() => requiredPairedSampleSize({ pilotVariance: Number.MAX_VALUE, minimumMeaningfulEffect: Number.MIN_VALUE, confidenceLevel: 0.95 }), /safe integer range/u);
});

test("pilot receipt signature binds its metric, environment, candidate family and signed plan", () => {
  const plan = signedPlan();
  assert.doesNotThrow(() => validateTaskEffectSamplePlan(binding, plan));
  assert.notEqual(taskEffectSamplePlanDigest(binding, plan), taskEffectSamplePlanDigest({ ...binding, environment_fingerprint: "sha256:other" }, plan));
  assert.notEqual(taskEffectSamplePlanDigest(binding, plan), taskEffectSamplePlanDigest({ ...binding, candidate_family: "other" }, plan));
  assert.notEqual(taskEffectSamplePlanDigest(binding, plan), taskEffectSamplePlanDigest({ ...binding, primary_metric: { ...binding.primary_metric, name: "other" } }, plan));
  assert.notEqual(taskEffectSamplePlanDigest(binding, plan), taskEffectSamplePlanDigest(binding, { ...plan, pilot_paired_difference_variance: 0.0002 }));
});

test("sample plan rejects missing evidence, invalid counts, changed thresholds, and insufficient pairs", () => {
  const plan = signedPlan();
  const invalids: unknown[] = [
    null,
    [],
    { ...plan, method: "normal-approximation" },
    { ...plan, pilot_pair_count: 1 },
    { ...plan, pilot_pair_count: 1.5 },
    { ...plan, pilot_paired_difference_variance: -1 },
    { ...plan, pilot_report_digest: "not-a-digest" },
    { ...plan, minimum_meaningful_effect: 0 },
    { ...plan, minimum_meaningful_effect: 0.2 },
    { ...plan, confidence_level: 1 },
    { ...plan, planned_task_pairs: 1 },
    { ...plan, repeats_per_task: 0 },
    { ...plan, required_pair_count: 0 },
    { ...plan, pilot_signature: " " },
    { ...plan, required_pair_count: plan.required_pair_count + 1 },
    { ...plan, repeats_per_task: 0, required_pair_count: plan.required_pair_count },
    { ...plan, pilot_signature: "not-base64-signature" },
  ];
  for (const invalid of invalids) assert.throws(() => validateTaskEffectSamplePlan(binding, invalid));
  assert.throws(() => validateTaskEffectSamplePlan({ ...binding, evaluator_public_key_pem: "invalid-key" }, plan), /signature is invalid/u);
  const largeVariance = signedPlan({ pilot_paired_difference_variance: 0.5,
    required_pair_count: requiredPairedSampleSize({ pilotVariance: 0.5, minimumMeaningfulEffect: 0.1, confidenceLevel: 0.95 }) });
  assert.throws(() => validateTaskEffectSamplePlan(binding, largeVariance), /enough unique held-out tasks/u);
  const repeatedTasksCannotSubstitute = signedPlan({ pilot_paired_difference_variance: 0.5, repeats_per_task: 500,
    required_pair_count: requiredPairedSampleSize({ pilotVariance: 0.5, minimumMeaningfulEffect: 0.1, confidenceLevel: 0.95 }) });
  assert.throws(() => validateTaskEffectSamplePlan(binding, repeatedTasksCannotSubstitute), /enough unique held-out tasks/u);
});

test("pair keys freeze each held-out task and repetition exactly once", () => {
  assert.deepEqual(expectedTaskEffectPairKeys(binding.held_out_task_refs, 1), ["task/held-out-a@1#1", "task/held-out-b@2#1"]);
  assert.deepEqual(expectedTaskEffectPairKeys(binding.held_out_task_refs, 2), ["task/held-out-a@1#1", "task/held-out-a@1#2", "task/held-out-b@2#1", "task/held-out-b@2#2"]);
  assert.equal(actualTaskEffectPairKey({ case_ref: binding.held_out_task_refs[0]! }), "task/held-out-a@1#1");
  assert.equal(actualTaskEffectPairKey({ case_ref: binding.held_out_task_refs[0]!, repeat_index: 2 }), "task/held-out-a@1#2");
  assert.throws(() => expectedTaskEffectPairKeys(binding.held_out_task_refs, 0), /positive integer/u);
  assert.throws(() => actualTaskEffectPairKey({ case_ref: binding.held_out_task_refs[0]!, repeat_index: 0 }), /positive integer/u);
});
