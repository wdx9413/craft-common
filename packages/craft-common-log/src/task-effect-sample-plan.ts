import { verify as verifySignature } from "node:crypto";
import { digestJson } from "craft-common-base/digest";

export interface TaskEffectSamplePlan {
  method: "chebyshev-mean-precision-v1";
  pilot_pair_count: number;
  pilot_paired_difference_variance: number;
  pilot_report_digest: string;
  minimum_meaningful_effect: number;
  confidence_level: number;
  planned_task_pairs: number;
  repeats_per_task: number;
  required_pair_count: number;
  pilot_signature: string;
}

export interface SamplePlanBinding {
  candidate_family: string;
  environment_fingerprint: string;
  primary_metric: { name: string; direction: "higher" | "lower"; minimum_delta: number };
  held_out_task_refs: Array<{ kind: string; id: string; version: number }>;
  evaluator_public_key_pem: string;
}

export function requiredPairedSampleSize(input: { pilotVariance: number; minimumMeaningfulEffect: number; confidenceLevel: number }): number {
  const { pilotVariance, minimumMeaningfulEffect, confidenceLevel } = input;
  if (!Number.isFinite(pilotVariance) || pilotVariance < 0 || !Number.isFinite(minimumMeaningfulEffect) || minimumMeaningfulEffect <= 0 ||
      !Number.isFinite(confidenceLevel) || confidenceLevel <= 0 || confidenceLevel >= 1) {
    throw new Error("Sample-size planning requires non-negative pilot variance, positive minimum effect, and confidence between zero and one");
  }
  const plannedPairs = Math.ceil(pilotVariance / (minimumMeaningfulEffect ** 2 * (1 - confidenceLevel)));
  if (!Number.isSafeInteger(plannedPairs)) throw new Error("Calculated paired sample size exceeds the safe integer range");
  return Math.max(2, plannedPairs);
}

export function taskEffectSamplePlanDigest(binding: Pick<SamplePlanBinding, "candidate_family" | "environment_fingerprint" | "primary_metric">, plan: TaskEffectSamplePlan): string {
  const { pilot_signature: _signature, ...unsignedPlan } = plan;
  return digestJson({ candidate_family: binding.candidate_family, environment_fingerprint: binding.environment_fingerprint,
    primary_metric: binding.primary_metric, sample_plan: unsignedPlan });
}

export function validateTaskEffectSamplePlan(binding: SamplePlanBinding, value: unknown): asserts value is TaskEffectSamplePlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Task-effect sample plan must be an object");
  const plan = value as Partial<TaskEffectSamplePlan>;
  if (plan.method !== "chebyshev-mean-precision-v1" || !Number.isSafeInteger(plan.pilot_pair_count) || Number(plan.pilot_pair_count) < 2 ||
      !Number.isFinite(plan.pilot_paired_difference_variance) || Number(plan.pilot_paired_difference_variance) < 0 ||
      typeof plan.pilot_report_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(plan.pilot_report_digest) ||
      !Number.isFinite(plan.minimum_meaningful_effect) || Number(plan.minimum_meaningful_effect) <= 0 ||
      plan.minimum_meaningful_effect !== binding.primary_metric.minimum_delta ||
      !Number.isFinite(plan.confidence_level) || Number(plan.confidence_level) <= 0 || Number(plan.confidence_level) >= 1 ||
      !Number.isSafeInteger(plan.planned_task_pairs) || Number(plan.planned_task_pairs) !== binding.held_out_task_refs.length ||
      !Number.isSafeInteger(plan.repeats_per_task) || Number(plan.repeats_per_task) < 1 ||
      !Number.isSafeInteger(plan.required_pair_count) || Number(plan.required_pair_count) < 1 ||
      typeof plan.pilot_signature !== "string" || !plan.pilot_signature.trim()) {
    throw new Error("Task-effect sample plan must bind pilot variance, minimum effect, confidence, and planned held-out repetitions");
  }
  const required = requiredPairedSampleSize({ pilotVariance: Number(plan.pilot_paired_difference_variance),
    minimumMeaningfulEffect: Number(plan.minimum_meaningful_effect), confidenceLevel: Number(plan.confidence_level) });
  if (plan.required_pair_count !== required || Number(plan.planned_task_pairs) < required) {
    throw new Error("Task-effect sample plan must freeze the computed paired sample size across enough unique held-out tasks");
  }
  let signatureValid = false;
  try {
    signatureValid = verifySignature(null, Buffer.from(taskEffectSamplePlanDigest(binding, plan as TaskEffectSamplePlan)),
      binding.evaluator_public_key_pem, Buffer.from(plan.pilot_signature, "base64"));
  } catch { signatureValid = false; }
  if (!signatureValid) throw new Error("Task-effect pilot sample-size receipt signature is invalid");
}

export function expectedTaskEffectPairKeys(refs: Array<{ kind: string; id: string; version: number }>, repeatsPerTask: number): string[] {
  if (!Number.isSafeInteger(repeatsPerTask) || repeatsPerTask < 1) throw new Error("Repeats per task must be a positive integer");
  return refs.flatMap(ref => Array.from({ length: repeatsPerTask }, (_, index) => `${ref.kind}/${ref.id}@${ref.version}#${index + 1}`)).sort();
}

export function actualTaskEffectPairKey(pair: { case_ref: { kind: string; id: string; version: number }; repeat_index?: number }): string {
  const repeatIndex = pair.repeat_index ?? 1;
  if (!Number.isSafeInteger(repeatIndex) || repeatIndex < 1) throw new Error("Task-effect pair repeat index must be a positive integer");
  return `${pair.case_ref.kind}/${pair.case_ref.id}@${pair.case_ref.version}#${repeatIndex}`;
}
