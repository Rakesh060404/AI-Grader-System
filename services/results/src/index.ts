import Fastify from "fastify";
import {
  authMiddleware,
  createDatabasePool,
  loadConfig,
  logger,
  type SubmissionStatus
} from "@ai-grader/shared";

interface ResultRow {
  submission_id: string;
  status: SubmissionStatus;
  failure_reason: string | null;
  score: number | null;
  feedback: string[] | null;
  created_at: Date;
}

interface ResultParams {
  id: string;
}

const config = loadConfig();
const portText = process.env.RESULTS_PORT ?? "3003";
const port = Number(portText);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Invalid RESULTS_PORT: expected an integer between 1 and 65535");
}

const database = createDatabasePool(config.DATABASE_URL);
const app = Fastify({ logger: false });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

app.get("/health", async () => ({ status: "ok" }));

app.get(
  "/results",
  { preHandler: [authMiddleware] },
  async (request, reply) => {
    const userId = request.user?.userId;
    if (!userId) {
      reply.code(401);
      return { error: "Unauthorized" };
    }

    const result = await database.query<ResultRow>(
      `SELECT s.id AS submission_id, s.status, s.failure_reason,
              g.score::float8 AS score, g.feedback, s.created_at
       FROM submissions s
       LEFT JOIN grades g ON g.submission_id = s.id
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC`,
      [userId]
    );

    return {
      results: result.rows.map((row) => ({
        submissionId: row.submission_id,
        status: row.status,
        failureReason: row.failure_reason,
        score: row.score,
        feedback: row.feedback,
        createdAt: row.created_at.toISOString()
      }))
    };
  }
);

app.get<{ Params: ResultParams }>(
  "/results/:id",
  { preHandler: [authMiddleware] },
  async (request, reply) => {
    const userId = request.user?.userId;
    if (!userId) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    if (!uuidPattern.test(request.params.id)) {
      reply.code(400);
      return { error: "Invalid submission ID" };
    }

    const result = await database.query<ResultRow>(
      `SELECT s.id AS submission_id, s.status, s.failure_reason,
              g.score::float8 AS score, g.feedback, s.created_at
       FROM submissions s
       LEFT JOIN grades g ON g.submission_id = s.id
       WHERE s.id = $1 AND s.user_id = $2`,
      [request.params.id, userId]
    );
    const row = result.rows[0];
    if (!row) {
      reply.code(404);
      return { error: "Result not found" };
    }

    return {
      submissionId: row.submission_id,
      status: row.status,
      failureReason: row.failure_reason,
      score: row.score,
      feedback: row.feedback,
      createdAt: row.created_at.toISOString()
    };
  }
);

try {
  await database.query("SELECT 1");
  await app.listen({ port, host: "0.0.0.0" });
  logger.info("Results service listening", { port });
} catch (error) {
  logger.error("Results service startup failed", {
    error: error instanceof Error ? error.message : "Unknown error"
  });
  await database.end();
  process.exitCode = 1;
}

async function shutdown(): Promise<void> {
  await app.close();
  await database.end();
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
