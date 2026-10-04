import Fastify, { LogController, type FastifyInstance } from "fastify";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { z, ZodError } from "zod";
import type { Config } from "../config";
import { AppError } from "../errors";
import { Store, type JobState } from "../db/store";
import { makeMetrics } from "../metrics";

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const theatreSchema = z
  .object({
    name: z.string().trim().min(1).max(150),
    city: z.string().trim().min(1).max(100),
    region: z.string().trim().min(1).max(100),
    endpointIdentifier: z.string().regex(/^[A-Za-z0-9._-]{3,100}$/),
    operationalStatus: z
      .enum(["ACTIVE", "MAINTENANCE", "INACTIVE"])
      .default("ACTIVE"),
  })
  .strict();
const theatreUpdate = theatreSchema
  .pick({ name: true, city: true, region: true, operationalStatus: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required");
const releaseSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(50),
    contentIdentifier: z.string().trim().min(1).max(150),
    releaseDate: z.string().date(),
    status: z
      .enum(["DRAFT", "SCHEDULED", "ACTIVE", "ARCHIVED"])
      .default("DRAFT"),
    metadata: z.record(z.unknown()).default({}),
  })
  .strict();
const scheduleSchema = z
  .object({
    releaseId: uuid,
    theatreIds: z
      .array(uuid)
      .min(1)
      .max(100)
      .refine(
        (v) => new Set(v).size === v.length,
        "Duplicate theatre IDs are not allowed",
      ),
  })
  .strict();
const heartbeatSchema = z
  .object({
    theatreId: uuid,
    timestamp: z.string().datetime({ offset: true }),
    softwareVersion: z.string().trim().min(1).max(100),
    availableStorageGb: z.number().finite().min(0).max(1e9),
    contentReady: z.boolean(),
    healthStatus: z.enum(["HEALTHY", "DEGRADED", "UNHEALTHY"]),
  })
  .strict();
const listJobsSchema = z.object({
  state: z
    .enum(["PENDING", "PROCESSING", "DELIVERED", "FAILED", "RETRYING"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

function authorized(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildApp(config: Config, store: Store): FastifyInstance {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, base: { service: "cineops-api" } },
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const metrics = makeMetrics(store);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
    const incoming = request.headers["x-correlation-id"];
    const correlationId =
      typeof incoming === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(incoming)
        ? incoming
        : request.id;
    reply.header("x-correlation-id", correlationId);
    request.log.info(
      {
        requestId: request.id,
        correlationId,
        method: request.method,
        url: request.url,
      },
      "request started",
    );
    if (
      request.url.startsWith("/v1/") &&
      config.API_KEY &&
      !authorized(
        typeof request.headers["x-api-key"] === "string"
          ? request.headers["x-api-key"]
          : undefined,
        config.API_KEY,
      )
    )
      throw new AppError(401, "UNAUTHORIZED", "Valid API key required");
  });
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? "unmatched";
    metrics.httpRequests.inc({
      method: request.method,
      route,
      status: String(reply.statusCode),
    });
    if (reply.statusCode >= 400)
      metrics.httpErrors.inc({
        method: request.method,
        route,
        status: String(reply.statusCode),
      });
    metrics.httpDuration.observe(
      { method: request.method, route },
      reply.elapsedTime / 1000,
    );
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        route,
        status: reply.statusCode,
        durationMs: reply.elapsedTime,
      },
      "request completed",
    );
  });
  app.setErrorHandler((error, request, reply) => {
    const isValidation = error instanceof ZodError;
    const frameworkStatus =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
        ? error.statusCode
        : 500;
    const status = isValidation
      ? 400
      : error instanceof AppError
        ? error.status
        : frameworkStatus;
    const code = isValidation
      ? "VALIDATION_ERROR"
      : error instanceof AppError
        ? error.code
        : status === 500
          ? "INTERNAL_ERROR"
          : "BAD_REQUEST";
    const message = isValidation
      ? "Invalid request"
      : error instanceof AppError
        ? error.message
        : status === 500
          ? "Internal server error"
          : "Invalid request";
    if (status >= 500)
      request.log.error(
        { err: error, requestId: request.id },
        "request failed",
      );
    else request.log.warn({ code, requestId: request.id }, "request rejected");
    reply.status(status).send({
      error: {
        code,
        message,
        requestId: request.id,
        ...(isValidation
          ? {
              details: error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
              })),
            }
          : {}),
      },
    });
  });
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
        requestId: request.id,
      },
    });
  });
  app.get("/health/live", async () => ({ status: "alive" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      if (config.SIM_UNHEALTHY_DEPENDENCY)
        throw new Error("Development dependency simulation");
      await store.ping();
      return { status: "ready" };
    } catch {
      reply.status(503);
      return { status: "not_ready", dependencies: { database: "unavailable" } };
    }
  });
  app.get("/metrics", async (_request, reply) => {
    reply.type(metrics.registry.contentType);
    return metrics.registry.metrics();
  });
  app.post("/v1/theatres", async (request, reply) => {
    const row = await store.createTheatre(theatreSchema.parse(request.body));
    reply.status(201);
    return { data: row };
  });
  app.get("/v1/theatres", async () => ({ data: await store.listTheatres() }));
  app.get("/v1/theatres/:id", async (request) => ({
    data: await store.getTheatre(idParams.parse(request.params).id),
  }));
  app.patch("/v1/theatres/:id", async (request) => ({
    data: await store.updateTheatre(
      idParams.parse(request.params).id,
      theatreUpdate.parse(request.body),
    ),
  }));
  app.post("/v1/releases", async (request, reply) => {
    const row = await store.createRelease(releaseSchema.parse(request.body));
    reply.status(201);
    return { data: row };
  });
  app.get("/v1/releases", async () => ({ data: await store.listReleases() }));
  app.get("/v1/releases/:id", async (request) => ({
    data: await store.getRelease(idParams.parse(request.params).id),
  }));
  app.post("/v1/distribution-jobs", async (request, reply) => {
    const input = scheduleSchema.parse(request.body);
    const jobs = await store.schedule(input.releaseId, input.theatreIds);
    reply.status(201);
    return { data: jobs };
  });
  app.get("/v1/distribution-jobs", async (request) => {
    const q = listJobsSchema.parse(request.query);
    return {
      data: await store.listJobs(
        q.state as JobState | undefined,
        q.limit,
        q.offset,
      ),
      page: { limit: q.limit, offset: q.offset },
    };
  });
  app.get("/v1/distribution-jobs/failed", async (request) => {
    const q = listJobsSchema.parse(request.query);
    return {
      data: await store.listJobs("FAILED", q.limit, q.offset),
      page: { limit: q.limit, offset: q.offset },
    };
  });
  app.get("/v1/distribution-jobs/:id", async (request) => ({
    data: await store.getJob(idParams.parse(request.params).id),
  }));
  app.post("/v1/distribution-jobs/:id/retry", async (request) => ({
    data: await store.retryFailed(idParams.parse(request.params).id),
  }));
  app.post("/v1/heartbeats", async (request, reply) => {
    const input = heartbeatSchema.parse(request.body);
    const reported = Date.parse(input.timestamp);
    if (reported > Date.now() + 300000 || reported < Date.now() - 86400000)
      throw new AppError(
        422,
        "INVALID_TIMESTAMP",
        "Heartbeat timestamp must be within the past 24 hours and no more than five minutes in the future",
      );
    const row = await store.recordHeartbeat(input);
    reply.status(201);
    return { data: row };
  });
  app.get("/v1/theatre-health", async (request) => {
    const query = z
      .object({
        readiness: z
          .enum(["HEALTHY", "UNHEALTHY", "STALE", "NEVER_REPORTED"])
          .optional(),
      })
      .parse(request.query);
    const rows = await store.theatreHealth();
    return {
      data: query.readiness
        ? rows.filter((r) => r.readiness === query.readiness)
        : rows,
    };
  });
  app.get("/v1/operations/summary", async () => ({
    data: await store.summary(),
  }));
  return app;
}
