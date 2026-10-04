import type pg from "pg";
import { AppError, conflict, notFound } from "../errors";
import type { Config } from "../config";
import { dbDelay } from "./pool";

export type JobState =
  "PENDING" | "PROCESSING" | "DELIVERED" | "FAILED" | "RETRYING";
export interface Job {
  id: string;
  release_id: string;
  theatre_id: string;
  state: JobState;
  attempts: number;
  claimed_by: string | null;
  lease_expires_at: Date | null;
  created_at: Date;
  processing_started_at: Date | null;
  completed_at: Date | null;
  failure_reason: string | null;
}
export interface Heartbeat {
  theatreId: string;
  timestamp: string;
  softwareVersion: string;
  availableStorageGb: number;
  contentReady: boolean;
  healthStatus: "HEALTHY" | "DEGRADED" | "UNHEALTHY";
}

export class Store {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: Config,
  ) {}
  private async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<T>> {
    await dbDelay(this.config);
    return this.pool.query<T>(sql, params);
  }
  async ping(): Promise<void> {
    await this.query("SELECT 1");
  }
  async createTheatre(input: {
    name: string;
    city: string;
    region: string;
    endpointIdentifier: string;
    operationalStatus: string;
  }): Promise<pg.QueryResultRow> {
    try {
      return (
        await this.query(
          "INSERT INTO theatres(name,city,region,endpoint_identifier,operational_status) VALUES ($1,$2,$3,$4,$5) RETURNING *",
          [
            input.name,
            input.city,
            input.region,
            input.endpointIdentifier,
            input.operationalStatus,
          ],
        )
      ).rows[0]!;
    } catch (error) {
      if (isUnique(error)) throw conflict("Endpoint identifier already exists");
      throw error;
    }
  }
  async listTheatres(): Promise<pg.QueryResultRow[]> {
    return (await this.query("SELECT * FROM theatres ORDER BY name")).rows;
  }
  async getTheatre(id: string): Promise<pg.QueryResultRow> {
    const row = (await this.query("SELECT * FROM theatres WHERE id=$1", [id]))
      .rows[0];
    if (!row) throw notFound("Theatre");
    return row;
  }
  async updateTheatre(
    id: string,
    input: {
      name?: string;
      city?: string;
      region?: string;
      operationalStatus?: string;
    },
  ): Promise<pg.QueryResultRow> {
    const row = (
      await this.query(
        `UPDATE theatres SET name=COALESCE($2,name),city=COALESCE($3,city),region=COALESCE($4,region),operational_status=COALESCE($5,operational_status),updated_at=now() WHERE id=$1 RETURNING *`,
        [id, input.name, input.city, input.region, input.operationalStatus],
      )
    ).rows[0];
    if (!row) throw notFound("Theatre");
    return row;
  }
  async createRelease(input: {
    title: string;
    version: string;
    contentIdentifier: string;
    releaseDate: string;
    status: string;
    metadata: Record<string, unknown>;
  }): Promise<pg.QueryResultRow> {
    try {
      return (
        await this.query(
          "INSERT INTO releases(title,version,content_identifier,release_date,status,metadata) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            input.title,
            input.version,
            input.contentIdentifier,
            input.releaseDate,
            input.status,
            JSON.stringify(input.metadata),
          ],
        )
      ).rows[0]!;
    } catch (error) {
      if (isUnique(error))
        throw conflict("Content identifier and version already exist");
      throw error;
    }
  }
  async listReleases(): Promise<pg.QueryResultRow[]> {
    return (await this.query("SELECT * FROM releases ORDER BY created_at DESC"))
      .rows;
  }
  async getRelease(id: string): Promise<pg.QueryResultRow> {
    const row = (await this.query("SELECT * FROM releases WHERE id=$1", [id]))
      .rows[0];
    if (!row) throw notFound("Release");
    return row;
  }
  async schedule(releaseId: string, theatreIds: string[]): Promise<Job[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const release = await client.query(
        "SELECT status FROM releases WHERE id=$1 FOR SHARE",
        [releaseId],
      );
      if (!release.rowCount) throw notFound("Release");
      if (!["SCHEDULED", "ACTIVE"].includes(release.rows[0].status as string))
        throw conflict("Release must be SCHEDULED or ACTIVE");
      const theatres = await client.query(
        "SELECT id FROM theatres WHERE id=ANY($1::uuid[]) AND operational_status=$2",
        [theatreIds, "ACTIVE"],
      );
      if (theatres.rowCount !== theatreIds.length)
        throw new AppError(
          422,
          "INELIGIBLE_THEATRE",
          "Every destination theatre must exist and be ACTIVE",
        );
      const jobs: Job[] = [];
      for (const theatreId of theatreIds) {
        const result = await client.query<Job>(
          "INSERT INTO distribution_jobs(release_id,theatre_id) VALUES ($1,$2) RETURNING *",
          [releaseId, theatreId],
        );
        const job = result.rows[0]!;
        jobs.push(job);
        await client.query(
          "INSERT INTO job_events(job_id,to_state,reason) VALUES ($1,$2,$3)",
          [job.id, "PENDING", "Scheduled by API"],
        );
      }
      await client.query("COMMIT");
      return jobs;
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUnique(error))
        throw conflict("Distribution already scheduled for a destination");
      throw error;
    } finally {
      client.release();
    }
  }
  async listJobs(state?: JobState, limit = 100, offset = 0): Promise<Job[]> {
    return (
      await this.query<Job>(
        "SELECT * FROM distribution_jobs WHERE ($1::text IS NULL OR state=$1) ORDER BY created_at DESC LIMIT $2 OFFSET $3",
        [state ?? null, limit, offset],
      )
    ).rows;
  }
  async getJob(
    id: string,
  ): Promise<{ job: Job; history: pg.QueryResultRow[] }> {
    const job = (
      await this.query<Job>("SELECT * FROM distribution_jobs WHERE id=$1", [id])
    ).rows[0];
    if (!job) throw notFound("Job");
    const history = (
      await this.query("SELECT * FROM job_events WHERE job_id=$1 ORDER BY id", [
        id,
      ])
    ).rows;
    return { job, history };
  }
  async retryFailed(id: string): Promise<Job> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<Job>(
        `UPDATE distribution_jobs SET state='RETRYING',attempts=0,available_at=now(),failure_reason=NULL,completed_at=NULL,updated_at=now() WHERE id=$1 AND state='FAILED' RETURNING *`,
        [id],
      );
      if (!result.rowCount) {
        const exists = await client.query(
          "SELECT 1 FROM distribution_jobs WHERE id=$1",
          [id],
        );
        throw exists.rowCount
          ? conflict("Only FAILED jobs can be manually retried")
          : notFound("Job");
      }
      await client.query(
        "INSERT INTO job_events(job_id,from_state,to_state,reason) VALUES ($1,$2,$3,$4)",
        [id, "FAILED", "RETRYING", "Manual retry requested"],
      );
      await client.query("COMMIT");
      return result.rows[0]!;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async recordHeartbeat(input: Heartbeat): Promise<pg.QueryResultRow> {
    await this.getTheatre(input.theatreId);
    return (
      await this.query(
        "INSERT INTO theatre_heartbeats(theatre_id,reported_at,software_version,available_storage_gb,content_ready,health_status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
        [
          input.theatreId,
          input.timestamp,
          input.softwareVersion,
          input.availableStorageGb,
          input.contentReady,
          input.healthStatus,
        ],
      )
    ).rows[0]!;
  }
  async theatreHealth(): Promise<pg.QueryResultRow[]> {
    return (
      await this.query(
        `SELECT t.id,t.name,t.city,t.region,t.operational_status,h.reported_at,h.received_at,h.software_version,h.available_storage_gb,h.content_ready,h.health_status,
      CASE WHEN h.id IS NULL THEN 'NEVER_REPORTED' WHEN h.received_at < now() - ($1::int * interval '1 second') THEN 'STALE' WHEN h.health_status='HEALTHY' AND h.content_ready AND t.operational_status='ACTIVE' THEN 'HEALTHY' ELSE 'UNHEALTHY' END AS readiness
      FROM theatres t LEFT JOIN LATERAL (SELECT * FROM theatre_heartbeats WHERE theatre_id=t.id ORDER BY received_at DESC,id DESC LIMIT 1) h ON true ORDER BY t.name`,
        [this.config.HEARTBEAT_STALE_SECONDS],
      )
    ).rows;
  }
  async summary(): Promise<pg.QueryResultRow> {
    const [jobs, health] = await Promise.all([
      this.query(
        "SELECT state,count(*)::int AS count FROM distribution_jobs GROUP BY state",
      ),
      this.theatreHealth(),
    ]);
    return {
      jobs: Object.fromEntries(jobs.rows.map((r) => [r.state, r.count])),
      theatres: Object.fromEntries(
        ["HEALTHY", "UNHEALTHY", "STALE", "NEVER_REPORTED"].map((s) => [
          s,
          health.filter((h) => h.readiness === s).length,
        ]),
      ),
    };
  }
  async jobStateCounts(): Promise<Record<string, number>> {
    return Object.fromEntries(
      (
        await this.query(
          "SELECT state,count(*)::int AS count FROM distribution_jobs GROUP BY state",
        )
      ).rows.map((r) => [String(r.state), Number(r.count)]),
    );
  }
}

function isUnique(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}
