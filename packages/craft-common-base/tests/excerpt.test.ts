import assert from "node:assert/strict";
import test from "node:test";
import { retrievalExcerpt } from "../src/retrieval-excerpt.ts";

test("short sources return complete excerpts with their range", () => {
  assert.deepEqual(retrievalExcerpt("short", "anything", 10), { text: "short", source_start: 0, source_end: 5, source_chars: 5, reason: "complete" });
  assert.equal(retrievalExcerpt("x".repeat(10), "query", 10).reason, "complete");
  assert.equal(retrievalExcerpt("x".repeat(11), "query 中文", 10).reason, "no_lexical_match");
});

test("excerpts validate their inputs", () => {
  assert.throws(() => retrievalExcerpt(null as never, "q"), /must be strings/u);
  assert.throws(() => retrievalExcerpt("body", null as never), /must be strings/u);
  assert.throws(() => retrievalExcerpt("body", "q", 0), /positive integer/u);
  assert.throws(() => retrievalExcerpt("body", "q", 1.5), /positive integer/u);
});

test("excerpts rank complete matching sentences and ignore unrelated ones", () => {
  const source = " Unrelated first. Crafts support memory and knowledge! Another line.\nFinal craft question?";
  const result = retrievalExcerpt(source, "craft knowledge", source.length - 1);
  assert.equal(result.reason, "matched_passage");
  assert.equal(result.text, "Crafts support memory and knowledge!");
  assert.equal(source.slice(result.source_start!, result.source_end!), result.text);
  const noMatch = retrievalExcerpt(source, "zzz", source.length - 1);
  assert.deepEqual(noMatch, { text: "", source_start: null, source_end: null, source_chars: source.length, reason: "no_lexical_match" });
});

test("oversized sentences require explicit expansion with bounded terms", () => {
  const longSentence = `craft ${"term ".repeat(200)}end`;
  const result = retrievalExcerpt(`Intro. ${longSentence}. End.`, "craft", 20);
  assert.equal(result.reason, "requires_expansion");
  assert.equal(result.text, "");
  assert.equal(result.source_start, 7);
  assert.equal(result.source_end, 7 + longSentence.length + 1);
  assert.deepEqual(result.matched_terms, ["craft"]);
});

test("excerpt sentence splitting handles Chinese and empty fragments", () => {
  const result = retrievalExcerpt("  你好。 世界！ 检索 完成？", "检索", 100);
  assert.equal(result.reason, "complete");
  const boundary = retrievalExcerpt(`aaaaaaaaaa。  检索 完成。extra`, "检索", 20);
  assert.equal(boundary.reason, "matched_passage");
  const larger = retrievalExcerpt(`${"填充内容。".repeat(30)}检索 完成。`, "检索", 60);
  assert.equal(larger.text.trimEnd(), "检索 完成。");
  assert.equal(larger.reason, "matched_passage");
  const leading = retrievalExcerpt("首行。\n\n第二行包含 token。", "token", 12);
  assert.equal(leading.text, "第二行包含 token。");
  assert.equal(leading.source_start, 5);
});
