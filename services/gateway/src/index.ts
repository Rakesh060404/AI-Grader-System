import { randomUUID } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import {
  authMiddleware,
  createAccessToken,
  createDatabasePool,
  createRefreshToken,
  loadConfig,
  logger,
  verifyRefreshToken
} from "@ai-grader/shared";

const config = loadConfig();
const database = createDatabasePool(config.DATABASE_URL);

const registerSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8)
});

const refreshSchema = z.object({
  refreshToken: z.string().min(20)
});

const gatewayRuntimeSchema = z.object({
  GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  UPLOAD_SERVICE_URL: z.string().url(),
  RESULTS_SERVICE_URL: z.string().url(),
  PROXY_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000)
});
const gatewayRuntime = gatewayRuntimeSchema.parse(process.env);

const app = Fastify({
  logger: false
});

async function proxyRequest(
  baseUrl: string,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const headers = new Headers();
  const authorization = request.headers.authorization;
  const accept = request.headers.accept;
  if (authorization) {
    headers.set("authorization", authorization);
  }
  if (typeof accept === "string") {
    headers.set("accept", accept);
  }

  const method = request.method.toUpperCase();
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(gatewayRuntime.PROXY_TIMEOUT_MS)
  };
  if (method !== "GET" && method !== "HEAD" && request.body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(request.body);
  }

  try {
    const upstream = await fetch(new URL(request.url, baseUrl), init);
    const contentType = upstream.headers.get("content-type");
    if (contentType) {
      reply.header("content-type", contentType);
    }
    reply.code(upstream.status);
    return reply.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    logger.error("Gateway upstream request failed", {
      upstream: baseUrl,
      error: error instanceof Error ? error.message : "Unknown error"
    });
    reply.code(502);
    return { error: "Upstream service unavailable" };
  }
}

app.get("/health", async () => ({
  status: "ok"
}));

app.post("/auth/register", async (request, reply) => {
  const body = registerSchema.parse(request.body);
  const email = body.email.toLowerCase();

  const existing = await database.query<{ id: string }>(
    "SELECT id FROM users WHERE email = $1",
    [email]
  );

  if (existing.rowCount && existing.rowCount > 0) {
    reply.code(409);
    return { error: "User already exists" };
  }

  const passwordHash = await bcrypt.hash(body.password, 10);
  const userId = randomUUID();

  await database.query(
    "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)",
    [userId, email, passwordHash]
  );

  const user = { id: userId, email };
  const authUser = { userId, email };
  const accessToken = await createAccessToken(authUser);
  const refreshToken = await createRefreshToken(authUser);

  logger.info("User registered", { userId });

  return {
    user,
    accessToken,
    refreshToken
  };
});

app.post("/auth/login", async (request, reply) => {
  const body = registerSchema.parse(request.body);
  const email = body.email.toLowerCase();

  const result = await database.query<{ id: string; email: string; password_hash: string }>(
    "SELECT id, email, password_hash FROM users WHERE email = $1",
    [email]
  );

  const user = result.rows[0];

  if (!user) {
    reply.code(401);
    return { error: "Invalid credentials" };
  }

  const matches = await bcrypt.compare(body.password, user.password_hash);

  if (!matches) {
    reply.code(401);
    return { error: "Invalid credentials" };
  }

  const accessToken = await createAccessToken({ userId: user.id, email: user.email });
  const refreshToken = await createRefreshToken({ userId: user.id, email: user.email });

  logger.info("User logged in", { userId: user.id });

  return {
    user: { id: user.id, email: user.email },
    accessToken,
    refreshToken
  };
});

app.post("/auth/refresh", async (request, reply) => {
  const body = refreshSchema.parse(request.body);

  let payload;
  try {
    payload = await verifyRefreshToken(body.refreshToken);
  } catch {
    reply.code(401);
    return { error: "Invalid refresh token" };
  }

  const userId = typeof payload.sub === "string" ? payload.sub : null;
  if (!userId) {
    reply.code(401);
    return { error: "Invalid refresh token" };
  }

  const result = await database.query<{ id: string; email: string }>(
    "SELECT id, email FROM users WHERE id = $1",
    [userId]
  );
  const user = result.rows[0];
  if (!user) {
    reply.code(401);
    return { error: "Invalid refresh token" };
  }

  const accessToken = await createAccessToken({ userId: user.id, email: user.email });
  const refreshToken = await createRefreshToken({ userId: user.id, email: user.email });
  return { accessToken, refreshToken };
});

app.get("/auth/me", { preHandler: [authMiddleware] }, async (request, reply) => {
  const user = request.user;

  if (!user) {
    reply.code(401);
    return { error: "Unauthorized" };
  }

  const result = await database.query<{ id: string; email: string }>(
    "SELECT id, email FROM users WHERE id = $1",
    [user.userId]
  );

  const row = result.rows[0];

  if (!row) {
    reply.code(404);
    return { error: "User not found" };
  }

  return {
    user: { id: row.id, email: row.email }
  };
});

app.all(
  "/uploads/*",
  { preHandler: [authMiddleware] },
  async (request, reply) =>
    proxyRequest(gatewayRuntime.UPLOAD_SERVICE_URL, request, reply)
);
app.all(
  "/results",
  { preHandler: [authMiddleware] },
  async (request, reply) =>
    proxyRequest(gatewayRuntime.RESULTS_SERVICE_URL, request, reply)
);
app.all(
  "/results/*",
  { preHandler: [authMiddleware] },
  async (request, reply) =>
    proxyRequest(gatewayRuntime.RESULTS_SERVICE_URL, request, reply)
);

try {
  await database.query<{ database: string }>("SELECT current_database() AS database");
  logger.info("Gateway connected to PostgreSQL", {
    database: (await database.query<{ database: string }>("SELECT current_database() AS database")).rows[0]?.database ?? "unknown"
  });

  await app.listen({ port: gatewayRuntime.GATEWAY_PORT, host: "0.0.0.0" });
  logger.info("Gateway listening", { port: gatewayRuntime.GATEWAY_PORT });
} catch (error) {
  logger.error("Gateway startup failed", {
    error: error instanceof Error ? error.message : "Unknown error"
  });
  process.exitCode = 1;
} finally {
  process.on("SIGINT", async () => {
    await app.close();
    await database.end();
    process.exit(0);
  });
}
