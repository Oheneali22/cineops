import { loadConfig } from "../config";
import { makePool } from "../db/pool";
import { Store } from "../db/store";
import { buildApp } from "./app";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = makePool(config);
  const store = new Store(pool, config);
  const app = buildApp(config, store);
  await store.ping();
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  app.log.info(
    {
      port: config.PORT,
      simulation: {
        dbDelayMs: config.SIM_DB_DELAY_MS,
        unhealthyDependency: config.SIM_UNHEALTHY_DEPENDENCY,
      },
    },
    "API started",
  );
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      app.log.info({ signal }, "API shutdown requested");
      void app
        .close()
        .then(() => pool.end())
        .then(() => app.log.info("API stopped"))
        .catch((error: unknown) => {
          app.log.error({ err: error }, "API shutdown failed");
          process.exitCode = 1;
        });
    });
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
