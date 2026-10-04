import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config";
import { buildApp } from "../src/api/app";
import type { Store } from "../src/db/store";
import { conflict } from "../src/errors";

const config = loadConfig({
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  API_KEY: "1234567890123456",
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
});
function fakeStore(overrides: Partial<Store> = {}): Store {
  return {
    ping: async () => {},
    listTheatres: async () => [],
    createTheatre: async (input: unknown) => input,
    theatreHealth: async () => [],
    jobStateCounts: async () => ({}),
    ...overrides,
  } as unknown as Store;
}
test("liveness is independent of database; readiness checks it", async () => {
  const app = buildApp(
    config,
    fakeStore({
      ping: async () => {
        throw new Error("db down");
      },
    }),
  );
  assert.equal((await app.inject("/health/live")).statusCode, 200);
  const ready = await app.inject("/health/ready");
  assert.equal(ready.statusCode, 503);
  assert.equal(ready.json().status, "not_ready");
  await app.close();
});
test("API authentication, validation and request IDs", async () => {
  const app = buildApp(config, fakeStore());
  const missing = await app.inject({
    method: "POST",
    url: "/v1/theatres",
    payload: {},
  });
  assert.equal(missing.statusCode, 401);
  const invalid = await app.inject({
    method: "POST",
    url: "/v1/theatres",
    headers: { "x-api-key": config.API_KEY },
    payload: { name: "" },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "VALIDATION_ERROR");
  assert.ok(invalid.headers["x-request-id"]);
  const valid = await app.inject({
    method: "POST",
    url: "/v1/theatres",
    headers: { "x-api-key": config.API_KEY },
    payload: {
      name: "Test",
      city: "Paris",
      region: "Europe",
      endpointIdentifier: "test-001",
    },
  });
  assert.equal(valid.statusCode, 201);
  assert.equal(valid.json().data.operationalStatus, "ACTIVE");
  await app.close();
});
test("heartbeat rejects invalid data and operational health can be filtered", async () => {
  const app = buildApp(
    config,
    fakeStore({
      theatreHealth: async () => [
        { readiness: "STALE" },
        { readiness: "HEALTHY" },
      ],
    }),
  );
  const headers = { "x-api-key": config.API_KEY };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/heartbeats",
        headers,
        payload: { theatreId: "invalid" },
      })
    ).statusCode,
    400,
  );
  const result = await app.inject({
    url: "/v1/theatre-health?readiness=STALE",
    headers,
  });
  assert.equal(result.json().data.length, 1);
  await app.close();
});
test("distribution scheduling validates destinations and reports state conflicts", async () => {
  const releaseId = "f591fca9-1aeb-4caf-a322-cd8cd5661cb0";
  const theatreId = "50409033-b90d-4f1d-866f-bafc34ee8446";
  let scheduled = 0;
  const app = buildApp(
    config,
    fakeStore({
      schedule: async () => {
        scheduled++;
        return [{ id: "job-1", state: "PENDING" }] as Awaited<
          ReturnType<Store["schedule"]>
        >;
      },
      retryFailed: async () => {
        throw conflict("Only FAILED jobs can be manually retried");
      },
    }),
  );
  const headers = { "x-api-key": config.API_KEY };
  const invalid = await app.inject({
    method: "POST",
    url: "/v1/distribution-jobs",
    headers,
    payload: { releaseId, theatreIds: [theatreId, theatreId] },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(scheduled, 0);
  const created = await app.inject({
    method: "POST",
    url: "/v1/distribution-jobs",
    headers,
    payload: { releaseId, theatreIds: [theatreId] },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().data[0].state, "PENDING");
  assert.equal(scheduled, 1);
  const retry = await app.inject({
    method: "POST",
    url: `/v1/distribution-jobs/${releaseId}/retry`,
    headers,
  });
  assert.equal(retry.statusCode, 409);
  assert.equal(retry.json().error.code, "CONFLICT");
  await app.close();
});
test("malformed JSON and unknown routes return sanitized client errors", async () => {
  const app = buildApp(config, fakeStore());
  const malformed = await app.inject({
    method: "POST",
    url: "/v1/theatres",
    headers: {
      "x-api-key": config.API_KEY,
      "content-type": "application/json",
    },
    payload: "{",
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error.code, "BAD_REQUEST");
  const missing = await app.inject({
    url: "/v1/no-such-route",
    headers: { "x-api-key": config.API_KEY },
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "NOT_FOUND");
  await app.close();
});
