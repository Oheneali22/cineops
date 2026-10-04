import type pg from "pg";
import type { Config } from "../config";
import type { Job } from "../db/store";

export interface WorkerJobStore {
  claim(workerId: string, limit: number, leaseMs: number): Promise<Job[]>;
  recoverExpired(maxAttempts: number, retryBaseMs: number): Promise<number>;
  finish(
    job: Job,
    workerId: string,
    outcome: "DELIVERED" | "FAILED",
    reason: string | null,
    maxAttempts: number,
    retryBaseMs: number,
  ): Promise<"DELIVERED" | "FAILED" | "RETRYING" | "LOST_LEASE">;
}

export class PgWorkerJobStore implements WorkerJobStore {
  constructor(private readonly pool: pg.Pool) {}
  async claim(
    workerId: string,
    limit: number,
    leaseMs: number,
  ): Promise<Job[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query<Job & { previous_state: string }>(
        `WITH selected AS (
        SELECT id,state AS previous_state FROM distribution_jobs WHERE state IN ('PENDING','RETRYING') AND available_at <= now()
        ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT $1
      ) UPDATE distribution_jobs j SET state='PROCESSING',attempts=j.attempts+1,claimed_by=$2,
        lease_expires_at=now()+($3::int * interval '1 millisecond'),processing_started_at=now(),updated_at=now()
        FROM selected WHERE j.id=selected.id RETURNING j.*,selected.previous_state`,
        [limit, workerId, leaseMs],
      );
      for (const job of claimed.rows)
        await client.query(
          "INSERT INTO job_events(job_id,from_state,to_state,worker_id,reason) VALUES ($1,$2,$3,$4,$5)",
          [
            job.id,
            job.previous_state,
            "PROCESSING",
            workerId,
            `Attempt ${job.attempts}`,
          ],
        );
      await client.query("COMMIT");
      return claimed.rows;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async recoverExpired(
    maxAttempts: number,
    retryBaseMs: number,
  ): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const expired = await client.query<Job>(
        `SELECT * FROM distribution_jobs WHERE state='PROCESSING' AND lease_expires_at < now() FOR UPDATE SKIP LOCKED LIMIT 100`,
      );
      for (const job of expired.rows) {
        const next = job.attempts >= maxAttempts ? "FAILED" : "RETRYING";
        await client.query(
          `UPDATE distribution_jobs SET state=$2,claimed_by=NULL,lease_expires_at=NULL,available_at=now()+($3::int * interval '1 millisecond'),failure_reason=$4,completed_at=CASE WHEN $2='FAILED' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1`,
          [
            job.id,
            next,
            retryDelay(job.attempts, retryBaseMs),
            "Worker lease expired",
          ],
        );
        await client.query(
          "INSERT INTO job_events(job_id,from_state,to_state,reason,worker_id) VALUES ($1,$2,$3,$4,$5)",
          [job.id, "PROCESSING", next, "Worker lease expired", job.claimed_by],
        );
      }
      await client.query("COMMIT");
      return expired.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async finish(
    job: Job,
    workerId: string,
    outcome: "DELIVERED" | "FAILED",
    reason: string | null,
    maxAttempts: number,
    retryBaseMs: number,
  ): Promise<"DELIVERED" | "FAILED" | "RETRYING" | "LOST_LEASE"> {
    const next =
      outcome === "DELIVERED"
        ? "DELIVERED"
        : job.attempts >= maxAttempts
          ? "FAILED"
          : "RETRYING";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE distribution_jobs SET state=$3,claimed_by=NULL,lease_expires_at=NULL,
        available_at=CASE WHEN $3='RETRYING' THEN now()+($4::int * interval '1 millisecond') ELSE available_at END,
        completed_at=CASE WHEN $3 IN ('DELIVERED','FAILED') THEN now() ELSE NULL END,
        failure_reason=$5,updated_at=now()
        WHERE id=$1 AND state='PROCESSING' AND claimed_by=$2 AND attempts=$6 AND lease_expires_at >= now() RETURNING id`,
        [
          job.id,
          workerId,
          next,
          retryDelay(job.attempts, retryBaseMs),
          reason,
          job.attempts,
        ],
      );
      if (!updated.rowCount) {
        await client.query("ROLLBACK");
        return "LOST_LEASE";
      }
      await client.query(
        "INSERT INTO job_events(job_id,from_state,to_state,reason,worker_id) VALUES ($1,$2,$3,$4,$5)",
        [job.id, "PROCESSING", next, reason, workerId],
      );
      await client.query("COMMIT");
      return next;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export function retryDelay(attempts: number, baseMs: number): number {
  return Math.min(baseMs * 2 ** Math.min(attempts - 1, 10), 3600000);
}
export type ProcessResult = { ok: true } | { ok: false; reason: string };
export async function processDistribution(
  config: Config,
  signal: AbortSignal,
  random = Math.random,
): Promise<ProcessResult> {
  const delay = config.WORKER_PROCESS_MS + config.SIM_EXTRA_DELAY_MS;
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Worker shutting down"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Worker shutting down"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  if (config.NODE_ENV !== "production" && random() < config.SIM_FAILURE_RATE)
    return { ok: false, reason: "Simulated transient distribution failure" };
  return { ok: true };
}
