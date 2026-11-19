import type { JsonObject, CraftStore } from "craft-common-store-local/store";
import { digestJson, stableDigest } from "craft-common-base/digest";
import { verify as verifySignature } from "node:crypto";
import { actualTaskEffectPairKey, expectedTaskEffectPairKeys, type TaskEffectSamplePlan, validateTaskEffectSamplePlan } from "./task-effect-sample-plan.ts";
export { requiredPairedSampleSize, taskEffectSamplePlanDigest } from "./task-effect-sample-plan.ts";
export type { TaskEffectSamplePlan } from "./task-effect-sample-plan.ts";

export const EVALUATION_STAGES = ["mechanism_passed", "fixture_passed", "conformance_passed", "integration_passed", "host_verified", "business_eligible", "routeable"] as const;
export type EvaluationStage = typeof EVALUATION_STAGES[number];

export interface EvaluationRecordRef { kind: string; id: string; version: number; digest: string }

export interface TaskEffectContract {
  candidate_family: string;
  cohort_id?: string;
  baseline_ref: EvaluationRecordRef;
  candidate_ref: EvaluationRecordRef;
  task_set: { id: string; digest: string; development_task_refs: EvaluationRecordRef[]; held_out_task_refs: EvaluationRecordRef[] };
  environment_fingerprint: string;
  primary_metric: { name: string; direction: "higher" | "lower"; minimum_delta: number };
  sample_plan: TaskEffectSamplePlan;
  tolerated_regressions: Record<string, number>;
  latency_budget_ms: number;
  cost_budget: number;
  evaluator: { id: string; version: string; digest: string; public_key_pem: string };
  hard_assertions: string[];
}

export interface TrustedEvaluatorIdentity {
  id: string;
  version: string;
  digest: string;
  public_key_pem: string;
}

/**
 * Runtime-owned evaluator trust roots. The candidate contract may name an evaluator,
 * but it cannot establish that evaluator's authority by supplying its own public key.
 * Deployments provide this immutable allowlist through CRAFT_TRUSTED_EVALUATORS.
 */
export function parseTrustedEvaluatorRegistry(value = process.env.CRAFT_TRUSTED_EVALUATORS): TrustedEvaluatorIdentity[] {
  if (value === undefined || value.trim() === "") return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("CRAFT_TRUSTED_EVALUATORS must be a JSON array"); }
  if (!Array.isArray(parsed)) throw new Error("CRAFT_TRUSTED_EVALUATORS must be a JSON array");
  const entries = parsed.map((item): TrustedEvaluatorIdentity => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Trusted evaluator entry must be an object");
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(entry.id)
      || typeof entry.version !== "string" || !entry.version.trim()
      || typeof entry.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(entry.digest)
      || typeof entry.public_key_pem !== "string" || !entry.public_key_pem.includes("BEGIN PUBLIC KEY")) {
      throw new Error("Trusted evaluator entry requires a bounded id, version, sha256 digest, and public key");
    }
    return { id: entry.id, version: entry.version, digest: entry.digest, public_key_pem: entry.public_key_pem };
  });
  const keys = entries.map(entry => `${entry.id}@${entry.version}`);
  if (new Set(keys).size !== keys.length) throw new Error("Trusted evaluator registry contains duplicate identities");
  return entries;
}

interface TaskEffectPair {
  case_ref: EvaluationRecordRef;
  repeat_index?: number;
  baseline: { session_ref: EvaluationRecordRef; metrics: Record<string, number>; latency_ms: number; cost: number; assertions: Record<string, boolean> };
  candidate: { session_ref: EvaluationRecordRef; metrics: Record<string, number>; latency_ms: number; cost: number; assertions: Record<string, boolean> };
}

export interface TaskEffectEvaluationInput {
  contract_id: string;
  evaluation_id: string;
  candidate_ref: EvaluationRecordRef;
  candidate_source_task_refs: EvaluationRecordRef[];
  evaluator: TaskEffectContract["evaluator"];
  evaluator_signature: string;
  pairs: TaskEffectPair[];
}

export interface EvaluationContractInput {
  capability_id: string;
  capability_version: number;
  input_contract: string;
  output_contract: string;
  scope?: JsonObject;
  effect?: string;
  fixture_id?: string;
  host_compatibility?: string[];
  budget?: JsonObject;
  task_effect?: TaskEffectContract;
}

function stageIndex(stage: EvaluationStage): number { return EVALUATION_STAGES.indexOf(stage); }

export class EvaluationContractKernel {
  readonly store: CraftStore;
  readonly trustedEvaluators: readonly TrustedEvaluatorIdentity[];
  constructor(store: CraftStore, trustedEvaluators: readonly TrustedEvaluatorIdentity[] = parseTrustedEvaluatorRegistry()) {
    this.store = store;
    this.trustedEvaluators = trustedEvaluators.map(entry => ({ ...entry }));
  }

  private assertTrustedEvaluator(evaluator: TrustedEvaluatorIdentity): void {
    const trusted = this.trustedEvaluators.find(item => item.id === evaluator.id && item.version === evaluator.version);
    if (!trusted || trusted.digest !== evaluator.digest || trusted.public_key_pem !== evaluator.public_key_pem) {
      throw new Error("Evaluation Contract evaluator is not trusted by the Runtime");
    }
  }

  define(input: EvaluationContractInput & { contract_id?: string }): JsonObject {
    if (!input.capability_id.trim() || !Number.isInteger(input.capability_version) || input.capability_version < 1 || !input.input_contract.trim() || !input.output_contract.trim()) throw new Error("Evaluation Contract requires capability and IO contracts");
    if (input.effect === "task_effect") {
      validateTaskEffectContract(input.task_effect, this.store);
      this.assertTrustedEvaluator(input.task_effect!.evaluator);
    }
    if (input.effect !== "task_effect" && input.task_effect !== undefined) throw new Error("Task-effect contract requires effect=task_effect");
    const id = input.contract_id ?? `evaluation_contract_${digestJson({ capability_id: input.capability_id, version: input.capability_version }).slice(-16)}`;
    const existing = this.store.find("evaluation_contract", id);
    const { contract_id: _ignored, ...contractInput } = input;
    const payload = { ...contractInput, status: "defined", reported_stage: null, verified_stage: null,
      stage_history: [] as JsonObject[], contract_digest: digestJson(contractInput) };
    if (existing) {
      if (existing.contract_digest !== payload.contract_digest) throw new Error("Evaluation Contract idempotency conflict");
      return { contract: existing, idempotent: true };
    }
    return { contract: this.store.create("evaluation_contract", id, payload), idempotent: false };
  }

  artifactRef(kind: string, id: string, version: number): EvaluationRecordRef { return artifactRef(this.store, { kind, id, version }); }
  taskRef(id: string, version: number): EvaluationRecordRef { return taskRef(this.store, { kind: "task", id, version }); }
  hostSessionRef(id: string, version: number): EvaluationRecordRef { return hostSessionRef(this.store, { kind: "host_session", id, version }); }

  verifyTaskEffectEvaluation(input: { contract_id: string; evaluation_id: string; candidate_ref?: EvaluationRecordRef }): JsonObject {
    const contract = this.store.get("evaluation_contract", input.contract_id);
    const report = this.store.find("task_effect_evaluation", input.evaluation_id);
    if (contract.effect !== "task_effect" || !report || report.contract_id !== contract.id || report.contract_digest !== contract.contract_digest) {
      return { valid: false, eligible: false, routeable: false, contract_id: contract.id, evaluation_id: input.evaluation_id };
    }
    const spec = requireTaskEffectContract(contract.task_effect, this.store);
    try { this.assertTrustedEvaluator(spec.evaluator); } catch {
      return { valid: false, eligible: false, routeable: false, contract_id: contract.id, evaluation_id: input.evaluation_id,
        reason: "untrusted_evaluator" };
    }
    const candidateMatches = input.candidate_ref === undefined || isRecordRef(report.candidate_ref) && sameRef(input.candidate_ref, report.candidate_ref);
    const valid = candidateMatches && validTaskEffectEvaluation(this.store, spec, report);
    return { valid, eligible: valid && (report.result as JsonObject | undefined)?.eligible === true,
      routeable: valid && (report.result as JsonObject | undefined)?.eligible === true && contract.verified_stage === "routeable", contract_id: contract.id, contract_digest: contract.contract_digest,
      evaluation_id: String(report.id), evaluation_digest: report.evaluation_digest, candidate_ref: report.candidate_ref,
      result: report.result ?? null };
  }

  recordTaskEffectEvaluation(rawInput: JsonObject): JsonObject {
    const input = parseTaskEffectEvaluationInput(rawInput);
    const contract = this.store.get("evaluation_contract", input.contract_id);
    if (contract.effect !== "task_effect" || !contract.task_effect) throw new Error("Task-effect evaluation requires a task-effect contract");
    const spec = requireTaskEffectContract(contract.task_effect, this.store);
    this.assertTrustedEvaluator(spec.evaluator);
    if (this.store.find("task_effect_evaluation", input.evaluation_id)) throw new Error("Task-effect evaluation id already exists");
    assertArtifactRef(this.store, input.candidate_ref, spec.candidate_family);
    if (!sameRef(input.candidate_ref, spec.candidate_ref)) throw new Error("Evaluation candidate differs from the frozen candidate version");
    if (digestJson(input.evaluator) !== digestJson(spec.evaluator)) throw new Error("Evaluation Contract evaluator mismatch");
    if (!input.candidate_source_task_refs.length || new Set(input.candidate_source_task_refs.map(ref => `${ref.kind}/${ref.id}@${ref.version}`)).size !== input.candidate_source_task_refs.length ||
      input.candidate_source_task_refs.some(ref => !spec.task_set.development_task_refs.some(item => sameRef(item, ref)) || !validTaskRef(this.store, ref))) throw new Error("Development source tasks must be exact stored task versions");
    if (!validHeldOutPairs(this.store, spec, input.pairs))
      throw new Error("Evaluation must contain exactly the frozen held-out pairs; every pair must use an exact stored Host task and distinct completed-session receipts for both arms");
    const { evaluator_signature, ...signedInput } = input;
    const receiptDigest = digestJson({ contract_digest: contract.contract_digest, ...signedInput });
    const signatureValid = verifySignature(null, Buffer.from(receiptDigest), spec.evaluator.public_key_pem, Buffer.from(evaluator_signature, "base64"));
    if (!signatureValid) throw new Error("Independent evaluator receipt signature is invalid");
    const result = computeTaskEffectResult(spec, input.pairs);
    const report = { contract_id: input.contract_id, contract_digest: contract.contract_digest, evaluation_id: input.evaluation_id,
      candidate_ref: input.candidate_ref, evaluator: input.evaluator, evaluator_signature, candidate_source_task_refs: input.candidate_source_task_refs,
      pairs: input.pairs, result,
      evaluation_digest: digestJson({ contract_digest: contract.contract_digest, ...input, eligible: result.eligible }) };
    return this.store.create("task_effect_evaluation", input.evaluation_id, report);
  }

  record(input: { contract_id: string; stage: EvaluationStage; evidence?: string[]; metrics?: JsonObject; }): JsonObject {
    const current = this.store.get("evaluation_contract", input.contract_id);
    if (!EVALUATION_STAGES.includes(input.stage)) throw new Error(`Unsupported evaluation stage: ${input.stage}`);
    const reported = (current.reported_stage ?? (current.status === "defined" ? null : current.status)) as EvaluationStage | null;
    const previous = reported === null ? -1 : stageIndex(reported);
    if (stageIndex(input.stage) > previous + 1) throw new Error("Evaluation Contract stages must advance one gate at a time");
    const evidence = input.evidence;
    if (stageIndex(input.stage) < previous && (!Array.isArray(evidence) || evidence.length === 0)) throw new Error("Evaluation Contract stages cannot move backwards without a bound assessment");
    if (!Array.isArray(evidence) || !evidence.length || evidence.some(id => typeof id !== "string" || !id.trim()) || new Set(evidence).size !== evidence.length) {
      throw new Error("Evaluation Contract stage requires distinct evidence references");
    }
    const verified = evidence.some(id => {
      const taskEvaluation = this.store.find("task_effect_evaluation", id);
      if (current.effect === "task_effect" && (input.stage === "business_eligible" || input.stage === "routeable")) {
        return Boolean(taskEvaluation && (taskEvaluation.result as JsonObject | undefined)?.eligible === true && taskEvaluation.contract_id === input.contract_id && taskEvaluation.contract_digest === current.contract_digest &&
          validTaskEffectEvaluation(this.store, requireTaskEffectContract(current.task_effect, this.store), taskEvaluation));
      }
      const assessment = this.store.find("verification_assessment", id);
      if (!assessment || assessment.verdict !== "eligible") return false;
      const plan = this.store.find("verification_plan", String(assessment.verification_id));
      if (!plan || plan.change_ref !== `${input.contract_id}:${input.stage}`) return false;
      if (input.stage === "host_verified" && plan.requires_real_host !== true) return false;
      if (input.stage === "routeable" && plan.candidate_change !== true) return false;
      return true;
    });
    const priorVerified = current.verified_stage === null || current.verified_stage === undefined ? -1 : stageIndex(current.verified_stage as EvaluationStage);
    const trusted = verified && stageIndex(input.stage) <= priorVerified + 1;
    if (stageIndex(input.stage) < previous && !trusted) throw new Error("Evaluation Contract stages cannot move backwards without a bound assessment");
    const history = [...((current.stage_history as JsonObject[] | undefined) ?? [])];
    const entry = { stage: input.stage, evidence, metrics: input.metrics ?? {}, verification: trusted ? "trusted" : "reported" };
    const recordedIndex = history.findIndex(item => item.stage === input.stage);
    if (recordedIndex < 0) history.push(entry);
    else history[recordedIndex] = entry;
    const reportedStage = stageIndex(input.stage) > previous ? input.stage : reported;
    const verifiedStage = trusted && stageIndex(input.stage) > priorVerified ? input.stage : current.verified_stage ?? null;
    return this.store.save("evaluation_contract", input.contract_id, { ...current,
      status: verifiedStage ?? "defined", reported_stage: reportedStage,
      verified_stage: verifiedStage,
      stage_history: history, latest_metrics: input.metrics ?? current.latest_metrics ?? {} });
  }

  get(contractId: string): JsonObject {
    const contract = this.store.get("evaluation_contract", contractId);
    return { contract, stages: EVALUATION_STAGES, routeable: contract.verified_stage === "routeable" };
  }
}

function requireTaskEffectContract(value: unknown, store: CraftStore): TaskEffectContract {
  validateTaskEffectContract(value, store);
  return value;
}

function validateTaskEffectContract(value: unknown, store: CraftStore): asserts value is TaskEffectContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Task-effect contract must be an object");
  const spec = value as TaskEffectContract;
  if (typeof spec.candidate_family !== "string" || !spec.candidate_family.trim() || (spec.cohort_id !== undefined && (typeof spec.cohort_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(spec.cohort_id))) || !isRecordRef(spec.baseline_ref) || !isRecordRef(spec.candidate_ref) || spec.baseline_ref.kind !== spec.candidate_family || spec.candidate_ref.kind !== spec.candidate_family ||
      typeof spec.environment_fingerprint !== "string" || !spec.environment_fingerprint.trim() || !spec.task_set || typeof spec.task_set.id !== "string" || !spec.task_set.id.trim() ||
      !Array.isArray(spec.task_set.development_task_refs) || !spec.task_set.development_task_refs.length || !Array.isArray(spec.task_set.held_out_task_refs) || !spec.task_set.held_out_task_refs.length ||
      !spec.evaluator || typeof spec.evaluator.id !== "string" || !spec.evaluator.id.trim() || typeof spec.evaluator.version !== "string" || !spec.evaluator.version.trim() || typeof spec.evaluator.digest !== "string" || !spec.evaluator.digest.trim() || typeof spec.evaluator.public_key_pem !== "string" || !spec.evaluator.public_key_pem.trim() ||
      !spec.primary_metric || typeof spec.primary_metric.name !== "string" || !spec.primary_metric.name.trim() || !["higher", "lower"].includes(spec.primary_metric.direction) || !Number.isFinite(spec.primary_metric.minimum_delta) || spec.primary_metric.minimum_delta < 0 ||
      !Number.isFinite(spec.latency_budget_ms) || spec.latency_budget_ms <= 0 || !Number.isFinite(spec.cost_budget) || spec.cost_budget < 0 ||
      !Array.isArray(spec.hard_assertions) || spec.hard_assertions.length === 0 || spec.hard_assertions.some(item => typeof item !== "string" || !item.trim()) || new Set(spec.hard_assertions).size !== spec.hard_assertions.length ||
      !spec.tolerated_regressions || !Object.entries(spec.tolerated_regressions).every(([name, tolerance]) => name.trim() && Number.isFinite(tolerance) && tolerance >= 0)) {
    throw new Error("Task-effect contract must freeze valid stored artifacts, Host tasks, evaluator, thresholds, budgets and hard assertions");
  }
  assertArtifactRef(store, spec.baseline_ref, spec.candidate_family);
  assertArtifactRef(store, spec.candidate_ref, spec.candidate_family);
  validateTaskEffectSamplePlan({ candidate_family: spec.candidate_family, environment_fingerprint: spec.environment_fingerprint,
    primary_metric: spec.primary_metric, held_out_task_refs: spec.task_set.held_out_task_refs, evaluator_public_key_pem: spec.evaluator.public_key_pem }, spec.sample_plan);
  const development = spec.task_set.development_task_refs, heldOut = spec.task_set.held_out_task_refs;
  if (!development.every(ref => validTaskRef(store, ref)) || !heldOut.every(ref => validTaskRef(store, ref)) ||
      new Set([...development, ...heldOut].map(ref => `${ref.kind}/${ref.id}@${ref.version}`)).size !== development.length + heldOut.length ||
      spec.task_set.digest !== digestJson({ id: spec.task_set.id, development_task_refs: development, held_out_task_refs: heldOut })) {
    throw new Error("Task-effect task set must bind unique stored task versions and its exact digest");
  }
}

function finiteMetrics(metrics: Record<string, number>): boolean { return Boolean(metrics) && typeof metrics === "object" && Object.values(metrics).every(Number.isFinite); }
function mean(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function parseTaskEffectEvaluationInput(value: JsonObject): TaskEffectEvaluationInput {
  const text = (item: unknown): item is string => typeof item === "string" && !!item.trim();
  const ref = (item: unknown): item is EvaluationRecordRef => isRecordRef(item);
  const evaluator = value.evaluator;
  const pairs = value.pairs;
  if (!text(value.contract_id) || !text(value.evaluation_id) || !ref(value.candidate_ref) || !Array.isArray(value.candidate_source_task_refs) ||
      !value.candidate_source_task_refs.every(ref) || !evaluator || typeof evaluator !== "object" || Array.isArray(evaluator) ||
      !text((evaluator as JsonObject).id) || !text((evaluator as JsonObject).version) || !text((evaluator as JsonObject).digest) || !text((evaluator as JsonObject).public_key_pem) || !text(value.evaluator_signature) ||
      !Array.isArray(pairs) || !pairs.every(isTaskEffectPair)) throw new Error("Task-effect evaluation input must use typed artifact, task and Host session references with signed pairs");
  return { contract_id: value.contract_id, evaluation_id: value.evaluation_id, candidate_ref: value.candidate_ref,
    candidate_source_task_refs: value.candidate_source_task_refs, evaluator: evaluator as TaskEffectContract["evaluator"],
    evaluator_signature: value.evaluator_signature, pairs };
}
function isTaskEffectPair(value: unknown): value is TaskEffectPair {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pair = value as JsonObject, baseline = pair.baseline, candidate = pair.candidate;
  return isRecordRef(pair.case_ref) && (pair.repeat_index === undefined || Number.isSafeInteger(pair.repeat_index) && Number(pair.repeat_index) > 0) && validMeasurementArm(baseline) && validMeasurementArm(candidate);
}
function validMeasurementArm(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const arm = value as JsonObject, metrics = arm.metrics, assertions = arm.assertions;
  return isRecordRef(arm.session_ref) && Boolean(metrics) && typeof metrics === "object" && !Array.isArray(metrics) && Object.values(metrics as Record<string, unknown>).every(item => typeof item === "number" && Number.isFinite(item)) &&
    typeof arm.latency_ms === "number" && Number.isFinite(arm.latency_ms) && arm.latency_ms >= 0 && typeof arm.cost === "number" && Number.isFinite(arm.cost) && arm.cost >= 0 &&
    Boolean(assertions) && typeof assertions === "object" && !Array.isArray(assertions) && Object.values(assertions as Record<string, unknown>).every(item => typeof item === "boolean");
}
function isRecordRef(value: unknown): value is EvaluationRecordRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as EvaluationRecordRef;
  return typeof ref.kind === "string" && !!ref.kind.trim() && typeof ref.id === "string" && !!ref.id.trim() && Number.isSafeInteger(ref.version) && ref.version > 0 && typeof ref.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(ref.digest);
}
function sameRef(left: EvaluationRecordRef, right: EvaluationRecordRef): boolean {
  return left.kind === right.kind && left.id === right.id && left.version === right.version && left.digest === right.digest;
}
function taskDigest(record: JsonObject): string {
  const payload = Object.fromEntries(Object.entries(record).filter(([key]) => !["id", "version", "created_at", "updated_at"].includes(key)).sort(([a], [b]) => a.localeCompare(b)));
  return digestJson({ kind: "task", id: record.id, version: record.version, payload });
}
function taskRef(store: CraftStore, requested: Pick<EvaluationRecordRef, "kind" | "id" | "version">): EvaluationRecordRef {
  if (requested.kind !== "task") throw new Error("Task reference kind must be task");
  const record = store.get("task", requested.id, requested.version);
  return { kind: "task", id: String(record.id), version: Number(record.version), digest: taskDigest(record) };
}
function validTaskRef(store: CraftStore, ref: EvaluationRecordRef): boolean {
  try { return isRecordRef(ref) && sameRef(taskRef(store, ref), ref); } catch { return false; }
}
function artifactDigest(record: JsonObject): string | null {
  for (const field of ["definition_digest", "content_digest", "source_revision_digest", "identity_digest", "source_digest"]) {
    const digest = record[field];
    if (typeof digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(digest)) return digest;
  }
  return null;
}
function artifactRef(store: CraftStore, requested: Pick<EvaluationRecordRef, "kind" | "id" | "version">): EvaluationRecordRef {
  if (typeof requested.kind !== "string" || !requested.kind.trim() || typeof requested.id !== "string" || !requested.id.trim() || !Number.isSafeInteger(requested.version) || requested.version < 1) throw new Error("Artifact reference must bind kind, id and version");
  const record = store.get(requested.kind, requested.id, requested.version), digest = artifactDigest(record);
  if (!digest) throw new Error("Candidate artifact record has no stable content or definition digest");
  return { kind: requested.kind, id: String(record.id), version: Number(record.version), digest };
}
function assertArtifactRef(store: CraftStore, ref: EvaluationRecordRef, expectedKind: string): void {
  if (!isRecordRef(ref) || ref.kind !== expectedKind || !sameRef(artifactRef(store, ref), ref)) throw new Error("Candidate artifact reference does not match the exact stored version and digest");
}
function hostIdentity(session: JsonObject) {
  return { trace_id: session.trace_id, task_id: session.task_id, host_id: session.host_id, environment_fingerprint: session.environment_fingerprint,
    policy_fingerprint: session.policy_fingerprint, capability_fingerprint: session.capability_fingerprint, model_fingerprint: session.model_fingerprint ?? null, budget_fingerprint: session.budget_fingerprint ?? null };
}
function hostEventIdentity(event: JsonObject) {
  return { session_id: event.session_id, sequence: event.sequence, kind: event.kind, host_id: event.host_id, action_contract_ref: event.action_contract_ref ?? null,
    state_before_ref: event.state_before_ref ?? null, state_after_ref: event.state_after_ref ?? null, artifact_refs: event.artifact_refs,
    evidence_refs: event.evidence_refs, summary_digest: event.summary_digest ?? null };
}
function traceEventIdentity(event: JsonObject) {
  return { trace_id: event.trace_id, sequence: event.sequence, event_kind: event.event_kind, actor: event.actor, source: event.source, trust: event.trust,
    span_id: event.span_id, parent_span_id: event.parent_span_id ?? null, operation_id: event.operation_id ?? null, action_contract: event.action_contract ?? null,
    state_before: event.state_before ?? null, state_after: event.state_after ?? null, input_refs: event.input_refs, output_refs: event.output_refs,
    capability_revision: event.capability_revision ?? null, policy_revision: event.policy_revision ?? null, model_fingerprint: event.model_fingerprint ?? null,
    environment_fingerprint: event.environment_fingerprint ?? null, workspace_before: event.workspace_before ?? null, workspace_after: event.workspace_after ?? null,
    usage: event.usage ?? null, cost_usd: event.cost_usd ?? null, duration_ms: event.duration_ms ?? null, error_class: event.error_class ?? null,
    status: event.status ?? null, summary: event.summary ?? null, data_digest: event.data_digest, content_stored: event.content_stored };
}
function hostSessionRef(store: CraftStore, requested: Pick<EvaluationRecordRef, "kind" | "id" | "version">): EvaluationRecordRef {
  if (requested.kind !== "host_session") throw new Error("Host session reference kind must be host_session");
  const session = store.get("host_session", requested.id, requested.version), identity = hostIdentity(session);
  if (session.identity_digest !== digestJson(identity) || session.status !== "terminal") throw new Error("Host session identity or terminal status is invalid");
  const events = store.list("host_session_event", 10_000, item => item.session_id === session.id && Number(item.sequence) === Number(session.next_sequence));
  if (events.length !== 1 || events[0]!.kind !== "session.completed" || events[0]!.event_digest !== digestJson(hostEventIdentity(events[0]!))) throw new Error("Host session has no valid completed event receipt");
  const receipt = events[0]!, traceEvent = store.get("trace_event", String(receipt.trace_event_id), Number(receipt.trace_event_version));
  const traceIdentity = traceEventIdentity(traceEvent);
  if (traceEvent.source !== "host_session" || traceEvent.trust !== "observed" || traceEvent.event_kind !== receipt.kind || traceEvent.trace_id !== session.trace_id ||
      traceEvent.event_digest !== stableDigest(traceIdentity) || traceEvent.data_digest !== stableDigest({ session_id: session.id, session_sequence: receipt.sequence, event_digest: receipt.event_digest }) ||
      !Array.isArray(traceEvent.output_refs) || JSON.stringify(traceEvent.output_refs) !== JSON.stringify([...(receipt.artifact_refs as string[]), ...(receipt.evidence_refs as string[])])) throw new Error("Host session trace receipt is invalid");
  const digest = digestJson({ kind: "host_session", id: session.id, version: session.version, identity_digest: session.identity_digest,
    host_event: { id: receipt.id, version: receipt.version, event_digest: receipt.event_digest }, trace_event: { id: traceEvent.id, version: traceEvent.version, event_digest: traceEvent.event_digest } });
  return { kind: "host_session", id: String(session.id), version: Number(session.version), digest };
}
function validHostSessionRef(store: CraftStore, ref: EvaluationRecordRef, task: EvaluationRecordRef, environmentFingerprint: string): boolean {
  try {
    const resolved = hostSessionRef(store, ref), session = store.get("host_session", ref.id, ref.version);
    return sameRef(resolved, ref) && session.task_id === task.id && session.environment_fingerprint === environmentFingerprint;
  } catch { return false; }
}
function validHeldOutPairs(store: CraftStore, spec: TaskEffectContract, pairs: TaskEffectPair[]): boolean {
  const expected = expectedTaskEffectPairKeys(spec.task_set.held_out_task_refs, spec.sample_plan.repeats_per_task);
  const actual = pairs.map(pair => actualTaskEffectPairKey(pair)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
  const sessionRefs = pairs.flatMap(pair => [pair.baseline.session_ref, pair.candidate.session_ref]);
  const sessionIds = sessionRefs.map(ref => `${ref.id}@${ref.version}`);
  return new Set(sessionIds).size === sessionIds.length && pairs.every(pair => spec.task_set.held_out_task_refs.some(ref => sameRef(ref, pair.case_ref))
    && validTaskRef(store, pair.case_ref)
    && validHostSessionRef(store, pair.baseline.session_ref, pair.case_ref, spec.environment_fingerprint)
    && validHostSessionRef(store, pair.candidate.session_ref, pair.case_ref, spec.environment_fingerprint));
}
function computeTaskEffectResult(spec: TaskEffectContract, pairs: TaskEffectPair[]) {
  const primary = spec.primary_metric, baseline = mean(pairs.map(pair => pair.baseline.metrics[primary.name])), candidate = mean(pairs.map(pair => pair.candidate.metrics[primary.name]));
  const delta = primary.direction === "higher" ? candidate - baseline : baseline - candidate;
  const regressionsPass = Object.entries(spec.tolerated_regressions).every(([name, tolerance]) => mean(pairs.map(pair => pair.candidate.metrics[name])) - mean(pairs.map(pair => pair.baseline.metrics[name])) <= tolerance);
  const hardAssertionsPass = spec.hard_assertions.every(name => pairs.every(pair => pair.baseline.assertions[name] === true && pair.candidate.assertions[name] === true));
  const latency = mean(pairs.map(pair => pair.candidate.latency_ms)), cost = mean(pairs.map(pair => pair.candidate.cost));
  return { eligible: delta >= primary.minimum_delta && regressionsPass && hardAssertionsPass && latency <= spec.latency_budget_ms && cost <= spec.cost_budget,
    primary_metric: primary.name, baseline, candidate, delta, latency_ms: latency, cost, regressions_pass: regressionsPass, hard_assertions_pass: hardAssertionsPass };
}

function validTaskEffectEvaluation(store: CraftStore, spec: TaskEffectContract, report: JsonObject): boolean {
  try {
    const pairs = report.pairs as TaskEffectPair[], sourceRefs = report.candidate_source_task_refs as EvaluationRecordRef[];
    if (!Array.isArray(pairs) || !Array.isArray(sourceRefs) || sourceRefs.length === 0 || sourceRefs.some(ref => !spec.task_set.development_task_refs.some(item => sameRef(item, ref)) || !validTaskRef(store, ref))) return false;
    if (!validHeldOutPairs(store, spec, pairs)) return false;
    if (!pairs.every(pair => finiteMetrics(pair.baseline.metrics) && finiteMetrics(pair.candidate.metrics) &&
      Number.isFinite(pair.baseline.latency_ms) && Number.isFinite(pair.candidate.latency_ms) && Number.isFinite(pair.baseline.cost) && Number.isFinite(pair.candidate.cost))) return false;
    if (!isRecordRef(report.candidate_ref) || !sameRef(report.candidate_ref, spec.candidate_ref)) return false;
    assertArtifactRef(store, report.candidate_ref, spec.candidate_family);
    if (digestJson(report.evaluator) !== digestJson(spec.evaluator)) return false;
    const signedInput = { contract_id: report.contract_id, evaluation_id: report.evaluation_id, candidate_ref: report.candidate_ref,
      candidate_source_task_refs: report.candidate_source_task_refs, evaluator: report.evaluator, pairs: report.pairs };
    const receiptDigest = digestJson({ contract_digest: report.contract_digest, ...signedInput });
    if (!verifySignature(null, Buffer.from(receiptDigest), spec.evaluator.public_key_pem, Buffer.from(String(report.evaluator_signature), "base64"))) return false;
    const result = computeTaskEffectResult(spec, pairs);
    const expectedDigest = digestJson({ contract_digest: report.contract_digest, contract_id: report.contract_id, evaluation_id: report.evaluation_id,
      candidate_ref: report.candidate_ref, candidate_source_task_refs: report.candidate_source_task_refs, evaluator: report.evaluator,
      evaluator_signature: report.evaluator_signature, pairs: report.pairs, eligible: result.eligible });
    return report.result !== null && digestJson(report.result) === digestJson(result) && report.evaluation_digest === expectedDigest;
  } catch { return false; }
}
