# Application runbook

This runbook covers CineOps application behavior, independent of a hosting platform.

## First checks

Check process startup logs for invalid configuration, connection errors, and active simulation settings. `GET /health/live` checks only API process liveness. `GET /health/ready` queries PostgreSQL and returns 503 if it is unavailable. `GET /v1/operations/summary` and `/metrics` show job-state counts. Supply `x-api-key` for `/v1/` calls when configured. Use `x-request-id` to locate one request in JSON logs.

## Symptoms

| Symptom                         | Application checks                                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API will not start              | Check `DATABASE_URL`, `PORT`, production `API_KEY`, simulation settings, and PostgreSQL reachability. Verify migrations ran. Startup requires a DB ping.                                                                                      |
| Liveness works; readiness fails | Query PostgreSQL from the same runtime credentials. Check `SIM_UNHEALTHY_DEPENDENCY`, `SIM_DB_DELAY_MS`, database errors, and connection pool capacity.                                                                                       |
| Workers are not processing      | Check worker startup logs, DB access, `WORKER_POLL_MS`, available worker capacity, and whether jobs are `PENDING`/`RETRYING` with `available_at` in the past.                                                                                 |
| Jobs accumulate                 | Compare `PENDING`/`RETRYING` counts with worker activity. Inspect `available_at`, batch size, concurrency, database contention, and failure logs.                                                                                             |
| Jobs repeatedly fail            | Inspect `/v1/distribution-jobs/:id` history and failure reason. Check `SIM_FAILURE_RATE`, maximum attempts, and processing duration versus `WORKER_LEASE_MS`. Terminal `FAILED` jobs require explicit `POST /v1/distribution-jobs/:id/retry`. |
| Jobs stuck in `PROCESSING`      | Check `lease_expires_at`, worker logs, and worker health. Running workers recover expired leases during polling. A stopped fleet leaves jobs until a worker resumes.                                                                          |
| Theatres become stale           | Query `/v1/theatre-health?readiness=STALE`; inspect latest `received_at`, heartbeat sender, and `HEARTBEAT_STALE_SECONDS`. `NEVER_REPORTED` is a separate state.                                                                              |
| Elevated API errors             | Compare `/metrics` HTTP status counts and request logs. 400 indicates validation; 401 key mismatch; 409 domain conflict; 503 readiness dependency; 500 has an internal error log.                                                             |

## Safe operator actions

Do not edit job state directly during routine incidents. Use the retry endpoint for terminal failed jobs after understanding the cause. Run migrations as an explicit deployment step before starting new code. Changes to retry and lease settings apply when processes restart. Development simulation settings must be zero or false for production startup.
