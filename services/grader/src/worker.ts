import {
  createDatabasePool,
  createKafkaConsumer,
  loadConfig,
  loadGraderServiceConfig,
  loadGradingConfig,
  loadStorageConfig,
  logger,
  submissionCompletedEventSchema,
  TOPICS
} from "@ai-grader/shared";
import { S3Client } from "@aws-sdk/client-s3";
import { processSubmission } from "./processSubmission.js";

const config = loadConfig();
const gradingConfig = loadGradingConfig();
const storageConfig = loadStorageConfig();
const graderConfig = loadGraderServiceConfig();
const database = createDatabasePool(config.DATABASE_URL);
const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: storageConfig.MINIO_ROOT_USER,
    secretAccessKey: storageConfig.MINIO_ROOT_PASSWORD
  }
});
const consumer = createKafkaConsumer(
  config.KAFKA_BROKERS,
  graderConfig.GRADER_GROUP_ID,
  "ai-grader-grader"
);
let consumerConnected = false;

async function start(): Promise<void> {
  await database.query("SELECT 1");
  await consumer.connect();
  consumerConnected = true;
  await consumer.subscribe({
    topic: TOPICS.submissionCompleted,
    fromBeginning: true
  });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const serialized = message.value?.toString();
      if (!serialized) {
        logger.error("Ignoring an empty submission event");
        return;
      }

      let candidate: unknown;
      try {
        candidate = JSON.parse(serialized);
      } catch {
        logger.error("Ignoring a submission event containing invalid JSON");
        return;
      }

      const parsed = submissionCompletedEventSchema.safeParse(candidate);
      if (!parsed.success) {
        logger.error("Ignoring a submission event with an invalid schema", {
          details: parsed.error.issues.map((issue) => issue.message).join("; ")
        });
        return;
      }

      await processSubmission(database, parsed.data, {
        s3,
        bucket: config.S3_BUCKET,
        model: gradingConfig.GEMINI_MODEL,
        rubric: graderConfig.GRADING_RUBRIC
      });
    }
  });
  logger.info("Grader consumer is listening", {
    topic: TOPICS.submissionCompleted,
    groupId: graderConfig.GRADER_GROUP_ID
  });
}

async function shutdown(): Promise<void> {
  if (consumerConnected) {
    await consumer.disconnect();
  }
  s3.destroy();
  await database.end();
}

process.once("SIGINT", () => {
  void shutdown().catch((error: unknown) => {
    logger.error("Grader shutdown failed", {
      error: error instanceof Error ? error.message : "Unknown error"
    });
    process.exitCode = 1;
  });
});
process.once("SIGTERM", () => {
  void shutdown().catch((error: unknown) => {
    logger.error("Grader shutdown failed", {
      error: error instanceof Error ? error.message : "Unknown error"
    });
    process.exitCode = 1;
  });
});

try {
  await start();
} catch (error) {
  logger.error("Grader startup failed", {
    error: error instanceof Error ? error.message : "Unknown error"
  });
  await shutdown();
  process.exitCode = 1;
}
