# Developer handoff to DevOps/SRE

## What is being handed over

CineOps is a fictional Node.js 20+ TypeScript application with two independently started processes: an HTTP API and a PostgreSQL-polling worker. The build output is JavaScript in `dist/`. `npm ci`, `npm run build`, `npm run db:migrate`, `npm run start:api`, and `npm run start:worker` are the core lifecycle commands. The worker simulates delivery; no real content leaves this system. No deployment infrastructure is included.

## Operational requirements

| Concern             | Application requirement                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime             | Node.js 20+, installed dependencies from `package-lock.json`; separate API and worker commands.                                                                                                                           |
| PostgreSQL          | Persistent PostgreSQL 14+ database and connection URL. Both processes need connectivity. Migrations need schema creation rights and `pgcrypto`; runtime roles can be narrower after migrations.                           |
| Configuration       | Environment variables from `.env.example`; validate before startup. `DATABASE_URL` is required. `API_KEY` is mandatory in production. Never commit real credentials.                                                      |
| Inbound traffic     | API listens on `PORT` on all interfaces. `/v1/` is key protected; `/health/*` and `/metrics` are not app authenticated. Decide exposure and transport security outside this code.                                         |
| Scaling API         | API instances are stateless except local request metrics; all domain records are in PostgreSQL. Account for each instance's DB pool.                                                                                      |
| Scaling workers     | Multiple workers can claim jobs concurrently through PostgreSQL row locks. Give each a distinct `WORKER_ID` and a distinct `WORKER_METRICS_PORT` when sharing a network namespace; budget concurrency and database pools. |
| Shutdown            | Send SIGTERM/SIGINT. API stops accepting requests and closes its pool. Worker waits for in-flight tasks; interrupted tasks are retried after lease expiry. Give it enough termination time.                               |
| Health              | `/health/live` verifies API process; `/health/ready` queries DB. Worker has no HTTP health endpoint; process status and logs are currently its operational signals.                                                       |
| Metrics and logs    | API and worker each expose Prometheus compatible `/metrics` on separate ports. Both processes log JSON to stdout/stderr. Preserve request/correlation IDs.                                                                |
| Migrations          | Run ordered SQL migrations before starting code that needs them. Migration runner serializes concurrent invocation with an advisory lock. Do not assume rollback SQL exists.                                              |
| Deployment ordering | Provision reachable DB and secrets, run migrations, then start API and worker. Ensure both run compatible schema and code versions during rollout.                                                                        |
| Rollback            | Code rollback may be constrained by forward-only schema changes. Back up and test a recovery plan. Avoid assuming automatic down migrations.                                                                              |
| Persistence         | Domain and queue state live in PostgreSQL. API/worker local state and metrics are ephemeral. No persistent filesystem is required.                                                                                        |
| Security            | Protect DB credentials and shared API key, restrict database privileges, decide network exposure for health/metrics, and supply TLS where required. Shared key is a foundation, not end-user identity.                    |

## Retry and concurrency details

Each job has at most one active claim because claims lock rows with `SKIP LOCKED`. Jobs move through `PENDING`, `PROCESSING`, `RETRYING`, `DELIVERED`, and `FAILED`. Every claim increments `attempts`. Failed attempts retry after capped exponential delay up to `JOB_MAX_ATTEMPTS`; a terminal failure can be retried manually, resetting attempts. A worker lease limits how long a claim is valid. If work outlasts `WORKER_LEASE_MS`, a later worker can recover it; a stale worker cannot write completion. Keep lease duration above expected processing time. Real delivery integration will need an idempotency contract before retrying external side effects.

## Decisions left to the receiving engineer

- Where and how to run the two processes, scale them, and expose API traffic.
- How to provision, back up, restore, secure, and monitor PostgreSQL; how to isolate migration permissions.
- How to store and rotate `DATABASE_URL` and `API_KEY`, and whether stronger user or endpoint authentication is needed.
- How to restrict unauthenticated health/metrics routes and transport encryption.
- How to collect and retain logs/metrics and restrict access to both metrics listeners.
- What worker count, concurrency, lease duration, retry limits, and database pool budget fit expected load.
- How to execute migrations safely during rollout and coordinate schema-compatible rollback.
- What retention and archival policies should apply to heartbeats, jobs, and job events.
- Whether PostgreSQL polling remains sufficient at larger scale and when a broker or real delivery integration becomes justified.

These questions are intentionally unanswered by the application repository. No containers, infrastructure definitions, deployment automation, or monitoring server configuration are provided.
