import { Pool } from "pg";
import { logger } from "./logger.js";

export function createDatabasePool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000
  });

  pool.on("error", (error: Error) => {
    logger.error("Unexpected error on an idle PostgreSQL client", {
      error: error.message
    });
  });

  return pool;
}
