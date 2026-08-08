import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ws from "ws";
import { Pool, neonConfig } from "@neondatabase/serverless";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required.");

neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString });
const client = await pool.connect();
const migrationDirectory = fileURLToPath(new URL("../db/migrations/", import.meta.url));

try {
  await client.query("SELECT pg_advisory_lock(hashtext('emi_tracker_schema_migrations'))");
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationDirectory))
    .filter((filename) => /^\d+.*\.sql$/.test(filename))
    .sort();

  const appliedResult = await client.query("SELECT filename FROM schema_migrations");
  const applied = new Set(appliedResult.rows.map((row) => row.filename));

  for (const filename of files) {
    if (applied.has(filename)) continue;
    const sqlText = await readFile(path.join(migrationDirectory, filename), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sqlText);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  process.stdout.write("Database migrations are up to date.\n");
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('emi_tracker_schema_migrations'))").catch(() => {});
  client.release();
  await pool.end();
}
