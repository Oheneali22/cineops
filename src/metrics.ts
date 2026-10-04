import client from "prom-client";
import type { Store } from "./db/store";

export function makeMetrics(store?: Store) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service: "cineops" });
  client.collectDefaultMetrics({ register: registry });
  const httpRequests = new client.Counter({
    name: "cineops_http_requests_total",
    help: "HTTP requests",
    labelNames: ["method", "route", "status"] as const,
    registers: [registry],
  });
  const httpDuration = new client.Histogram({
    name: "cineops_http_request_duration_seconds",
    help: "HTTP request duration",
    labelNames: ["method", "route"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const httpErrors = new client.Counter({
    name: "cineops_http_errors_total",
    help: "HTTP error responses",
    labelNames: ["method", "route", "status"] as const,
    registers: [registry],
  });
  const workerJobs = new client.Counter({
    name: "cineops_worker_jobs_total",
    help: "Worker job outcomes",
    labelNames: ["outcome"] as const,
    registers: [registry],
  });
  const jobDuration = new client.Histogram({
    name: "cineops_job_processing_duration_seconds",
    help: "Job processing duration",
    labelNames: ["outcome"] as const,
    registers: [registry],
  });
  const activeJobs = new client.Gauge({
    name: "cineops_worker_active_jobs",
    help: "Jobs currently being processed by this process",
    registers: [registry],
  });
  const workerRetries = new client.Counter({
    name: "cineops_worker_retries_total",
    help: "Worker scheduled retries after failed processing",
    registers: [registry],
  });
  const leaseRecoveries = new client.Counter({
    name: "cineops_worker_lease_recoveries_total",
    help: "Expired job leases recovered by this worker",
    registers: [registry],
  });
  const jobStates = new client.Gauge({
    name: "cineops_distribution_jobs",
    help: "Durable jobs by state",
    labelNames: ["state"] as const,
    registers: [registry],
    async collect() {
      if (!store) return;
      const counts = await store.jobStateCounts();
      for (const state of [
        "PENDING",
        "PROCESSING",
        "DELIVERED",
        "FAILED",
        "RETRYING",
      ])
        this.set({ state }, counts[state] ?? 0);
    },
  });
  void jobStates;
  return {
    registry,
    httpRequests,
    httpDuration,
    httpErrors,
    workerJobs,
    jobDuration,
    activeJobs,
    workerRetries,
    leaseRecoveries,
  };
}
