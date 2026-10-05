import { randomUUID } from "node:crypto";
import Fastify, {
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  authMiddleware,
  createDatabasePool,
  createKafkaProducer,
  loadConfig,
  logger
} from "@ai-grader/shared";
import { z } from "zod";
import {
  completeSubmission,
  UploadCompletionConflict
} from "./completeSubmission.js";
import { runOutboxPublisher } from "./outboxPublisher.js";

const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;
const UPLOAD_URL_TTL_SECONDS = 15 * 60;

const uploadRuntimeSchema = z.object({
  MINIO_ROOT_USER: z.string().min(1),
  MINIO_ROOT_PASSWORD: z.string().min(1),
  UPLOAD_PORT: z.coerce.number().int().min(1).max(65535).default(3001)
});

const presignBodySchema = z.object({
  contentType: z.literal("application/pdf")
});

const intentParamsSchema = z.object({
  id: z.string().uuid()
});

class UploadRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "UploadRequestError";
  }
}

const config = loadConfig();
const runtime = uploadRuntimeSchema.parse(process.env);
const database = createDatabasePool(config.DATABASE_URL);
const kafkaProducer = createKafkaProducer(config.KAFKA_BROKERS, "ai-grader-upload");
const publisherAbortController = new AbortController();
const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: runtime.MINIO_ROOT_USER,
    secretAccessKey: runtime.MINIO_ROOT_PASSWORD
  }
});
let publisherTask: Promise<void> | undefined;

function getUserId(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = request.user?.userId;

  if (!userId) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }

  return userId;
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return candidate.name === "NotFound" || candidate.$metadata?.httpStatusCode === 404;
}

async function handleUploadError(
  error: unknown,
  reply: FastifyReply,
  message: string
): Promise<unknown> {
  if (error instanceof UploadRequestError) {
    reply.code(error.statusCode);
    return { error: error.message };
  }

  logger.error(message, {
    error: error instanceof Error ? error.message : "Unknown error"
  });
  reply.code(500);
  return { error: "Internal server error" };
}

const app = Fastify({ logger: false });

app.get("/health", async () => ({ status: "ok" }));

app.post(
  "/uploads/presign",
  { preHandler: [authMiddleware] },
  async (request, reply) => {
    const userId = getUserId(request, reply);
    if (!userId) {
      return;
    }

    const parsedBody = presignBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      reply.code(400);
      return {
        error: "Invalid request body",
        details: parsedBody.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      };
    }

    const intentId = randomUUID();
    const objectKey = `submissions/${userId}/${randomUUID()}.pdf`;
    const expiresAt = new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000);

    try {
      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: config.S3_BUCKET,
          Key: objectKey,
          ContentType: parsedBody.data.contentType
        }),
        { expiresIn: UPLOAD_URL_TTL_SECONDS }
      );

      await database.query(
        `INSERT INTO upload_intents
          (id, user_id, object_key, content_type, max_size_bytes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          intentId,
          userId,
          objectKey,
          parsedBody.data.contentType,
          MAX_UPLOAD_SIZE_BYTES,
          expiresAt
        ]
      );

      return {
        uploadIntentId: intentId,
        objectKey,
        uploadUrl,
        expiresAt: expiresAt.toISOString(),
        maxFileSizeBytes: MAX_UPLOAD_SIZE_BYTES,
        requiredHeaders: {
          "Content-Type": parsedBody.data.contentType
        }
      };
    } catch (error) {
      return handleUploadError(error, reply, "Failed to create a presigned upload URL");
    }
  }
);

app.post(
  "/uploads/:id/complete",
  { preHandler: [authMiddleware] },
  async (request, reply) => {
    const userId = getUserId(request, reply);
    if (!userId) {
      return;
    }

    const parsedParams = intentParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      reply.code(400);
      return { error: "Invalid upload intent ID" };
    }

    try {
      const intentResult = await database.query<{
        id: string;
        object_key: string;
        max_size_bytes: string;
        expires_at: Date;
        completed_at: Date | null;
      }>(
        `SELECT id, object_key, max_size_bytes, expires_at, completed_at
         FROM upload_intents
         WHERE id = $1 AND user_id = $2`,
        [parsedParams.data.id, userId]
      );
      const intent = intentResult.rows[0];

      if (!intent) {
        throw new UploadRequestError(404, "Upload intent not found");
      }
      if (intent.completed_at) {
        throw new UploadRequestError(409, "Upload intent has already been completed");
      }
      if (new Date(intent.expires_at).getTime() <= Date.now()) {
        throw new UploadRequestError(410, "Upload intent has expired");
      }

      let objectSize: number | undefined;
      try {
        const metadata = await s3.send(
          new HeadObjectCommand({
            Bucket: config.S3_BUCKET,
            Key: intent.object_key
          })
        );
        objectSize = metadata.ContentLength;
        if (metadata.ContentType !== "application/pdf") {
          throw new UploadRequestError(400, "Uploaded object must have content type application/pdf");
        }
      } catch (error) {
        if (error instanceof UploadRequestError) {
          throw error;
        }
        if (isNotFoundError(error)) {
          throw new UploadRequestError(400, "Uploaded object was not found in storage");
        }
        throw error;
      }

      if (
        typeof objectSize !== "number" ||
        objectSize <= 0 ||
        objectSize > Number(intent.max_size_bytes)
      ) {
        throw new UploadRequestError(400, "Uploaded file is empty or exceeds the size limit");
      }

      let headerBytes: Uint8Array;
      try {
        const response = await s3.send(
          new GetObjectCommand({
            Bucket: config.S3_BUCKET,
            Key: intent.object_key,
            Range: "bytes=0-4"
          })
        );
        if (!response.Body) {
          throw new UploadRequestError(400, "Uploaded object is empty");
        }
        headerBytes = await response.Body.transformToByteArray();
      } catch (error) {
        if (error instanceof UploadRequestError) {
          throw error;
        }
        if (isNotFoundError(error)) {
          throw new UploadRequestError(400, "Uploaded object was not found in storage");
        }
        throw error;
      }

      if (Buffer.from(headerBytes).toString("ascii") !== "%PDF-") {
        throw new UploadRequestError(400, "Uploaded file does not have a valid PDF signature");
      }

      const completed = await completeSubmission({
        pool: database,
        uploadIntentId: intent.id,
        userId
      });

      return {
        uploadIntentId: intent.id,
        submissionId: completed.submissionId,
        status: "pending"
      };
    } catch (error) {
      if (error instanceof UploadCompletionConflict) {
        throw new UploadRequestError(error.statusCode, error.message);
      }
      return handleUploadError(error, reply, "Failed to complete upload");
    }
  }
);

try {
  await database.query("SELECT 1");
  publisherTask = runOutboxPublisher(database, kafkaProducer, publisherAbortController.signal)
    .catch((error: unknown) => {
      logger.error("Outbox publisher stopped unexpectedly", {
        error: error instanceof Error ? error.message : "Unknown error"
      });
      process.exitCode = 1;
    });
  await app.listen({ port: runtime.UPLOAD_PORT, host: "0.0.0.0" });
  logger.info("Upload service listening", { port: runtime.UPLOAD_PORT });
} catch (error) {
  logger.error("Upload service startup failed", {
    error: error instanceof Error ? error.message : "Unknown error"
  });
  await database.end();
  s3.destroy();
  process.exitCode = 1;
}

async function shutdown(): Promise<void> {
  publisherAbortController.abort();
  await app.close();
  await publisherTask;
  await database.end();
  s3.destroy();
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
