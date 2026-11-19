import assert from "node:assert/strict";
import test from "node:test";
import * as base from "../src/index.ts";

test("base package entry exports the public primitives", () => {
  for (const name of ["Bm25Index", "canonicalJson", "digestJson", "contextAssetRef", "ContextBudget", "scopeEnvelope", "scopeAllows",
    "text", "list", "parseScope", "resolveInputs", "executeSteps", "temporalMemorySelect", "retrievalTerms", "KeywordRetrievalPort",
    "OpenAiCompatibleEmbeddingRetrievalPort", "credentialStatus", "selectModel", "buildCapabilityRegistry", "runPhase"]) {
    assert.ok(name in base, `missing export ${name}`);
  }
});
