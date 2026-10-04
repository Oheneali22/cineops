import pg from "pg";
import type { Config } from "../config";

export function makePool(config: Config): pg.Pool {
  return new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
  });
}

export async function dbDelay(config: Config): Promise<void> {
  if (config.NODE_ENV !== "production" && config.SIM_DB_DELAY_MS > 0)
    await new Promise((resolve) => setTimeout(resolve, config.SIM_DB_DELAY_MS));
}
