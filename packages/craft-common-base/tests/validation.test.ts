import assert from "node:assert/strict";
import test from "node:test";
import { array, boundedActor, fallback, finiteInteger, list, noCredentialAssignment, object, optionalScope, optionalText, parseScope, SCOPE_KINDS, sortedUniqueList, text, uniqueList } from "../src/validation.ts";

test("text, object and array reject absent or wrong shapes", () => {
  assert.equal(text("  value ", "field"), "value");
  for (const value of ["", "   ", undefined, null, 1]) assert.throws(() => text(value, "field"), /field must not be empty/u);
  assert.deepEqual(object({ a: 1 }, "field"), { a: 1 });
  for (const value of [null, [], "x", 1]) assert.throws(() => object(value, "field"), /field must be an object/u);
  assert.deepEqual(array([1], "field"), [1]);
  assert.throws(() => array("x", "field"), /field must be an array/u);
});

test("list, uniqueList and sortedUniqueList keep their distinct contracts", () => {
  assert.deepEqual(list(undefined, "items"), []);
  assert.deepEqual(list([" a ", "a"], "items"), ["a", "a"]);
  assert.throws(() => list("x", "items"), /items must be an array/u);
  assert.throws(() => list([""], "items"), /items must not be empty/u);
  assert.deepEqual(uniqueList(["a", "b"], "items"), ["a", "b"]);
  assert.throws(() => uniqueList(["a", "a"], "items"), /must contain unique values/u);
  assert.throws(() => uniqueList("x", "items"), /items must be an array/u);
  assert.deepEqual(uniqueList(undefined, "items"), []);
  assert.deepEqual(sortedUniqueList(["b", "a"], "items"), ["a", "b"]);
  assert.deepEqual(sortedUniqueList(undefined, "items"), []);
  assert.throws(() => sortedUniqueList(undefined, "items", true), /items must be an array/u);
  assert.throws(() => sortedUniqueList(["a", "a"], "items"), /must contain unique values/u);
});

test("parseScope and optionalScope validate recognized kinds", () => {
  assert.equal(SCOPE_KINDS.size, 8);
  assert.deepEqual(parseScope({ scope_kind: "project", scope_id: "p" }), { kind: "project", id: "p" });
  assert.throws(() => parseScope({ scope_kind: "unknown", scope_id: "p" }), /scope_kind is unsupported/u);
  assert.throws(() => parseScope({ scope_kind: "project", scope_id: "" }), /scope_id must not be empty/u);
  assert.equal(optionalScope({}), null);
  assert.equal(optionalScope({ scope_kind: "  ", scope_id: null }), null);
  assert.deepEqual(optionalScope({ scope_kind: "task", scope_id: "t" }), { kind: "task", id: "t" });
  assert.throws(() => optionalScope({ scope_kind: "task" }), /scope_id must not be empty/u);
});

test("credential and actor guards reject unsafe attribution", () => {
  assert.equal(noCredentialAssignment("plain", "actor"), "plain");
  for (const value of ["api_key: abcdefgh", "Authorization = secret-value", "token: 12345678"]) {
    assert.throws(() => noCredentialAssignment(value, "actor"), /must not contain credentials/u);
  }
  assert.equal(boundedActor(" agent-1 ", "actor"), "agent-1");
  assert.throws(() => boundedActor(" ", "actor"), /must not be empty/u);
  assert.throws(() => boundedActor("\t ", "actor"), /must not be empty/u);
  assert.throws(() => boundedActor("x".repeat(121), "actor"), /120 characters or fewer/u);
  assert.throws(() => boundedActor("a\nb", "actor"), /single line/u);
  assert.throws(() => boundedActor("password: supersecret", "actor"), /credentials/u);
});

test("fallback, optionalText and finiteInteger bound numeric inputs", () => {
  assert.equal(fallback(undefined, 5), 5);
  assert.equal(fallback(null, 5), null);
  assert.equal(optionalText(undefined, "x"), null);
  assert.equal(optionalText(" x ", "x"), "x");
  assert.throws(() => optionalText(null, "x"), /must not be empty/u);
  assert.equal(finiteInteger(undefined, "n", 2), 2);
  assert.equal(finiteInteger("3", "n", 2), 3);
  assert.equal(finiteInteger(4, "n", 2, 1, 4), 4);
  for (const value of [0, "x", 2.5, 5, "", null]) assert.throws(() => finiteInteger(value, "n", 2, 1, 4), /must be an integer between 1 and 4/u);
});
