import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config";
import { processDistribution, retryDelay } from "../src/worker/jobs";

const config = loadConfig({
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  NODE_ENV: "test",
  WORKER_PROCESS_MS: "0",
  SIM_FAILURE_RATE: "1",
});
test("transient simulation fails deterministically and retries back off", async () => {
  assert.deepEqual(
    await processDistribution(config, new AbortController().signal, () => 0),
    { ok: false, reason: "Simulated transient distribution failure" },
  );
  assert.equal(retryDelay(1, 2000), 2000);
  assert.equal(retryDelay(3, 2000), 8000);
});
test("distribution succeeds when failure simulation is disabled", async () => {
  const successConfig = loadConfig({
    DATABASE_URL: "postgres://test:test@localhost:5432/test",
    NODE_ENV: "test",
    WORKER_PROCESS_MS: "0",
  });
  assert.deepEqual(
    await processDistribution(successConfig, new AbortController().signal),
    { ok: true },
  );
});
test("shutdown interrupts processing", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    processDistribution(config, controller.signal),
    /shutting down/,
  );
});
