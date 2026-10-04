import { makePool } from "./pool";
import { loadConfig } from "../config";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.NODE_ENV === "production")
    throw new Error("Seed data is forbidden in production");
  const pool = makePool(config);
  try {
    for (const [name, city, region, endpoint] of [
      ["Aurora Screen One", "Toronto", "North America", "aurora-tor-001"],
      ["Harbor Cinema", "London", "Europe", "harbor-lon-001"],
      ["Meridian Theatre", "Singapore", "Asia Pacific", "meridian-sin-001"],
      [
        "Sierra Picture House",
        "Mexico City",
        "Latin America",
        "sierra-mex-001",
      ],
    ])
      await pool.query(
        "INSERT INTO theatres(name,city,region,endpoint_identifier) VALUES ($1,$2,$3,$4) ON CONFLICT (endpoint_identifier) DO NOTHING",
        [name, city, region, endpoint],
      );
    for (const [title, version, contentId, date] of [
      ["Night Meridian", "1.0", "fictional-night-meridian", "2026-10-15"],
      ["The Glass Atlas", "2.1", "fictional-glass-atlas", "2026-11-04"],
    ])
      await pool.query(
        "INSERT INTO releases(title,version,content_identifier,release_date,status,metadata) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (content_identifier,version) DO NOTHING",
        [
          title,
          version,
          contentId,
          date,
          "SCHEDULED",
          JSON.stringify({ genre: "fictional" }),
        ],
      );
    process.stdout.write("Seed data ready\n");
  } finally {
    await pool.end();
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
