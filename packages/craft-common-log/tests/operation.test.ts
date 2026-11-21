import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  currentOperation, observeMethods, observedKernel, observeOperation, operationErrorCode, operationPersistenceEnabled,
  operationResultStatus, withoutOperationPersistence, type OperationEvent,
} from "../src/operation.ts";
import { StoreTelemetrySink } from "../src/store-sink.ts";
import { CraftStore } from "craft-common-store-local/store";
import { craftPaths } from "craft-common-store-local/paths";

const stores: CraftStore[] = [];
const directories: string[] = [];
async function store(): Promise<CraftStore> {
  const directory = mkdtempSync(join(tmpdir(), "craft-operation-"));
  directories.push(directory);
  const opened = await new CraftStore(craftPaths(directory)).open();
  stores.push(opened);
  return opened;
}
test.after(() => {
  for (const opened of stores) opened.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

test("operationErrorCode maps failures to stable categories", () => {
  assert.equal(operationErrorCode({ code: "ERR_SQLITE_ERROR", errcode: 5 }), "STORAGE_BUSY");
  assert.equal(operationErrorCode({ code: "ERR_SQLITE_ERROR", errcode: 6 }), "STORAGE_BUSY");
  assert.equal(operationErrorCode({ code: "ERR_SQLITE_ERROR", errcode: 1 }), "ERR_SQLITE_ERROR");
  assert.equal(operationErrorCode(new Error("database is locked")), "STORAGE_BUSY");
  assert.equal(operationErrorCode(new Error("sqlite_busy")), "STORAGE_BUSY");
  assert.equal(operationErrorCode({ code: "EACCES" }), "EACCES");
  assert.equal(operationErrorCode({ code: "NOT_A_CODE" }), "OPERATION_FAILED");
  assert.equal(operationErrorCode(new Error("permission denied")), "ACCESS_DENIED");
  assert.equal(operationErrorCode(new Error("state drift")), "STATE_CONFLICT");
  assert.equal(operationErrorCode(new Error("budget exceeded")), "LIMIT_EXCEEDED");
  assert.equal(operationErrorCode(new Error("provider unavailable")), "UNAVAILABLE");
  assert.equal(operationErrorCode(new Error("invalid input")), "INVALID_INPUT");
  assert.equal(operationErrorCode(new Error("something else")), "OPERATION_FAILED");
  assert.equal(operationErrorCode("plain"), "OPERATION_FAILED");
});

test("operationResultStatus distinguishes every documented outcome", () => {
  assert.equal(operationResultStatus({ denied: true }), "denied");
  assert.equal(operationResultStatus({ isError: true }), "failed");
  assert.equal(operationResultStatus({ valid: false }), "failed");
  assert.equal(operationResultStatus({ status: "failed" }), "failed");
  assert.equal(operationResultStatus({ partial: true }), "partial");
  assert.equal(operationResultStatus({ receipt: { partial: true } }), "partial");
  for (const status of ["unavailable", "blocked", "disabled", "skipped", "empty", "inconclusive"]) assert.equal(operationResultStatus({ status }), status);
  assert.equal(operationResultStatus({ codebase: { status: "unavailable" } }), "partial");
  assert.equal(operationResultStatus({ manifest_status: "unavailable" }), "partial");
  assert.equal(operationResultStatus({}), "completed");
});

test("observeOperation records started/completed and persists through the store sink", async () => {
  const opened = await store();
  const events: OperationEvent[] = [];
  const value = observeOperation(opened, "cap", "read", { id: "input" }, () => ({ receipt: { id: "out" }, claim: { id: "claim" } }), {
    observe: event => events.push(event),
  });
  assert.deepEqual(value, { receipt: { id: "out" }, claim: { id: "claim" } });
  assert.deepEqual(events.map(event => event.phase), ["started", "completed"]);
  assert.deepEqual(events[1]!.refs, ["out", "claim"]);
  assert.equal(events[0]!.event.attributes.input_digest !== undefined, true);
  const persisted = new StoreTelemetrySink(opened).list(events[0]!.event.trace_id);
  assert.equal(persisted.length, 2);
  assert.equal(currentOperation(opened), undefined);
  assert.equal(operationPersistenceEnabled(opened), true);
});

test("observeOperation extracts nested input/output references", async () => {
  const opened = await store();
  const events: OperationEvent[] = [];
  observeOperation(opened, "cap", "nested", { args: [{ receipt: { id: "in" } }, "ignored"] }, () => ({
    args: [{ receipt: { id: "out" }, pack_receipt: { id: "pack" }, working_set: { id: "set" }, procedure: { id: "proc" }, invocation: { id: "inv" },
      run: { id: "run" }, observation: { id: "obs" }, evidence: { id: "ev" }, claim: { id: "cl" }, source: { id: "src" }, memory: { id: "mem" },
      index: { id: "idx" }, workspace: { id: "ws" }, artifact: { id: "art" }, document: { id: "doc" }, dispatch: { id: "disp" },
      request: { id: "req" }, candidate: { id: "cand" }, proposal: { id: "prop" }, support: { id: "sup" },
      receipt_id: "r", invocation_id: "i", procedure_id: "p", workspace_id: "w", index_id: "x", snapshot_id: "snap", task_id: "task", task_run_id: "taskrun",
      evidence_id: "evid", source_id: "srcid", memory_id: "memid", claim_id: "claimid", dispatch_id: "dispid", request_id: "reqid", candidate_id: "candid",
      proposal_id: "propid", support_id: "supid", input_refs: { a: "in1", b: "bad value" }, output_refs: { a: "out1" } }],
  }), { observe: event => events.push(event) });
  assert.deepEqual(events[0]!.refs, ["in"]);
  assert.equal(events[1]!.refs.length, 8);
});

test("observeOperation reports non-completed statuses as unverified", async () => {
  const opened = await store();
  const events: OperationEvent[] = [];
  observeOperation(opened, "cap", "empty", {}, () => ({ status: "empty" }), { observe: event => events.push(event) });
  assert.equal(events[1]!.event.outcome, "unverified");
  observeOperation(opened, "cap", "denied", {}, () => ({ denied: true }), { observe: event => events.push(event) });
  assert.equal(events[3]!.event.outcome, "failed");
});

test("observeOperation supports sync failure, async success and async failure", async () => {
  const opened = await store();
  const events: OperationEvent[] = [];
  assert.throws(() => observeOperation(opened, "cap", "sync", {}, () => { throw new Error("denied"); }, { observe: event => events.push(event) }), /denied/u);
  assert.equal(events[1]!.phase, "failed");
  assert.equal(events[1]!.event.attributes.reason_code, "ACCESS_DENIED");
  const ok = await observeOperation(opened, "cap", "async", {}, async () => 7, { observe: event => events.push(event) });
  assert.equal(ok, 7);
  assert.equal(events[3]!.phase, "completed");
  await assert.rejects(observeOperation(opened, "cap", "async-fail", {}, async () => { throw new Error("timeout"); }, { observe: event => events.push(event) }), /timeout/u);
  assert.equal(events[5]!.event.attributes.reason_code, "OPERATION_FAILED");
});

test("observeOperation records storage busy diagnostics", async () => {
  const opened = await store();
  const events: OperationEvent[] = [];
  const error = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5,
    safeDetails: { database_role: "primary", phase: "transaction_begin", busy_timeout_ms: 100, waited_ms: 20, retryable: true, ignored: "x" } });
  assert.throws(() => observeOperation(opened, "cap", "busy", {}, () => { throw error; }, { observe: event => events.push(event) }), /locked/u);
  assert.equal(events[1]!.event.attributes.database_role, "primary");
  assert.equal(events[1]!.event.attributes.database_phase, "transaction_begin");
  assert.equal(events[1]!.event.attributes.busy_timeout_ms, 100);
  assert.equal(events[1]!.event.attributes.waited_ms, 20);
  assert.equal(events[1]!.event.attributes.retryable, true);
  assert.equal("ignored" in events[1]!.event.attributes, false);
  const invalid = Object.assign(new Error("busy"), { safeDetails: { database_role: "other", phase: "other", busy_timeout_ms: 99999, waited_ms: -1, retryable: "yes" } });
  assert.throws(() => observeOperation(opened, "cap", "busy", {}, () => { throw invalid; }, { observe: event => events.push(event) }), /busy/u);
  assert.equal(events[3]!.event.attributes.database_role, undefined);
  const partition = Object.assign(new Error("sqlite_busy"), { safeDetails: { database_role: "capability_partition", phase: "savepoint_operation" } });
  assert.throws(() => observeOperation(opened, "cap", "busy", {}, () => { throw partition; }, { observe: event => events.push(event) }), /sqlite_busy/u);
  assert.equal(events[5]!.event.attributes.database_role, "capability_partition");
  assert.equal(events[5]!.event.attributes.database_phase, "savepoint_operation");
});

test("observer and sink failures are reported without masking the business result", async () => {
  const opened = await store();
  const failures: unknown[] = [];
  const result = observeOperation(opened, "cap", "op", {}, () => 1, {
    observe: () => { throw new Error("observer"); },
    onError: error => failures.push(error),
  });
  assert.equal(result, 1);
  assert.equal(failures.length, 2);
  const suppressed = observeOperation(opened, "cap", "op", {}, () => 2, { onError: () => { throw new Error("suppressed"); } });
  assert.equal(suppressed, 2);
  assert.throws(() => observeOperation(opened, "cap", "op", {}, () => 3, { observe: () => { throw new Error("observer"); }, onError: () => { throw new Error("sink"); } }), /sink/u);
});

test("withoutOperationPersistence emits but does not persist telemetry", async () => {
  const opened = await store();
  const events: OperationEvent[] = [];
  const value = withoutOperationPersistence(opened, () => {
    assert.equal(operationPersistenceEnabled(opened), false);
    return observeOperation(opened, "cap", "read", {}, () => ({ memory: { id: "m" } }), { observe: event => events.push(event) });
  });
  assert.deepEqual(value, { memory: { id: "m" } });
  assert.equal(events.length, 2);
  assert.equal(new StoreTelemetrySink(opened).list(events[0]!.event.trace_id).length, 0);
});

test("operation context is scoped to one store root", async () => {
  const first = await store(), second = await store();
  const events: OperationEvent[] = [];
  withoutOperationPersistence(first, () => {
    assert.equal(currentOperation(first)?.persist, false);
    assert.equal(currentOperation(second), undefined);
    observeOperation(second, "cap", "op", {}, () => 1, { observe: event => events.push(event) });
  });
  assert.equal(events.length, 2);
  assert.equal(events[0]!.event.attributes.stage, "started");
});

test("withoutOperationPersistence inherits the parent trace and callbacks", async () => {
  const opened = await store();
  const events: OperationEvent[] = [];
  const observed = observeOperation(opened, "cap", "parent", {}, () => withoutOperationPersistence(opened, () => {
    observeOperation(opened, "cap", "child", {}, () => ({ memory: { id: "m" } }));
  }), { observe: event => events.push(event) });
  assert.equal(observed === undefined, true);
  assert.ok(events.some(event => event.phase === "completed" && event.event.operation === "child"));
});

test("observeOperation reports sink failures while returning the business value", async () => {
  const opened = await store();
  const failures: unknown[] = [];
  const result = observeOperation(opened, "cap", "op", {}, () => 1, { observe: () => { throw new Error("observer"); }, onError: error => failures.push(error) });
  assert.equal(result, 1);
  assert.ok(failures.length >= 1);
});

test("observeOperation reports a store sink failure through onError", async () => {
  const opened = await store();
  opened.close();
  const failures: unknown[] = [];
  const result = observeOperation(opened, "cap", "closed", {}, () => 1, { onError: error => failures.push(error) });
  assert.equal(result, 1);
  assert.ok(failures.some(error => error instanceof Error && /not open/u.test(error.message)));
});

test("observeOperation digests undefined inputs and non-Error throws", async () => {
  const opened = await store();
  const events: OperationEvent[] = [];
  observeOperation(opened, "cap", "undefined", undefined, () => undefined, { observe: event => events.push(event) });
  assert.match(String(events[0]!.event.attributes.input_digest), /^sha256:/u);
  assert.match(String(events[1]!.event.attributes.result_digest), /^sha256:/u);
  assert.throws(() => observeOperation(opened, "cap", "plain", {}, () => { throw "plain"; }, { observe: event => events.push(event) }), /plain/u);
  assert.match(String(events[3]!.event.attributes.error_digest), /^sha256:/u);
});

test("observeMethods visits inherited methods once", async () => {
  const opened = await store();
  const captured: string[] = [];
  class Base { read(): string { return "base"; } }
  class Child extends Base { write(): string { return "child"; } }
  const target = new Child();
  observeMethods(target, opened, name => name, (component, name, _args, run) => {
    captured.push(`${component}:${name}`);
    return run();
  });
  assert.equal(target.read(), "base");
  assert.equal(target.write(), "child");
  assert.deepEqual(captured.sort(), ["read:read", "write:write"]);
});

test("observeMethods instruments selected prototype methods and preserves sync returns", async () => {
  const opened = await store();
  const events: OperationEvent[] = [];
  class Facade {
    value = 1;
    read(input: number): number { return this.value + input; }
    ignored(): string { return "ignored"; }
  }
  const facade = new Facade();
  observeMethods(facade, opened, name => name === "read" ? "facade" : null, undefined);
  assert.equal(facade.read(2), 3);
  assert.equal(facade.ignored(), "ignored");
  assert.equal(events.length, 0);
  const captured: string[] = [];
  const other = new Facade();
  observeMethods(other, opened, name => name === "read" ? "facade" : null, (component, name, args, run) => {
    captured.push(`${component}:${name}:${String(args[0])}`);
    return run();
  });
  assert.equal(other.read(5), 6);
  assert.deepEqual(captured, ["facade:read:5"]);
});

test("observedKernel wraps public methods only and caches wrappers", async () => {
  const opened = await store();
  const events: OperationEvent[] = [];
  class Kernel {
    field = "x";
    compute(value: number): number { return value * 2; }
    get computed(): number { return 3; }
  }
  const observed = observedKernel(opened, "kernel", new Kernel());
  assert.equal(observed.field, "x");
  assert.equal(observed.compute(4), 8);
  assert.equal(observed.compute(5), 10);
  assert.equal(observed.computed, 3);
  assert.equal(observed.constructor, Kernel);
  assert.equal(events.length, 0);
  const persisted = new StoreTelemetrySink(opened).list("missing");
  assert.deepEqual(persisted, []);
});

test("observedKernel persists each public call through the store sink", async () => {
  const opened = await store();
  class Kernel { compute(value: number): number { return value; } }
  const observed = observedKernel(opened, "kernel", new Kernel());
  assert.equal(observed.compute(1), 1);
  const rows = opened.list("telemetry_event", 10, item => item.capability_id === "kernel");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => (row as { attributes: { stage: string } }).attributes.stage).sort(), ["completed", "started"]);
});

test("observedKernel caches and records configuration methods", async () => {
  const opened = await store();
  class Kernel {
    configured = false;
    setReferenceSources(): void { this.configured = true; }
  }
  const observed = observedKernel(opened, "kernel", new Kernel());
  assert.equal(observed.setReferenceSources, observed.setReferenceSources);
  observed.setReferenceSources();
  assert.equal(observed.configured, true);
  const rows = opened.list("telemetry_event", 10, item => item.capability_id === "kernel");
  assert.equal(rows.length, 2);
  assert(rows.every(item => item.operation === "Kernel.setReferenceSources"));
});
