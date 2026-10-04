# CineOps

CineOps is an original, fictional cinema operations application. Operations staff register theatres and content releases, schedule distribution jobs, and inspect theatre readiness. An API stores durable work in PostgreSQL; a separate worker claims and completes it. The simulated delivery step is intentionally replaceable and performs **no real content transfer**.

No real company's data, APIs, branding, or internal design are used. This repository contains application code only.

## Components and flow

1. A client creates a `SCHEDULED` or `ACTIVE` release and registers `ACTIVE` theatres.
2. `POST /v1/distribution-jobs` inserts one job per destination in a transaction. Duplicate release/theatre pairs fail with 409.
3. Worker processes claim due `PENDING` or `RETRYING` jobs, simulate delivery, and persist an event for every state change.
4. Theatre endpoints send heartbeats. The latest received heartbeat determines readiness; theatres with no heartbeat, stale heartbeats, or unhealthy reports are visible through `/v1/theatre-health`.

See [architecture](docs/architecture.md), [runbook](docs/runbook.md), and [developer handoff](docs/developer-handoff.md).

## Local requirements

- Ubuntu Linux with Node.js 20 or later and npm.
- PostgreSQL 14 or later, reachable over TCP or a local socket via a PostgreSQL URL. The application does not install or package PostgreSQL.
- A PostgreSQL role allowed to create tables and the `pgcrypto` extension in its database. A dedicated development database is recommended.

Example native setup after PostgreSQL is installed and running:

```sh
sudo -u postgres psql -c "CREATE ROLE cineops LOGIN PASSWORD 'choose-a-local-password';"
sudo -u postgres psql -c "CREATE DATABASE cineops OWNER cineops;"
cd ~/projects/cineops
cp .env.example .env
# Edit .env: set DATABASE_URL and API_KEY to local values.
npm ci
set -a; . ./.env; set +a
npm run db:migrate
npm run db:seed
npm run dev:api
```

In a second shell, load the same `.env` and run `npm run dev:worker`. The app does not automatically load `.env`; the shell or process manager must supply environment variables. For built code, run `npm run build`, then `npm run start:api` and `npm run start:worker`. Run `npm test`, `npm run lint`, and `npm run format:check` for local checks. `npm run format` rewrites source formatting.

The integration test requires an **isolated** PostgreSQL database: set `TEST_DATABASE_URL` to its URL and run `npm run test:integration`. The test creates schema objects and test records. Without this variable it is skipped; it never silently claims a database pass.

## API

JSON responses use `{ "data": ... }` for domain data and `{ "error": { "code", "message", "requestId" } }` for errors. Validation errors also include safe field details. All `/v1/` routes require `x-api-key` when `API_KEY` is configured; `API_KEY` is mandatory in production. Health and metrics routes are unauthenticated so they can be probed, and must be protected at the network boundary as appropriate.

| Method     | Path                                 | Purpose                                     |
| ---------- | ------------------------------------ | ------------------------------------------- |
| GET        | `/health/live`                       | Process liveness, independent of PostgreSQL |
| GET        | `/health/ready`                      | Database readiness                          |
| GET        | `/metrics`                           | Prometheus text exposition                  |
| POST, GET  | `/v1/theatres`                       | Create and list theatres                    |
| GET, PATCH | `/v1/theatres/:id`                   | Inspect/update theatre                      |
| POST, GET  | `/v1/releases`                       | Create and list releases                    |
| GET        | `/v1/releases/:id`                   | Inspect release                             |
| POST, GET  | `/v1/distribution-jobs`              | Schedule/list jobs                          |
| GET        | `/v1/distribution-jobs/failed`       | List failed jobs                            |
| GET        | `/v1/distribution-jobs/:id`          | Job and transition history                  |
| POST       | `/v1/distribution-jobs/:id/retry`    | Manually retry a terminal failed job        |
| POST       | `/v1/heartbeats`                     | Report endpoint health                      |
| GET        | `/v1/theatre-health?readiness=STALE` | Latest health and optional readiness filter |
| GET        | `/v1/operations/summary`             | Job and theatre counts                      |

Example:

```sh
curl -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"name":"Aurora Screen One","city":"Toronto","region":"North America","endpointIdentifier":"aurora-tor-001"}' \
  http://localhost:3000/v1/theatres
```

The seed script uses the same fictional endpoint ID, so choose another ID if seed data was loaded. To schedule a job, create a release with `status: "SCHEDULED"`, then POST `{"releaseId":"<uuid>","theatreIds":["<uuid>"]}` to `/v1/distribution-jobs`. Heartbeats accept `theatreId`, RFC 3339 `timestamp`, `softwareVersion`, numeric `availableStorageGb`, boolean `contentReady`, and `healthStatus` (`HEALTHY`, `DEGRADED`, `UNHEALTHY`). Reports more than 24 hours old or five minutes in the future are rejected.

## Configuration

All settings are environment variables; see [.env.example](.env.example). `DATABASE_URL` is required. `API_KEY` must contain at least 16 characters and is required in production. Main knobs: `PORT`, `DATABASE_POOL_MAX`, `LOG_LEVEL`, `WORKER_ID`, `WORKER_METRICS_PORT`, `WORKER_POLL_MS`, `WORKER_BATCH_SIZE`, `WORKER_CONCURRENCY`, `WORKER_LEASE_MS`, `WORKER_PROCESS_MS`, `JOB_MAX_ATTEMPTS`, `JOB_RETRY_BASE_MS`, and `HEARTBEAT_STALE_SECONDS`. Invalid configuration fails startup with a field-specific error. Give each worker process a distinct `WORKER_ID` and, when sharing a network namespace, a distinct metrics port.

Development-only simulation variables are `SIM_FAILURE_RATE` (0–1), `SIM_EXTRA_DELAY_MS`, `SIM_DB_DELAY_MS`, and `SIM_UNHEALTHY_DEPENDENCY`. They default to safe values and any active simulation causes production startup to fail. Simulated failures affect delivery attempts; slow database operations affect API store operations; dependency simulation makes readiness return 503. Startup logs show active simulation values. Keep worker processing plus simulated delay below the lease duration unless testing lease recovery.

## Observability and troubleshooting

Logs are structured JSON with request and correlation IDs, state transitions, startup and shutdown messages. `x-request-id` and `x-correlation-id` are returned to clients. API `/metrics` reports HTTP counts/duration and durable job counts by state. Worker `/metrics` on `WORKER_METRICS_PORT` reports worker outcomes, processing duration, and active jobs. `GET /health/live` answers 200 while the API process runs. `GET /health/ready` returns 503 when PostgreSQL cannot be queried or development dependency failure is active. See the [runbook](docs/runbook.md) for diagnosis steps.

## Database and migration behavior

`npm run db:migrate` applies ordered SQL files exactly once using an advisory lock and a transaction per migration. Run it before starting new application code. The database holds theatres, releases, distribution jobs, job transition history, heartbeats, and migration history. All domain state is persistent. API and worker are stateless apart from in-memory metrics and in-flight processing. No local file storage is required.
# cineops
