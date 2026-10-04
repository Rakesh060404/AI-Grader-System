import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { createDatabasePool } from "./database.js";
import { loadDatabaseUrl } from "./config.js";
import { logger } from "./logger.js";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));
const migrationFilenamePattern = /^\d+_[a-z0-9_-]+\.sql$/i;
const migrationLockName = "ai-grader:migrations";

async function applyMigrations(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDirectory))
    .filter((filename) => migrationFilenamePattern.test(filename))
    .sort();
  const appliedResult = await client.query<{ name: string }>(
    "SELECT name FROM schema_migrations"
  );
  const appliedMigrations = new Set(appliedResult.rows.map((row) => row.name));

  for (const filename of files) {
    if (appliedMigrations.has(filename)) {
      continue;
    }

    const sql = await readFile(new URL(`../../../migrations/${filename}`, import.meta.url), "utf8");
    await client.query("BEGIN");

    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [filename]);
      await client.query("COMMIT");
      logger.info("Applied database migration", { migration: filename });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Migration ${filename} failed and its transaction could not be rolled back`
        );
      }

      throw error;
    }
  }

  logger.info("Database migrations are up to date", { count: files.length });
}

async function main(): Promise<void> {
  const pool = createDatabasePool(loadDatabaseUrl());
  let client: PoolClient | undefined;
  let lockAcquired = false;

  try {
    const connection = await pool.connect();
    client = connection;
    await connection.query("SELECT pg_advisory_lock(hashtext($1))", [migrationLockName]);
    lockAcquired = true;
    await applyMigrations(connection);
  } finally {
    try {
      if (client && lockAcquired) {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [migrationLockName]);
      }
    } finally {
      client?.release();
      await pool.end();
    }
  }
}

await main();
