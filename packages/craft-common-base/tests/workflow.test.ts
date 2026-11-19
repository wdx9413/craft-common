import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { approvedEffects, executeSteps, normalizeSteps, redact, resolveInputs, runStep, safePath, SIDE_EFFECTS, substitute } from "../src/workflow.ts";

const directories: string[] = [];
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "craft-workflow-"));
  directories.push(directory);
  return directory;
}
test.after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

test("resolveInputs applies defaults and enforces required definitions", () => {
  assert.deepEqual(resolveInputs([{ name: "a", default: 1 }, { name: "b" }], { b: 2 }), { b: 2, a: 1 });
  assert.deepEqual(resolveInputs([{ name: "a", default: 1 }], { a: null }), { a: null });
  assert.throws(() => resolveInputs([null as never], {}), /index 0 must be an object/u);
  assert.throws(() => resolveInputs([[] as never], {}), /index 0 must be an object/u);
  assert.throws(() => resolveInputs([{ name: "" }], {}), /non-empty name/u);
  assert.throws(() => resolveInputs([{ name: "a", required: true }], {}), /Missing required workflow input: a/u);
});

test("substitute walks nested values and preserves non-string leaves", () => {
  const inputs = { name: "craft", count: 2, flag: false, object: { a: 1 } };
  assert.deepEqual(substitute(["{{name}}", "x {{count}} y", { flag: "{{flag}}" }], inputs), ["craft", "x 2 y", { flag: false }]);
  assert.equal(substitute("{{ count }}", inputs), 2);
  assert.deepEqual(substitute("{{object}}", inputs), { a: 1 });
  assert.equal(substitute(5, inputs), 5);
  assert.throws(() => substitute("{{missing}}", inputs), /Unknown workflow input: missing/u);
  assert.throws(() => substitute("{{missing}}", inputs), /Unknown workflow input: missing/u);
  assert.throws(() => substitute("prefix {{missing}} suffix", inputs), /Unknown workflow input: missing/u);
  assert.throws(() => substitute(["{{missing}}"], inputs), /Unknown workflow input: missing/u);
});

test("safePath stays inside the real project root", () => {
  const directory = root();
  mkdirSync(join(directory, "child"));
  writeFileSync(join(directory, "child", "file.txt"), "x");
  assert.equal(safePath(directory, "child/file.txt"), join(directory, "child", "file.txt"));
  assert.equal(safePath(directory), directory);
  assert.throws(() => safePath(directory, "../escape"), /escapes project root/u);
  const absolute = join(directory, "child", "file.txt");
  assert.equal(safePath(directory, absolute), absolute);
});

test("safePath rejects links that escape the root", { skip: process.platform === "win32" ? "symlink creation requires privileges" : false }, () => {
  const directory = root(), outside = root();
  symlinkSync(outside, join(directory, "link"), "dir");
  assert.throws(() => safePath(directory, "link/new/file"), /escapes project root through a link/u);
});

test("safePath rejects Windows junctions that escape the root", { skip: process.platform !== "win32" ? "junction is Windows-only" : false }, () => {
  const directory = root(), outside = root();
  symlinkSync(outside, join(directory, "junction"), "junction");
  assert.throws(() => safePath(directory, "junction/new/file"), /escapes project root through a link/u);
});

test("safePath resolves absent descendants through an existing in-root directory", () => {
  const directory = root();
  mkdirSync(join(directory, "existing"));
  const before = join(directory, "existing", "missing", "file");
  assert.equal(safePath(directory, "existing/missing/file"), before);
  assert.equal(safePath(directory, "existing/missing"), join(directory, "existing", "missing"));
});

test("redact hides credential-like values and explicit secrets", () => {
  assert.equal(redact("authorization: bearer abc123"), "authorization: bearer [REDACTED]");
  assert.equal(redact("api_key=abcdef"), "api_key=[REDACTED]");
  assert.equal(redact("secret-value token: abc"), "secret[REDACTED] token: [REDACTED]");
  assert.equal(redact("prefix-supersecret-suffix", ["supersecret", "tiny"]), "prefix-[REDACTED][REDACTED]");
});

test("normalizeSteps assigns stable ids and side effects", () => {
  assert.deepEqual(normalizeSteps([{ type: "command" }, { id: "x", side_effect: "read_only" }]), [
    { type: "command", id: "step_1", side_effect: "local_write" },
    { id: "x", side_effect: "read_only" },
  ]);
  assert.equal(normalizeSteps([{ id: "a" }])[0]!.side_effect, "read_only");
  assert.throws(() => normalizeSteps([null as never]), /index 0 must be an object/u);
  assert.throws(() => normalizeSteps([{ id: "a" }, { id: "a" }]), /Duplicate workflow step id: a/u);
  assert.throws(() => normalizeSteps([{ side_effect: "launch" }]), /Unsupported side effect/u);
});

test("approvedEffects always allows read-only and gates local writes", () => {
  assert.deepEqual([...approvedEffects(false)], ["read_only"]);
  assert.deepEqual([...approvedEffects(true)], ["read_only", "local_write"]);
  assert.deepEqual([...SIDE_EFFECTS], ["read_only", "local_write", "external_write", "destructive"]);
  assert.deepEqual([...approvedEffects(true, ["destructive"])], ["read_only", "local_write", "destructive"]);
  assert.throws(() => approvedEffects(false, ["launch"]), /Unsupported approved side effect/u);
});

test("command steps return bounded, redacted output and expected exit status", () => {
  const directory = root();
  const command = [process.execPath, "-e", "console.log('out'); console.error('api_key=abcdefgh'); process.exit(3)"];
  const result = runStep({ type: "command", command, expected_exit_code: 3, env: { CRAFT_SECRET: "abc1234" } }, directory, {}, spawnSync);
  assert.equal(result.passed, true);
  assert.equal(result.exit_code, 3);
  assert.equal(result.stdout, "out\n");
  assert.equal(result.stderr, "api_key=[REDACTED]\n");
  assert.equal(result.error, undefined);
});

test("command steps reject malformed configuration before running", () => {
  const directory = root();
  const base = { type: "command", command: [process.execPath, "-e", ""] };
  assert.throws(() => runStep({ ...base, command: [] }, directory), /non-empty string array/u);
  assert.throws(() => runStep({ ...base, command: ["node", 1] }, directory), /non-empty string array/u);
  assert.throws(() => runStep({ ...base, cwd: "../" }, directory), /escapes project root/u);
  assert.throws(() => runStep({ ...base, cwd: "missing" }, directory), /cwd does not exist/u);
  writeFileSync(join(directory, "file"), "x");
  assert.throws(() => runStep({ ...base, cwd: "file" }, directory), /cwd does not exist/u);
  assert.throws(() => runStep({ ...base, env: [] }, directory), /env must be an object/u);
  assert.throws(() => runStep({ ...base, env: { "BAD=KEY": "x" } }, directory), /invalid environment-variable name/u);
  assert.throws(() => runStep({ ...base, env: { "BAD\0KEY": "x" } }, directory), /invalid environment-variable name/u);
  assert.throws(() => runStep({ ...base, env: { "": "x" } }, directory), /invalid environment-variable name/u);
  assert.throws(() => runStep({ ...base, timeout_seconds: 0 }, directory), /greater than 0/u);
  assert.throws(() => runStep({ ...base, timeout_seconds: "x" }, directory), /greater than 0/u);
  assert.throws(() => runStep({ ...base, expected_exit_code: 1.5 }, directory), /must be an integer/u);
  const failing = runStep({ type: "command", command: ["definitely-not-a-real-command-xyz"] }, directory, { API_TOKEN: "secret-token" });
  assert.equal(failing.passed, false);
  assert.match(String(failing.error), /ENOENT|not found/u);
  const capped = runStep({ ...base, timeout_seconds: 10_000 }, directory);
  assert.equal(capped.passed, true);
});

test("command output and secrets are bounded", () => {
  const directory = root();
  const command = [process.execPath, "-e", "process.stdout.write('x'.repeat(13000))"];
  const result = runStep({ type: "command", command }, directory);
  assert.equal(String(result.stdout).length, 12000);
  const secret = runStep({ type: "command", command: [process.execPath, "-e", "process.stdout.write(process.env.MY_PASSWORD)"] }, directory, { MY_PASSWORD: "p@ssword" });
  assert.equal(secret.stdout, "[REDACTED]");
});

test("file_exists and json_value assertions evaluate real files", () => {
  const directory = root();
  writeFileSync(join(directory, "data.json"), JSON.stringify({ a: { b: [{ c: 1 }] } }));
  assert.deepEqual(runStep({ type: "assertion", evaluator: "file_exists", path: "data.json" }, directory), { passed: true, actual: true, expected: true });
  assert.deepEqual(runStep({ type: "assertion", evaluator: "file_exists", path: "missing", expected: false }, directory), { passed: true, actual: false, expected: false });
  assert.deepEqual(runStep({ type: "assertion", evaluator: "file_exists" }, directory), { passed: true, actual: true, expected: true });
  assert.deepEqual(runStep({ type: "assertion", evaluator: "json_value", path: "data.json", field: "a.b.0.c", expected: 1 }, directory), { passed: true, actual: 1, expected: 1 });
  assert.deepEqual(runStep({ type: "assertion", evaluator: "json_value", path: "data.json", field: "a.b.x.c" }, directory), { passed: true, actual: undefined, expected: undefined });
  assert.deepEqual(runStep({ type: "assertion", evaluator: "json_value", path: "data.json", field: "a.b.0" }, directory).actual, { c: 1 });
  assert.deepEqual(runStep({ type: "assertion", evaluator: "json_value", path: "data.json" }, directory).actual, { a: { b: [{ c: 1 }] } });
  assert.throws(() => runStep({ type: "assertion", evaluator: "json_value" }, directory));
  assert.deepEqual(runStep({ type: "assertion", evaluator: "json_value", path: "data.json", field: "a.b.x" }, directory).actual, undefined);
  assert.deepEqual(runStep({ type: "assertion", evaluator: "json_value", path: "data.json", field: ".a" }, directory).actual, { b: [{ c: 1 }] });
  assert.deepEqual(runStep({ type: "assertion", evaluator: "json_value", path: "data.json", field: "a.b.0.c.d" }, directory).actual, undefined);
  assert.deepEqual(runStep({ type: "assertion", evaluator: "json_value", path: "data.json", field: "a.b.0.c.d.e" }, directory).actual, undefined);
  assert.throws(() => runStep({ type: "assertion", evaluator: "other" }, directory), /Unsupported assertion evaluator/u);
});

test("coverage_gate compares summary percentages with thresholds", () => {
  const directory = root();
  writeFileSync(join(directory, "coverage-summary.json"), JSON.stringify({ total: { lines: { pct: 100 }, branches: { pct: 99 }, functions: { pct: 100 }, statements: { pct: 100 } } }));
  const report = { type: "coverage_gate", report: "coverage-summary.json" };
  writeFileSync(join(directory, "coverage-summary.json"), JSON.stringify({ total: { lines: { pct: 100 }, branches: { pct: 100 }, functions: { pct: 100 }, statements: { pct: 100 } } }));
  assert.equal(runStep({ type: "coverage_gate" }, directory).passed, true);
  writeFileSync(join(directory, "coverage-summary.json"), JSON.stringify({ total: { lines: { pct: 100 }, branches: { pct: 99 }, functions: { pct: 100 }, statements: { pct: 100 } } }));
  assert.equal(runStep({ ...report, branch_threshold: 99 }, directory).passed, true);
  assert.equal(runStep({ ...report, branch_threshold: 100 }, directory).passed, false);
  writeFileSync(join(directory, "coverage-summary.json"), JSON.stringify({ lines: { pct: 101 } }));
  assert.throws(() => runStep(report, directory), /invalid percentage/u);
  writeFileSync(join(directory, "coverage-summary.json"), JSON.stringify({ total: {} }));
  assert.equal(runStep(report, directory).passed, false);
  assert.throws(() => runStep({ ...report, line_threshold: 200 }, directory), /finite percentages/u);
  assert.equal(runStep({ ...report, line_threshold: 0, branch_threshold: 0, function_threshold: 0, statement_threshold: 0 }, directory).passed, true);
});

test("unknown step types are rejected", () => {
  assert.throws(() => runStep({ type: "other" }, root()), /Unsupported workflow step type: other/u);
});

test("executeSteps enforces effects, failures and continuations", () => {
  const calls: string[] = [];
  const executor = (step: { id?: unknown }) => ({ passed: step.id === "a" });
  const steps = [
    { id: "a", side_effect: "read_only" },
    { id: "b", side_effect: "external_write" },
    { id: "c" },
  ];
  const blocked = executeSteps(steps, "/", new Set(["read_only"]), executor);
  assert.deepEqual(blocked.map(item => [item.id, item.passed]), [["a", true], ["b", false]]);
  assert.equal(blocked[1]!.error, "side_effect_not_approved");
  const continued = executeSteps([{ id: "a", side_effect: "read_only", continue_on_failure: true }, { id: "b" }], "/", new Set(["read_only"]),
    (step) => { calls.push(String(step.id)); return step.id === "a" ? { passed: false } : { passed: true }; });
  assert.deepEqual(calls, ["a", "b"]);
  assert.deepEqual(continued.map(item => item.passed), [false, true]);
  const skipped = executeSteps([{ id: "a", side_effect: "read_only" }, { id: "b" }], "/", new Set(["read_only"]),
    (step) => ({ passed: step.id !== "a" }));
  assert.deepEqual(skipped.map(item => item.id), ["a"]);
  calls.length = 0;
  const continuedSteps = executeSteps([{ id: "a", continue_on_failure: true }, { id: "b" }], "/", new Set(["read_only"]),
    (step) => ({ passed: step.id !== "a" }));
  assert.deepEqual(continuedSteps.map(item => item.id), ["a", "b"]);
  const thrown = executeSteps([{ id: "a", continue_on_failure: true }, { id: "b" }], "/", new Set(["read_only"]),
    (step) => { if (step.id === "a") throw new Error("failure"); return { passed: true }; });
  assert.deepEqual(thrown[0], { id: "a", type: undefined, passed: false, error: "Error", message: "failure" });
  const thrownStops = executeSteps([{ id: "a" }], "/", new Set(["read_only"]), () => { throw "plain"; });
  assert.equal(thrownStops[0]!.message, "plain");
  assert.equal(thrownStops[0]!.error, "Error");
  const noEffect = executeSteps([{ id: "a", type: "command" }], "/", new Set(["read_only", "local_write"]), () => ({ passed: true }));
  assert.deepEqual(noEffect, [{ id: "a", type: "command", passed: true }]);
});
