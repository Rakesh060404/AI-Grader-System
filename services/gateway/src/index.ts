import { createDatabasePool, loadConfig, logger } from "@ai-grader/shared";

const config = loadConfig();
const database = createDatabasePool(config.DATABASE_URL);

try {
  const result = await database.query<{ database: string }>(
    "SELECT current_database() AS database"
  );
  logger.info("Gateway startup connected to PostgreSQL", {
    database: result.rows[0]?.database ?? "unknown"
  });
} finally {
  await database.end();
}
