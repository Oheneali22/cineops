import { z } from "zod";

const boolean = z
  .enum(["true", "false"])
  .transform((value) => value === "true");
const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z
      .string()
      .url()
      .refine(
        (v) => v.startsWith("postgres://") || v.startsWith("postgresql://"),
        "must be a PostgreSQL URL",
      ),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    API_KEY: z.string().min(16).optional(),
    WORKER_ID: z.string().min(1).max(100).default("worker-local"),
    WORKER_METRICS_PORT: z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .default(3001),
    WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
    WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(5),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(2),
    WORKER_LEASE_MS: z.coerce.number().int().min(5000).default(30000),
    WORKER_PROCESS_MS: z.coerce.number().int().min(0).default(500),
    JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(3),
    JOB_RETRY_BASE_MS: z.coerce.number().int().min(100).default(2000),
    HEARTBEAT_STALE_SECONDS: z.coerce.number().int().min(10).default(300),
    SIM_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
    SIM_EXTRA_DELAY_MS: z.coerce.number().int().min(0).default(0),
    SIM_DB_DELAY_MS: z.coerce.number().int().min(0).default(0),
    SIM_UNHEALTHY_DEPENDENCY: boolean.default("false"),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === "production" && !value.API_KEY)
      context.addIssue({
        code: "custom",
        path: ["API_KEY"],
        message: "required in production",
      });
    if (
      value.NODE_ENV === "production" &&
      (value.SIM_FAILURE_RATE > 0 ||
        value.SIM_EXTRA_DELAY_MS > 0 ||
        value.SIM_DB_DELAY_MS > 0 ||
        value.SIM_UNHEALTHY_DEPENDENCY)
    ) {
      context.addIssue({
        code: "custom",
        path: ["NODE_ENV"],
        message: "failure simulation is forbidden in production",
      });
    }
  });

export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid configuration: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  return result.data;
}
