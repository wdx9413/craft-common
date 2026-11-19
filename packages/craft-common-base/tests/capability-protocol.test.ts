import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCapabilityRegistry, CONTEXT_MEMBERS, CONTEXT_MEMBER_SOURCES, CONTEXT_SOURCES, contributesContext, CORE_KERNELS,
  EVAL_DOMAINS, GATING_PHASES, HARNESS_HOOK_PHASE_MAP, HARNESS_HOOK_POINTS, HOOK_PHASES, orderHooks, pluggableMembers, runPhase,
  type CraftCapability, type Hook, type HookContext, type HookOutcome,
} from "../src/capability-protocol.ts";

function hook(name: string, phase: Hook["phase"], extra: Partial<Hook> = {}): Hook {
  return { name, phase, order: 1, run: async () => ({ kind: "observed", refs: [] }), ...extra };
}

function capability(name: string, extra: Partial<CraftCapability> = {}): CraftCapability {
  return { name, owns: /^x_/u, register: () => undefined, ...extra };
}

test("context membership classifies built-in and pluggable members", () => {
  assert.deepEqual([...CONTEXT_MEMBERS], ["history", "knowledge", "memory", "experience", "state"]);
  assert.deepEqual([...CONTEXT_SOURCES], ["host_provided", "accumulated", "current"]);
  assert.deepEqual(pluggableMembers(), ["knowledge", "memory", "experience"]);
  assert.equal(CONTEXT_MEMBER_SOURCES.history, "host_provided");
  assert.equal(CONTEXT_MEMBER_SOURCES.state, "current");
  assert.deepEqual([...EVAL_DOMAINS], ["coding", "quant", "writing"]);
});

test("hook phases, gates and harness points stay aligned", () => {
  assert.deepEqual([...GATING_PHASES], ["permission_check", "tool_before"]);
  assert.deepEqual(HARNESS_HOOK_POINTS.map(point => HARNESS_HOOK_PHASE_MAP[point]), [
    "context_resolve", "capability_discover", "permission_check", "tool_before", "tool_after", "tool_after",
    "permission_check", "task_settle", "task_settle",
  ]);
  assert.deepEqual(Object.keys(CORE_KERNELS), ["store", "modelProviders", "telemetry", "traceReader"]);
  assert.ok(HOOK_PHASES.length > 0);
});

test("contributesContext only accepts accumulated task settlement hooks", () => {
  assert.equal(contributesContext(hook("a", "task_settle", { writes: ["knowledge"] })), true);
  assert.equal(contributesContext(hook("a", "task_settle")), false);
  assert.equal(contributesContext(hook("a", "task_settle", { writes: [] })), false);
  assert.equal(contributesContext(hook("a", "tool_before", { writes: ["knowledge"] })), false);
});

test("registry provides, requires and optionally resolves kernels", () => {
  const { registry } = buildCapabilityRegistry([capability("a", {
    register: (target) => { target.provide("a.kernel", { value: 1 }); assert.equal(target.optional("missing"), undefined); },
  })], { store: { id: "store" } });
  assert.deepEqual(registry.require("store"), { id: "store" });
  assert.deepEqual(registry.require("a.kernel"), { value: 1 });
  assert.throws(() => registry.require("absent"), /kernel is not registered: absent/u);
  assert.throws(() => registry.provide("", 1), /kernel name must not be empty/u);
  assert.throws(() => registry.provide("store", 1), /kernel already registered: store/u);
});

test("registry rejects duplicate capabilities and product capabilities without evaluation", () => {
  assert.throws(() => buildCapabilityRegistry([capability("a"), capability("a")]), /already registered: a/u);
  assert.throws(() => buildCapabilityRegistry([capability("p", { product: "P" })]), /requires an Evaluation Contract/u);
  const { hooks } = buildCapabilityRegistry([capability("p", {
    product: "P", evaluation: { input_contract: "i", output_contract: "o", fixture_id: "f", host_compatibility: [] },
  })]);
  assert.deepEqual(hooks, []);
});

test("registry collects contributions in order and rejects duplicate members", () => {
  const provider = (name: string, member: "knowledge" | "memory", items: readonly unknown[] = []) => ({
    name,
    owns: /^x_/u,
    register: () => undefined,
    contributes: () => ({ member, contribute: async () => ({ member, items, receipt_id: member, omitted_count: 0 }) }),
  }) satisfies CraftCapability;
  const built = buildCapabilityRegistry([provider("knowledge-provider", "knowledge", [1]), provider("memory-provider", "memory")]);
  assert.deepEqual(built.contributed.map(item => item.member), ["knowledge", "memory"]);
  assert.throws(() => buildCapabilityRegistry([provider("knowledge-a", "knowledge"), provider("knowledge-b", "knowledge")]), /two capabilities contribute the same context member/u);
});

test("registry rejects contributions for non-accumulated members", () => {
  const contribution = (member: "history" | "state") => ({ name: `bad-${member}`, owns: /^x_/u, register: () => undefined,
    contributes: () => ({ member, contribute: async () => ({ member, items: [], receipt_id: member, omitted_count: 0 }) }) } satisfies CraftCapability);
  assert.throws(() => buildCapabilityRegistry([contribution("history")]), /history is host_provided/u);
  assert.throws(() => buildCapabilityRegistry([contribution("state")]), /state is current/u);
});

test("registry validates hook names, phases and context declarations", () => {
  assert.throws(() => buildCapabilityRegistry([capability("a", { hooks: [hook("h", "task_settle")] }), capability("b", { hooks: [hook("h", "task_settle")] })]), /hook already registered: h/u);
  assert.throws(() => buildCapabilityRegistry([capability("a", { hooks: [hook("h", "unknown" as never)] })]), /declares an unknown phase/u);
  assert.throws(() => buildCapabilityRegistry([capability("a", { hooks: [hook("h", "tool_before", { writes: ["knowledge"] })] })]), /declares writes at phase tool_before/u);
  assert.throws(() => buildCapabilityRegistry([capability("a", { hooks: [hook("h", "tool_before", { reads: ["knowledge"] })] })]), /declares reads at phase tool_before/u);
  const { hooks } = buildCapabilityRegistry([capability("a", { hooks: [hook("h", "task_settle", { writes: [] })] })]);
  assert.equal(hooks[0]!.owned, "a");
});

test("registry enforces accumulation ordering and member legality", () => {
  const readMemory = hook("read-memory", "task_settle", { order: 2, reads: ["memory"], writes: ["experience"] });
  const writeMemory = hook("write-memory", "task_settle", { order: 1, writes: ["memory"] });
  const { hooks } = buildCapabilityRegistry([capability("a", { hooks: [readMemory, writeMemory] })]);
  assert.deepEqual(hooks.map(item => item.name), ["write-memory", "read-memory"]);
  assert.throws(() => buildCapabilityRegistry([capability("a", { hooks: [readMemory] })]), /no earlier hook writes it/u);
  assert.throws(() => buildCapabilityRegistry([capability("a", { hooks: [hook("h", "task_settle", { writes: ["unknown" as never] })] })]), /writes an unknown member/u);
  assert.throws(() => buildCapabilityRegistry([capability("a", { hooks: [hook("h", "task_settle", { writes: ["history"] })] })]), /history, which is host_provided/u);
  assert.throws(() => buildCapabilityRegistry([capability("a", { hooks: [hook("h", "task_settle", { reads: ["state", "unknown" as never], writes: ["knowledge"] })] })]), /reads an unknown member/u);
  const stateReader = buildCapabilityRegistry([capability("a", { hooks: [hook("h", "task_settle", { reads: ["state", "history"], writes: ["knowledge"] })] })]);
  assert.equal(stateReader.hooks.length, 1);
});

test("orderHooks uses phase, order then name", () => {
  const ordered = orderHooks([
    hook("z", "task_settle", { order: 1 }), hook("a", "task_settle", { order: 1 }), hook("first", "tool_before", { order: 99 }),
  ]);
  assert.deepEqual(ordered.map(item => item.name), ["first", "a", "z"]);
});

test("equal-order contributing hooks are ordered by name", () => {
  const { hooks } = buildCapabilityRegistry([capability("a", { hooks: [
    hook("zeta", "task_settle", { order: 5, writes: ["knowledge"] }),
    hook("alpha", "task_settle", { order: 5, writes: ["memory"] }),
  ] })]);
  assert.deepEqual(hooks.map(item => item.name), ["alpha", "zeta"]);
});

test("runPhase runs hooks in order and attributes outcomes", async () => {
  const context: Omit<HookContext, "phase"> = { input_digest: "sha256:x" };
  const seen: string[] = [];
  const result = await runPhase("tool_after", context, [
    hook("second", "tool_after", { order: 2, owned: "b", run: async (ctx) => { seen.push(`${ctx.phase}:${ctx.input_digest}`); return { kind: "observed", refs: ["r"] }; } }),
    hook("first", "tool_after", { order: 1, run: async () => { seen.push("first"); return { kind: "proposed", refs: [] }; } }),
  ]);
  assert.deepEqual(seen, ["first", "tool_after:sha256:x"]);
  assert.equal(result.denied, false);
  assert.deepEqual(result.outcomes.map(item => [item.hook, item.capability]), [["first", undefined], ["second", "b"]]);
});

test("runPhase stops gating phases on denial and converts thrown hooks to unobserved", async () => {
  let laterRan = false;
  const denied = await runPhase("tool_before", { input_digest: "d" }, [
    hook("gate", "tool_before", { run: async () => ({ kind: "denied", reason: "no" }) }),
    hook("later", "tool_before", { run: async () => { laterRan = true; return { kind: "observed", refs: [] }; } }),
  ]);
  assert.equal(denied.denied, true);
  assert.equal(laterRan, false);
  const thrown = await runPhase("tool_after", { input_digest: "d" }, [
    hook("broken", "tool_after", { run: async () => { throw new Error("boom"); } }),
    hook("after", "tool_after", { run: async () => ({ kind: "observed", refs: [] }) }),
  ]);
  assert.deepEqual(thrown.outcomes.map(item => item.hook), ["after", "broken"]);
  assert.equal(thrown.outcomes.length, 2);
  await assert.rejects(runPhase("tool_after", { input_digest: "d" }, [hook("bad", "tool_after", { run: async () => ({ kind: "denied", reason: "x" }) })]), /which cannot refuse/u);
});

test("runPhase converts non-Error rejections and ignores hooks from other phases", async () => {
  const result = await runPhase("context_resolve", { input_digest: "d" }, [
    hook("other", "tool_after", { run: async () => ({ kind: "observed", refs: [] }) }),
    hook("thrower", "context_resolve", { run: async () => { throw "plain"; } }),
  ]);
  assert.deepEqual(result.outcomes.map((entry: { outcome: HookOutcome }) => entry.outcome), [{ kind: "unobserved", reason: "plain" }]);
});
