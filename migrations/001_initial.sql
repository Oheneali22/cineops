CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE theatres (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  city text NOT NULL CHECK (length(trim(city)) > 0),
  region text NOT NULL CHECK (length(trim(region)) > 0),
  operational_status text NOT NULL DEFAULT 'ACTIVE' CHECK (operational_status IN ('ACTIVE','MAINTENANCE','INACTIVE')),
  endpoint_identifier text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(trim(title)) > 0),
  version text NOT NULL,
  content_identifier text NOT NULL,
  release_date date NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SCHEDULED','ACTIVE','ARCHIVED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_identifier, version)
);

CREATE TABLE distribution_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL REFERENCES releases(id),
  theatre_id uuid NOT NULL REFERENCES theatres(id),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','PROCESSING','DELIVERED','FAILED','RETRYING')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text,
  lease_expires_at timestamptz,
  processing_started_at timestamptz,
  completed_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (release_id, theatre_id),
  CHECK ((state = 'PROCESSING') = (claimed_by IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX distribution_claim_idx ON distribution_jobs (available_at, created_at) WHERE state IN ('PENDING','RETRYING');
CREATE INDEX distribution_state_idx ON distribution_jobs (state, updated_at);
CREATE INDEX distribution_lease_idx ON distribution_jobs (lease_expires_at) WHERE state = 'PROCESSING';
CREATE INDEX distribution_theatre_idx ON distribution_jobs (theatre_id, created_at DESC);

CREATE TABLE job_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES distribution_jobs(id) ON DELETE CASCADE,
  from_state text,
  to_state text NOT NULL,
  reason text,
  worker_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_events_job_idx ON job_events (job_id, id);

CREATE TABLE theatre_heartbeats (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  theatre_id uuid NOT NULL REFERENCES theatres(id),
  reported_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  software_version text NOT NULL,
  available_storage_gb numeric(12,2) NOT NULL CHECK (available_storage_gb >= 0),
  content_ready boolean NOT NULL,
  health_status text NOT NULL CHECK (health_status IN ('HEALTHY','DEGRADED','UNHEALTHY'))
);
CREATE INDEX heartbeats_latest_idx ON theatre_heartbeats (theatre_id, received_at DESC, id DESC);
