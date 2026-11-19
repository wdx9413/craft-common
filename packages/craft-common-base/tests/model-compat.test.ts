import assert from "node:assert/strict";
import test from "node:test";
import { credentialStatus, selectModel, type ModelProviderSpec } from "../src/model-compat.ts";

const spec: ModelProviderSpec = {
  provider: "p", label: "P", protocol: "openai-compatible", base_url: "https://x", api_key_env: "P_KEY",
  chat_path: "/chat", models: { frontier: "f", standard: "s" }, cost_hint: 0, supports_tools: true,
};

test("credentialStatus reports configured keys without exposing them", () => {
  assert.deepEqual(credentialStatus(spec, { P_KEY: "secret" }), { provider: "p", configured: true, api_key_env: "P_KEY" });
  assert.deepEqual(credentialStatus(spec, { P_KEY: "" }), { provider: "p", configured: false, api_key_env: "P_KEY" });
  assert.deepEqual(credentialStatus(spec, {}), { provider: "p", configured: false, api_key_env: "P_KEY" });
  assert.deepEqual(credentialStatus({ ...spec, host_managed_auth: true }, {}), { provider: "p", configured: true, api_key_env: "host-managed-auth-store" });
});

test("selectModel returns the requested tier or the next available one", () => {
  assert.deepEqual(selectModel(spec, "frontier"), { tier: "frontier", model: "f", downgraded: false });
  assert.deepEqual(selectModel(spec, "standard"), { tier: "standard", model: "s", downgraded: false });
  assert.equal(selectModel({ ...spec, models: { frontier: "f", standard: "s", small: "m" } }, "small").tier, "small");
  assert.throws(() => selectModel(spec, "huge" as never), /Unsupported model tier: huge/u);
  assert.throws(() => selectModel({ ...spec, models: {} }, "small"), /declares no usable model tier/u);
});
