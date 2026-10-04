import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { loadConfig } from "../src/config";
import { migrate } from "../src/db/migrate";
import { Store } from "../src/db/store";
import { PgWorkerJobStore } from "../src/worker/jobs";

const url = process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL job lifecycle, competing claims, heartbeat staleness and retries",
  { skip: !url },
  async () => {
    const pool = new pg.Pool({ connectionString: url!, max: 5 });
    try {
      await migrate(pool);
      const config = loadConfig({
        DATABASE_URL: url!,
        NODE_ENV: "test",
        HEARTBEAT_STALE_SECONDS: "10",
      });
      const store = new Store(pool, config);
      const worker = new PgWorkerJobStore(pool);
      const suffix = Math.random().toString(36).slice(2);
      const theatre = await store.createTheatre({
        name: "Integration Theatre",
        city: "Oslo",
        region: "Europe",
        endpointIdentifier: `integration-${suffix}`,
        operationalStatus: "ACTIVE",
      });
      const release = await store.createRelease({
        title: "Integration Film",
        version: "1",
        contentIdentifier: `integration-${suffix}`,
        releaseDate: "2026-10-15",
        status: "SCHEDULED",
        metadata: {},
      });
      const [job] = await store.schedule(release.id as string, [
        theatre.id as string,
      ]);
      assert.ok(job);
      await assert.rejects(
        store.schedule(release.id as string, [theatre.id as string]),
        /already scheduled/,
      );
      const [a, b] = await Promise.all([
        worker.claim("a", 1, 30000),
        worker.claim("b", 1, 30000),
      ]);
      assert.equal(a.length + b.length, 1);
      const claimed = (a[0] ?? b[0])!;
      const owner = a.length ? "a" : "b";
      assert.equal(
        await worker.finish(claimed, owner, "FAILED", "transient", 2, 100),
        "RETRYING",
      );
      assert.equal((await store.getJob(job.id)).job.state, "RETRYING");
      await pool.query(
        "UPDATE distribution_jobs SET available_at=now() WHERE id=$1",
        [job.id],
      );
      const second = (await worker.claim(owner, 1, 30000))[0]!;
      assert.equal(second.attempts, 2);
      assert.equal(
        await worker.finish(second, owner, "FAILED", "again", 2, 100),
        "FAILED",
      );
      const retried = await store.retryFailed(job.id);
      assert.equal(retried.state, "RETRYING");
      await store.recordHeartbeat({
        theatreId: theatre.id as string,
        timestamp: new Date().toISOString(),
        softwareVersion: "1.0",
        availableStorageGb: 100,
        contentReady: true,
        healthStatus: "HEALTHY",
      });
      let health = await store.theatreHealth();
      assert.equal(
        health.find((h) => h.id === theatre.id)?.readiness,
        "HEALTHY",
      );
      await pool.query(
        `UPDATE theatre_heartbeats SET received_at=now()-interval '20 seconds' WHERE theatre_id=$1`,
        [theatre.id],
      );
      health = await store.theatreHealth();
      assert.equal(health.find((h) => h.id === theatre.id)?.readiness, "STALE");
    } finally {
      await pool.end();
    }
  },
);
