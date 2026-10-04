import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config";

const base = { DATABASE_URL: "postgres://test:test@localhost:5432/test" };
test("required database configuration and production safety", () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
  assert.throws(
    () => loadConfig({ ...base, NODE_ENV: "production" }),
    /API_KEY/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...base,
        NODE_ENV: "production",
        API_KEY: "1234567890123456",
        SIM_FAILURE_RATE: "0.5",
      }),
    /forbidden/,
  );
  assert.equal(loadConfig(base).SIM_FAILURE_RATE, 0);
});
