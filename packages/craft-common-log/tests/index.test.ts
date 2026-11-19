import assert from "node:assert/strict";
import test from "node:test";
import * as log from "../src/index.ts";

test("log package entry exports its public surface", () => {
  for (const name of ["CraftTelemetry", "telemetryEvent", "operationEventId", "standardizeTrace", "toOtlpTrace", "exportOtlp",
    "StoreTelemetrySink", "JsonlTelemetryJournal", "EvaluationContractKernel", "EVALUATION_STAGES", "CostLedgerKernel",
    "observeOperation", "observeMethods", "observedKernel", "withoutOperationPersistence", "operationErrorCode", "operationResultStatus"]) {
    assert.ok(name in log, `missing export ${name}`);
  }
});
