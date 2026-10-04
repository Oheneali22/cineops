import { loadConfig } from "../config";
import { makePool } from "../db/pool";
import { PgWorkerJobStore, processDistribution } from "./jobs";
import { makeMetrics } from "../metrics";
import pino from "pino";
import { createServer } from "node:http";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    level: config.LOG_LEVEL,
    base: { service: "cineops-worker", workerId: config.WORKER_ID },
  });
  const pool = makePool(config);
  const jobs = new PgWorkerJobStore(pool);
  const metrics = makeMetrics();
  const metricsServer = createServer((request, response) => {
    if (request.url !== "/metrics" || request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }
    void metrics.registry
      .metrics()
      .then((body) => {
        response.writeHead(200, {
          "content-type": metrics.registry.contentType,
        });
        response.end(body);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, "worker metrics failed");
        response.writeHead(500).end();
      });
  });
  const shutdown = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      logger.info({ signal }, "shutdown requested");
      shutdown.abort();
    });
  await pool.query("SELECT 1");
  await new Promise<void>((resolve, reject) => {
    metricsServer.once("error", reject);
    metricsServer.listen(config.WORKER_METRICS_PORT, "0.0.0.0", resolve);
  });
  logger.info(
    {
      concurrency: config.WORKER_CONCURRENCY,
      batchSize: config.WORKER_BATCH_SIZE,
      metricsPort: config.WORKER_METRICS_PORT,
      simulation: {
        failureRate: config.SIM_FAILURE_RATE,
        extraDelayMs: config.SIM_EXTRA_DELAY_MS,
      },
    },
    "worker started",
  );
  const inFlight = new Set<Promise<void>>();
  async function handle(
    job: Awaited<ReturnType<typeof jobs.claim>>[number],
  ): Promise<void> {
    metrics.activeJobs.inc();
    const end = metrics.jobDuration.startTimer();
    logger.info(
      {
        jobId: job.id,
        releaseId: job.release_id,
        theatreId: job.theatre_id,
        attempt: job.attempts,
      },
      "job claimed",
    );
    try {
      const result = await processDistribution(config, shutdown.signal);
      const state = await jobs.finish(
        job,
        config.WORKER_ID,
        result.ok ? "DELIVERED" : "FAILED",
        result.ok ? null : result.reason,
        config.JOB_MAX_ATTEMPTS,
        config.JOB_RETRY_BASE_MS,
      );
      metrics.workerJobs.inc({ outcome: state });
      if (state === "RETRYING") metrics.workerRetries.inc();
      end({ outcome: state });
      logger.info(
        {
          jobId: job.id,
          state,
          attempt: job.attempts,
          reason: result.ok ? undefined : result.reason,
        },
        "job transition",
      );
    } catch (error) {
      if (shutdown.signal.aborted)
        logger.warn(
          { jobId: job.id },
          "job interrupted; lease recovery will retry",
        );
      else
        logger.error(
          { err: error, jobId: job.id },
          "job processing error; lease recovery will retry",
        );
      metrics.workerJobs.inc({ outcome: "ERROR" });
      end({ outcome: "ERROR" });
    } finally {
      metrics.activeJobs.dec();
    }
  }
  try {
    while (!shutdown.signal.aborted) {
      const recovered = await jobs.recoverExpired(
        config.JOB_MAX_ATTEMPTS,
        config.JOB_RETRY_BASE_MS,
      );
      if (recovered) metrics.leaseRecoveries.inc(recovered);
      if (recovered)
        logger.warn({ count: recovered }, "expired worker leases recovered");
      const capacity = Math.min(
        config.WORKER_BATCH_SIZE,
        config.WORKER_CONCURRENCY - inFlight.size,
      );
      if (capacity > 0)
        for (const job of await jobs.claim(
          config.WORKER_ID,
          capacity,
          config.WORKER_LEASE_MS,
        )) {
          const task = handle(job).finally(() => inFlight.delete(task));
          inFlight.add(task);
        }
      await new Promise((resolve) =>
        setTimeout(resolve, config.WORKER_POLL_MS),
      );
    }
  } finally {
    await Promise.allSettled(inFlight);
    await new Promise<void>((resolve, reject) =>
      metricsServer.close((error) => (error ? reject(error) : resolve())),
    );
    await pool.end();
    logger.info("worker stopped");
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
