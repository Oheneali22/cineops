import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { makePool } from "./pool";
import { loadConfig } from "../config";
import type pg from "pg";

export async function migrate(
  pool: pg.Pool,
  directory = join(process.cwd(), "migrations"),
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(72816421)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of (await readdir(directory))
      .filter((v) => /^\d+_.*\.sql$/.test(v))
      .sort()) {
      const applied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE name = $1",
        [name],
      );
      if (applied.rowCount) continue;
      await client.query("BEGIN");
      try {
        await client.query(await readFile(join(directory, name), "utf8"));
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [
          name,
        ]);
        await client.query("COMMIT");
        process.stdout.write(`Applied ${name}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(72816421)");
    client.release();
  }
}

if (require.main === module) {
  const pool = makePool(loadConfig());
  migrate(pool)
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
